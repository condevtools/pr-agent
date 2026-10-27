# 📋 实施计划：GitHub Actions CI/CD 全量补齐

## 现状诊断

**当前状态：项目 GitHub Actions 覆盖率为 0%。**

`.github/` 目录仅包含模板文件（Issue Templates + PR Template），不存在 `.github/workflows/` 目录。
项目是一个 pnpm monorepo（Backend NestJS + Frontend Next.js 16），拥有 39 个测试文件、Docker 构建、
Turbo 编排、TypeScript 严格模式等完整的本地开发基础设施，但没有任何自动化 CI/CD 流水线。

**前置问题（脚本规范化）**：
- Backend 缺少 `lint` 脚本
- Frontend 缺少 `test` 和 `check`（typecheck）脚本
- 需要在实施 CI 前先补齐这些脚本入口

---

## 任务类型
- [x] 后端 (→ Codex)
- [x] 前端 (→ Gemini)
- [x] 全栈 (→ 并行)

---

## 技术方案

采用 **Surface-Oriented Granular Workflows**（面向交付面的细粒度工作流），
为 Backend 和 Frontend 分别配置独立 CI job，结合 monorepo 路径过滤和缓存优化。

核心原则：
1. 第三方 Actions 使用 SHA 锁定，不用 tag
2. 使用 `concurrency` 取消 PR 上的过时运行
3. pnpm store 缓存 + Turbo 缓存
4. 路径过滤避免无关触发
5. 单一 Node 22 版本（与 Dockerfile/nixpacks 一致）

---

## 实施步骤

### Phase 0: 脚本规范化（前置依赖）

| 步骤 | 操作 | 预期产物 |
|------|------|----------|
| 0.1 | Backend `package.json` 添加 `lint` 脚本（引入 ESLint 或使用 tsc 替代） | `pnpm --filter backend lint` 可执行 |
| 0.2 | Frontend `package.json` 添加 `check` 脚本（`tsc --noEmit`） | `pnpm --filter frontend check` 可执行 |
| 0.3 | 根 `package.json` 确认 `lint:all`、`test:backend`、`build:all` 均可运行 | 所有 turbo task 入口就绪 |

### Phase 1: P0 — CI 流水线 (`ci.yml`)

**文件**: `.github/workflows/ci.yml`

**触发条件**: `push` (main) + `pull_request` (main)

**Job 结构**:

```
ci.yml
├── job: backend-ci
│   ├── paths: backend/**, Dockerfile, package.json, pnpm-lock.yaml, pnpm-workspace.yaml, turbo.json
│   ├── step: pnpm install (with cache)
│   ├── step: pnpm --filter backend check (typecheck)
│   ├── step: pnpm --filter backend lint
│   ├── step: pnpm --filter backend test
│   └── step: pnpm --filter backend build
│
├── job: frontend-ci
│   ├── paths: frontend/**, nixpacks.toml, package.json, pnpm-lock.yaml, pnpm-workspace.yaml, turbo.json
│   ├── step: pnpm install (with cache)
│   ├── step: pnpm --filter frontend check (typecheck)
│   ├── step: pnpm --filter frontend lint
│   └── step: pnpm --filter frontend build
│
└── concurrency: cancel-in-progress for PRs
```

**伪代码**:

```yaml
name: CI
on:
  push:
    branches: [main]
  pull_request:
    branches: [main]

concurrency:
  group: ci-${{ github.ref }}
  cancel-in-progress: ${{ github.event_name == 'pull_request' }}

jobs:
  backend-ci:
    runs-on: ubuntu-latest
    # paths-filter or dorny/paths-filter to skip if no backend changes
    steps:
      - uses: actions/checkout@<sha>
      - uses: pnpm/action-setup@<sha>  # pnpm 10.10.0
      - uses: actions/setup-node@<sha>
        with:
          node-version: 22
          cache: pnpm
      - run: pnpm install --frozen-lockfile
      - run: pnpm --filter backend check
      - run: pnpm --filter backend lint
      - run: pnpm --filter backend test
      - run: pnpm --filter backend build

  frontend-ci:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@<sha>
      - uses: pnpm/action-setup@<sha>
      - uses: actions/setup-node@<sha>
        with:
          node-version: 22
          cache: pnpm
      - run: pnpm install --frozen-lockfile
      - run: pnpm --filter frontend check
      - run: pnpm --filter frontend lint
      - run: pnpm --filter frontend build
```

### Phase 2: P0 — 安全扫描 (`security.yml`)

**文件**: `.github/workflows/security.yml`

**触发条件**: `push` (main) + `pull_request` (main) + `schedule` (weekly)

**Job 结构**:

```
security.yml
├── job: dependency-review
│   └── PR only: github/codeql-action/dependency-review
│
├── job: codeql-analysis
│   └── CodeQL for JavaScript/TypeScript
│
├── job: docker-scan
│   ├── Build Docker image
│   └── Trivy scan (image + Dockerfile)
│
└── job: secret-scan (optional)
    └── trufflesecurity/trufflehog or gitleaks
```

### Phase 3: P0 — Docker 镜像构建与发布 (`docker-image.yml`)

**文件**: `.github/workflows/docker-image.yml`

**触发条件**:
- `pull_request`: 仅构建验证（不推送）
- `push` to main: 构建 + 推送 GHCR
- `tags` (v*): 构建 + 推送 + 生成 SBOM/provenance

**Job 结构**:

```
docker-image.yml
├── job: build-and-push
│   ├── paths: backend/**, Dockerfile, docker-compose.yml
│   ├── step: docker/setup-buildx-action
│   ├── step: docker/login-action (GHCR)
│   ├── step: docker/build-push-action
│   │   ├── PR: push=false, load=true
│   │   ├── main: push=true, tags=latest
│   │   └── tag: push=true, tags=version+latest
│   └── step: aquasecurity/trivy-action (scan built image)
```

### Phase 4: P1 — Release 工作流 (`release.yml`)

**文件**: `.github/workflows/release.yml`

**触发条件**: `push` tags (v*)

**Job 结构**:

```
release.yml
├── job: create-release
│   ├── step: Generate changelog from commits
│   ├── step: Create GitHub Release
│   └── step: Attach Docker image digest + SBOM
```

### Phase 5: P1 — 部署工作流

#### 5a. Backend 部署 (`deploy-backend.yml`)

**触发条件**: `workflow_dispatch` + 可选自动（main push after CI passes）

```
deploy-backend.yml
├── job: deploy-staging
│   ├── environment: staging
│   ├── step: Deploy container (K8s/PaaS)
│   └── step: Smoke test /health, /github/health, /metrics
│
└── job: deploy-production (manual approval)
    ├── environment: production
    ├── step: Deploy container
    └── step: Smoke test
```

#### 5b. Frontend 部署 (`deploy-frontend.yml`)

**触发条件**: `push` to main (frontend/** changed) or `workflow_dispatch`

```
deploy-frontend.yml
├── job: deploy
│   ├── step: Trigger Nixpacks/Render/Coolify deploy
│   └── step: Smoke test landing page
```

### Phase 6: P1 — PR 治理 (`pr-governance.yml`)

**文件**: `.github/workflows/pr-governance.yml`

**触发条件**: `pull_request` (opened, edited)

**检查项**:
- PR 模板必填字段是否已填写（Summary、Test Plan、Related Issue）
- 风险评估和回滚方案是否存在
- 可选：自动打标签（基于路径）

### Phase 7: P1 — 测试覆盖率 (`coverage.yml`)

**文件**: `.github/workflows/coverage.yml`

**触发条件**: `push` (main)

```
coverage.yml
├── job: coverage
│   ├── step: pnpm --filter backend test:coverage
│   ├── step: Upload coverage report
│   └── step: (future) Enforce coverage threshold
```

### Phase 8: P2 — 增强工作流

| 工作流 | 文件 | 说明 |
|--------|------|------|
| Frontend 预览部署 | `preview-frontend.yml` | PR 创建 preview URL |
| 夜间回归测试 | `nightly-regression.yml` | 定时对 staging 执行冒烟测试 |
| 文档合规检查 | `docs-contract.yml` | 验证文档引用的脚本/端点/文件真实存在 |
| Lighthouse CI | `lighthouse.yml` | 前端性能基线检测（Three.js/GSAP） |
| 依赖自动更新 | Dependabot 配置 | `.github/dependabot.yml` 自动依赖更新 PR |

---

## 关键文件

| 文件 | 操作 | 说明 |
|------|------|------|
| `backend/package.json` | 修改 | 添加 `lint` 脚本 |
| `frontend/package.json` | 修改 | 添加 `check` 脚本（tsc --noEmit） |
| `.github/workflows/ci.yml` | 新建 | CI 流水线（backend + frontend jobs） |
| `.github/workflows/security.yml` | 新建 | 安全扫描（CodeQL + Dependency Review + Trivy） |
| `.github/workflows/docker-image.yml` | 新建 | Docker 镜像构建、扫描、发布到 GHCR |
| `.github/workflows/release.yml` | 新建 | Tag 触发的 Release 创建 |
| `.github/workflows/deploy-backend.yml` | 新建 | 后端部署（staging + production） |
| `.github/workflows/deploy-frontend.yml` | 新建 | 前端部署 |
| `.github/workflows/pr-governance.yml` | 新建 | PR 模板合规检查 |
| `.github/workflows/coverage.yml` | 新建 | 测试覆盖率上报 |
| `.github/dependabot.yml` | 新建 | 依赖自动更新配置 |

---

## 风险与缓解

| 风险 | 缓解措施 |
|------|----------|
| Backend 无 lint 脚本，CI lint 步骤会失败 | Phase 0 先补齐脚本入口 |
| Frontend 无 typecheck 脚本 | Phase 0 先补齐 `check` 脚本 |
| 第三方 Action 被 supply chain 攻击 | 所有 Action 使用 SHA 锁定，不用 tag |
| PR 路径过滤导致 required check 缺失 | 使用 `paths-ignore` 或 `dorny/paths-filter` + 稳定 job name |
| Docker build 因缺少 secrets 在 CI 中失败 | 仅构建验证，不运行需要 env 的步骤 |
| ops checklist 引用 `scripts/ops/functional-regression.sh`（不存在） | 先创建该脚本，或在 nightly-regression 中重新实现 |
| 部署工作流需要云平台凭据 | 使用 GitHub OIDC，避免长期 secrets |

---

## 优先级路线图

```
Week 1 (P0):
  ├── Phase 0: 脚本规范化
  ├── Phase 1: ci.yml
  ├── Phase 2: security.yml
  └── Phase 3: docker-image.yml

Week 2 (P1):
  ├── Phase 4: release.yml
  ├── Phase 5: deploy-backend.yml + deploy-frontend.yml
  ├── Phase 6: pr-governance.yml
  └── Phase 7: coverage.yml

Week 3+ (P2):
  ├── Phase 8: preview-frontend.yml
  ├── Phase 8: nightly-regression.yml
  ├── Phase 8: lighthouse.yml
  └── Phase 8: dependabot.yml
```

---

## Monorepo 优化策略

1. **路径过滤**：Backend job 仅在 `backend/**`、`Dockerfile`、`docker-compose.yml`、根配置变更时触发
2. **pnpm 缓存**：使用 `pnpm/action-setup` + `actions/setup-node` 的 cache 参数
3. **Turbo 缓存**：考虑 Vercel Remote Cache 加速 CI
4. **并发控制**：PR 使用 `concurrency` + `cancel-in-progress: true`
5. **Node 版本**：锁定 Node 22（与 Dockerfile 和 nixpacks 一致），不做矩阵测试

---

## SESSION_ID（供 /ccg:execute 使用）
- CODEX_SESSION: 019cefb6-8cd5-7d23-a0d9-148746bd4e17
- GEMINI_SESSION: 9cb055d3-4a52-4726-a80a-dec7534d0ceb
