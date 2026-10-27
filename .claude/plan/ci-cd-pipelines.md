# CI/CD Pipelines Implementation Plan

## Task Summary

为 pr-agent pnpm monorepo 项目实现完整 CI/CD 方案，包含：
1. **项目自身的 CI/CD** — GitHub Actions + GitLab CI 验证、构建、部署
2. **给其他项目使用的 Action/Template** — 让外部项目在自己的 CI 里直接运行 pr-agent AI 代码审查

## Project Context

- **Monorepo**: pnpm 10.10.0 + Turbo (backend + frontend)
- **Backend**: NestJS 11, TypeScript 5.7.2, Node.js 22 Alpine
- **Frontend**: Next.js 16.1.6, React 19, Tailwind CSS 4
- **Tests**: Backend only (37 files, 178 cases, Node.js built-in test runner)
- **Docker**: Multi-stage Dockerfile (backend only)
- **Frontend Deploy**: nixpacks.toml
- **Current CI/CD**: None (only issue/PR templates exist)
- **Per-repo Config**: `.pr-agent.yml` 已支持（策略/命令开关配置）

## Task Type

- [x] Backend (CI/CD infrastructure + CLI entry point)
- [x] Frontend (CI validation)
- [x] DevOps (Docker, deployment, Action publishing)

## Technical Approach

**Strategy**: Hybrid path-filtered CI + separate CD + CLI-driven Action

- Path-based change detection avoids unnecessary job execution
- Backend and frontend pipelines run independently
- Docker image build uses immutable SHA tags with promotion model
- Staging auto-deploys from `main`; production requires manual approval on tags
- CLI 入口点 (`backend/src/cli.ts`) 直接调用核心 review 函数，无需启动 HTTP 服务器
- GitHub Action 和 GitLab CI Template 均基于同一 Docker 镜像 + CLI 入口

---

## Part A: 项目自身的 CI/CD

### Step 1: Create GitHub Actions CI Workflow

**File**: `.github/workflows/ci.yml`

**Description**: PR 和 push 到 main 时触发的验证流水线

**Key Design Decisions**:
- Use `dorny/paths-filter` for monorepo change detection
- Sequential backend pipeline: check → test → build → docker-smoke
- Sequential frontend pipeline: lint → build
- `pull_request` (not `pull_request_target`) to block fork PR secret access
- All third-party actions pinned by commit SHA
- Concurrency cancellation for PRs (avoid stale runs)
- pnpm store cache via `actions/setup-node` cache

**Pseudo-code**:

```yaml
name: CI

on:
  pull_request:
  push:
    branches: [main]

permissions: {}

concurrency:
  group: ci-${{ github.workflow }}-${{ github.event.pull_request.number || github.ref }}
  cancel-in-progress: ${{ github.event_name == 'pull_request' }}

env:
  NODE_VERSION: "22"
  PNPM_VERSION: "10.10.0"
  TURBO_TELEMETRY_DISABLED: "1"

jobs:
  # Job 1: Detect changed paths
  changes:
    name: changes / detect-scope
    runs-on: ubuntu-latest
    permissions:
      contents: read
      pull-requests: read
    outputs:
      backend: ${{ steps.filter.outputs.backend }}
      frontend: ${{ steps.filter.outputs.frontend }}
      docker: ${{ steps.filter.outputs.docker }}
    steps:
      - uses: actions/checkout@<SHA> (fetch-depth: 0, persist-credentials: false)
      - uses: dorny/paths-filter@<SHA>
        filters:
          backend: [backend/**, package.json, pnpm-lock.yaml, pnpm-workspace.yaml, turbo.json, Dockerfile, .github/workflows/ci.yml]
          frontend: [frontend/**, package.json, pnpm-lock.yaml, pnpm-workspace.yaml, turbo.json, nixpacks.toml, .github/workflows/ci.yml]
          docker: [backend/**, package.json, pnpm-lock.yaml, pnpm-workspace.yaml, Dockerfile]

  # Job 2: Backend type check
  backend_check:
    name: backend / check
    needs: changes
    if: needs.changes.outputs.backend == 'true'
    steps: [checkout, setup-node+pnpm, corepack enable, pnpm install --frozen-lockfile, pnpm --filter backend check]

  # Job 3: Backend tests (depends on check)
  backend_test:
    name: backend / test
    needs: backend_check
    steps: [checkout, setup-node+pnpm, corepack enable, pnpm install --frozen-lockfile, pnpm --filter backend test]

  # Job 4: Backend build (depends on test)
  backend_build:
    name: backend / build
    needs: backend_test
    steps: [checkout, setup-node+pnpm, corepack enable, pnpm install --frozen-lockfile, pnpm --filter backend build]

  # Job 5: Docker smoke build (PR only, depends on build)
  backend_docker_smoke:
    name: backend / docker-smoke
    needs: [changes, backend_build]
    if: github.event_name == 'pull_request' && needs.changes.outputs.docker == 'true'
    steps:
      - checkout
      - docker/setup-buildx-action
      - docker/build-push-action (push: false, cache-from: type=gha, cache-to: type=gha,mode=max)

  # Job 6: Frontend lint (parallel with backend)
  frontend_lint:
    name: frontend / lint
    needs: changes
    if: needs.changes.outputs.frontend == 'true'
    steps: [checkout, setup-node+pnpm, corepack enable, pnpm install --frozen-lockfile, pnpm --filter frontend lint]

  # Job 7: Frontend build (depends on lint)
  frontend_build:
    name: frontend / build
    needs: frontend_lint
    steps: [checkout, setup-node+pnpm, corepack enable, pnpm install --frozen-lockfile, pnpm --filter frontend build]
```

### Step 2: Create GitHub Actions Release Workflow

**File**: `.github/workflows/release.yml`

**Description**: push 到 main 或创建 tag 时构建 Docker 镜像并部署

**Key Design Decisions**:
- Immutable `sha-<commit>` tag + branch/semver aliases
- BuildKit with GHA cache for fast builds
- GHCR as container registry
- Protected `staging` and `production` environments
- `docker/metadata-action` for automatic tag generation

**Pseudo-code**:

```yaml
name: Release

on:
  push:
    branches: [main]
    tags: [v*.*.*]
    paths: [backend/**, package.json, pnpm-lock.yaml, pnpm-workspace.yaml, Dockerfile]

permissions: {}

env:
  IMAGE_NAME: ghcr.io/${{ github.repository_owner }}/pr-agent-backend

jobs:
  # Job 1: Build and push to GHCR
  build_and_publish:
    name: release / build-and-push
    permissions: { contents: read, packages: write }
    steps:
      - checkout
      - docker/setup-buildx-action
      - docker/login-action (registry: ghcr.io)
      - docker/metadata-action (tags: sha, branch, semver)
      - docker/build-push-action (push: true, cache-from/to: type=gha)

  # Job 2: Auto-deploy to staging (main only)
  deploy_staging:
    name: deploy / staging
    needs: build_and_publish
    if: github.ref == 'refs/heads/main'
    environment: staging
    concurrency: { group: deploy-staging, cancel-in-progress: true }
    steps:
      - echo "Deploy ${IMAGE_REF} to staging"
      - # Replace with actual deploy command

  # Job 3: Manual deploy to production (tags only)
  deploy_production:
    name: deploy / production
    needs: build_and_publish
    if: startsWith(github.ref, 'refs/tags/v')
    environment: production
    concurrency: { group: deploy-production, cancel-in-progress: false }
    steps:
      - echo "Promote ${IMAGE_REF} to production"
      - # Replace with actual deploy command
```

### Step 3: Create GitLab CI Pipeline

**File**: `.gitlab-ci.yml`

**Description**: GitLab 等效流水线，覆盖验证、构建、安全扫描、发布、部署

**Key Design Decisions**:
- YAML anchors for DRY change detection rules
- `pnpm fetch` in install stage, `--offline` in downstream jobs
- Kaniko for rootless Docker builds (no Docker-in-Docker)
- GitLab Security templates (SAST + Dependency Scanning)
- `resource_group` for deploy concurrency control
- `workflow:rules` to prevent unnecessary pipeline creation

**Pseudo-code**:

```yaml
stages: [install, validate, build, test, security, release, deploy]

include:
  - template: Jobs/SAST.gitlab-ci.yml
  - template: Jobs/Dependency-Scanning.gitlab-ci.yml

variables:
  PNPM_STORE_DIR: "$CI_PROJECT_DIR/.pnpm-store"
  IMAGE_NAME: "$CI_REGISTRY_IMAGE/backend"

# YAML anchors for path-based filtering
.workspace_changes: &workspace_changes [backend/**, frontend/**, package.json, pnpm-lock.yaml, ...]
.backend_ci_changes: &backend_ci_changes [backend/**, package.json, pnpm-lock.yaml, ...]
.frontend_ci_changes: &frontend_ci_changes [frontend/**, package.json, pnpm-lock.yaml, ...]

workflow:
  rules:
    - if: '$CI_COMMIT_TAG =~ /^v\d+\.\d+\.\d+$/'
    - if: '$CI_PIPELINE_SOURCE == "merge_request_event"' changes: *workspace_changes
    - if: '$CI_COMMIT_BRANCH == $CI_DEFAULT_BRANCH' changes: *workspace_changes
    - when: never

default:
  image: node:22-alpine
  interruptible: true
  cache: { key: { files: [pnpm-lock.yaml] }, paths: [.pnpm-store/], policy: pull }

# Stage: install
workspace_install:
  stage: install
  cache: { policy: pull-push }
  script: [pnpm fetch --frozen-lockfile]

# Stage: validate
backend_check:
  stage: validate
  needs: [workspace_install]
  rules: changes: *backend_ci_changes
  script: [pnpm install --frozen-lockfile --offline, pnpm --filter backend check]

backend_test:
  stage: validate
  needs: [backend_check]
  rules: changes: *backend_ci_changes
  script: [pnpm install --frozen-lockfile --offline, pnpm --filter backend test]

frontend_lint:
  stage: validate
  needs: [workspace_install]
  rules: changes: *frontend_ci_changes
  script: [pnpm install --frozen-lockfile --offline, pnpm --filter frontend lint]

# Stage: build
backend_build:
  stage: build
  needs: [backend_test]
  script: [pnpm install --frozen-lockfile --offline, pnpm --filter backend build]

frontend_build:
  stage: build
  needs: [frontend_lint]
  script: [pnpm install --frozen-lockfile --offline, pnpm --filter frontend build]

# Stage: security
semgrep-sast: (from template, changes: *security_changes)
gemnasium-dependency_scanning: (from template, excluded: data,secrets,backend/dist,frontend/.next)

# Stage: release
docker_release:
  stage: release
  image: gcr.io/kaniko-project/executor:v1.23.2-debug
  needs: [backend_build]
  rules: main branch or semver tags
  script:
    - /kaniko/executor --context $CI_PROJECT_DIR --dockerfile Dockerfile
      --destination $IMAGE_NAME:sha-$CI_COMMIT_SHA
      --cache=true --cache-repo $CI_REGISTRY_IMAGE/cache

# Stage: deploy
deploy_staging:
  stage: deploy
  needs: [docker_release]
  resource_group: staging
  environment: { name: staging }
  rules: main branch only

deploy_production:
  stage: deploy
  needs: [docker_release]
  resource_group: production
  when: manual
  environment: { name: production }
  rules: semver tags only
```

---

## Part B: 给其他项目使用的 Action/Template

### Step 4: Add CLI Entry Point (Backend Code Change)

**File**: `backend/src/cli.ts` (新建)

**Description**: CLI 入口点，让 pr-agent 在 CI 环境中直接运行 review，无需 HTTP 服务器

**Architecture Decision**: 采用 Approach B（CLI 直调），而非 Approach A（启动服务器自触发）
- 直接调用 `runGitHubCiReview()` / `runGitLabCiReview()`，跳过 HTTP 层
- 从 CI 环境变量读取上下文（`GITHUB_EVENT_PATH`, `CI_MERGE_REQUEST_IID` 等）
- 无需 webhook 签名验证

**Key Design**:

```
Usage:
  node /app/backend/dist/cli.js github-action   # GitHub Actions 模式
  node /app/backend/dist/cli.js gitlab-ci        # GitLab CI 模式
```

**GitHub Action 模式流程**:
1. 从 `GITHUB_EVENT_PATH` 读取 PR 事件 payload
2. 从 `GITHUB_TOKEN` 或 `PR_AGENT_GITHUB_TOKEN` 创建 Octokit
3. 从 payload 解析 owner/repo/pullNumber/trigger
4. 调用 `runGitHubCiReview()` — 新增的封装函数

**GitLab CI 模式流程**:
1. 从 `CI_MERGE_REQUEST_IID`, `CI_PROJECT_ID` 等 GitLab CI 预设变量读取 MR 上下文
2. 从 `GITLAB_TOKEN` 创建 GitLab API 客户端
3. 调用 `runGitLabCiReview()` — 新增的封装函数

**Environment Variables**:

| Variable | Source | Description |
|----------|--------|-------------|
| `GITHUB_TOKEN` | GitHub Actions 自动提供 | GitHub API 认证 |
| `GITHUB_EVENT_PATH` | GitHub Actions 自动提供 | PR 事件 JSON payload 路径 |
| `PR_AGENT_MODE` | 用户配置 | `comment` 或 `report` |
| `PR_AGENT_CUSTOM_RULES` | 用户配置 | 自定义规则（换行分隔） |
| `PR_AGENT_FAIL_ON_ERROR` | 用户配置 | 审查失败是否阻断 CI（默认 true） |
| `AI_PROVIDER` | 用户配置 | `openai` / `anthropic` / `gemini` |
| `OPENAI_API_KEY` 等 | 用户 Secrets | AI 提供商 API Key |
| `CI_MERGE_REQUEST_IID` | GitLab CI 自动提供 | MR 编号 |
| `GITLAB_TOKEN` | 用户配置 | GitLab API Token |

### Step 5: Add `runGitHubCiReview()` Function

**File**: `backend/src/integrations/github/github-review.ts` (修改)

**Description**: 新增 CI 专用入口函数，封装 Octokit 创建 + 策略加载 + review 调用

**Key Logic**:
1. 用 token 创建 Octokit 实例（通过 `createRestBackedOctokit()`）
2. 构建 `GitHubReviewContext` 对象
3. 获取 PR 元数据 (`octokit.pulls.get()`)
4. 加载目标仓库的 `.pr-agent.yml` 策略配置
5. 根据策略判断是否跳过 review（`onOpened`/`onEdited`/`onSynchronize` 开关）
6. 合并 CLI custom rules + .pr-agent.yml custom rules
7. 调用现有的 `runGitHubReview()` 执行审查

**Interface**:
```typescript
export interface GitHubCiReviewRunParams {
  owner: string;
  repo: string;
  pullNumber: number;
  token: string;
  logger: LoggerLike;
  apiBaseUrl?: string;      // GitHub Enterprise 支持
  mode?: ReviewMode;
  trigger?: ReviewTrigger;
  customRules?: string[];
  throwOnError?: boolean;
}

export async function runGitHubCiReview(params: GitHubCiReviewRunParams): Promise<{ ok: boolean; message: string }>
```

**Export**: 在 `backend/src/integrations/github/index.ts` 导出

### Step 6: Add `runGitLabCiReview()` Function

**File**: `backend/src/integrations/gitlab/gitlab-review.ts` (修改)

**Description**: 新增 GitLab CI 专用入口函数

**Key Logic**:
1. 从 CI 环境变量构建 GitLab webhook payload 对象
2. 加载目标仓库的 `.pr-agent.yml` 策略配置
3. 根据策略判断是否跳过
4. 调用现有的 `runGitLabReview()` 执行审查

**Interface**:
```typescript
export interface GitLabCiReviewRunParams {
  token: string;
  logger: LoggerLike;
  baseUrl?: string;
  projectId: number;
  projectName: string;
  projectPath: string;
  projectWebUrl: string;
  mergeRequestIid: number;
  title: string;
  description?: string;
  sourceBranch: string;
  targetBranch: string;
  author?: string;
  headSha?: string;
  mode?: ReviewMode;
  trigger?: ReviewTrigger;
  customRules?: string[];
  throwOnError?: boolean;
}

export async function runGitLabCiReview(params: GitLabCiReviewRunParams): Promise<{ ok: boolean; message: string }>
```

**Export**: 在 `backend/src/integrations/gitlab/index.ts` 导出

### Step 7: Create GitHub Action Definition

**File**: `action.yml` (项目根目录)

**Description**: Docker-based GitHub Action，其他项目通过 `uses: your-org/pr-agent@v1` 调用

**Pseudo-code**:

```yaml
name: "PR Agent Review"
description: "AI-powered code review for pull requests"

inputs:
  github-token:
    description: "GitHub token (defaults to GITHUB_TOKEN)"
    required: false
    default: ""
  mode:
    description: "Review mode: comment | report (defaults to .pr-agent.yml or comment)"
    required: false
    default: ""
  custom-rules:
    description: "Extra review rules (one per line)"
    required: false
    default: ""
  fail-on-error:
    description: "Fail the step if review errors occur"
    required: false
    default: "true"
  api-url:
    description: "GitHub API URL (for GitHub Enterprise)"
    required: false
    default: ""

runs:
  using: "docker"
  image: "Dockerfile"
  entrypoint: "node"
  args: ["/app/backend/dist/cli.js", "github-action"]
  env:
    PR_AGENT_GITHUB_TOKEN: ${{ inputs.github-token }}
    PR_AGENT_MODE: ${{ inputs.mode }}
    PR_AGENT_CUSTOM_RULES: ${{ inputs.custom-rules }}
    PR_AGENT_FAIL_ON_ERROR: ${{ inputs.fail-on-error }}
    PR_AGENT_GITHUB_API_URL: ${{ inputs.api-url }}

branding:
  color: "blue"
  icon: "git-pull-request"
```

**用户使用示例**:

```yaml
# 在用户仓库的 .github/workflows/review.yml
name: AI Code Review
on:
  pull_request:
    types: [opened, synchronize]

permissions:
  contents: read
  pull-requests: write

jobs:
  review:
    runs-on: ubuntu-latest
    steps:
      - uses: your-org/pr-agent@v1
        with:
          github-token: ${{ secrets.GITHUB_TOKEN }}
        env:
          AI_PROVIDER: openai
          OPENAI_API_KEY: ${{ secrets.OPENAI_API_KEY }}
```

### Step 8: Create GitLab CI Template

**File**: `templates/gitlab-ci-review.yml` (新建)

**Description**: GitLab CI 模板，其他项目通过 `include: remote:` 引入

**Pseudo-code**:

```yaml
# Usage in user's .gitlab-ci.yml:
#
# include:
#   - remote: 'https://raw.githubusercontent.com/your-org/pr-agent/main/templates/gitlab-ci-review.yml'
#
# ai_code_review:
#   extends: .pr_agent_review
#   variables:
#     GITLAB_TOKEN: $GITLAB_ACCESS_TOKEN
#     AI_PROVIDER: openai
#     OPENAI_API_KEY: $OPENAI_API_KEY

.pr_agent_review:
  stage: test
  image:
    name: ghcr.io/your-org/pr-agent:latest
    entrypoint: [""]
  variables:
    GIT_STRATEGY: none
    GITLAB_BASE_URL: $CI_SERVER_URL
    PR_AGENT_MODE: ""
    PR_AGENT_CUSTOM_RULES: ""
    PR_AGENT_TRIGGER: pr-synchronize
    PR_AGENT_FAIL_ON_ERROR: "true"
  rules:
    - if: '$CI_PIPELINE_SOURCE == "merge_request_event"'
    - when: never
  script:
    - node /app/backend/dist/cli.js gitlab-ci
```

**用户使用示例**:

```yaml
# 在用户仓库的 .gitlab-ci.yml
include:
  - remote: 'https://raw.githubusercontent.com/your-org/pr-agent/main/templates/gitlab-ci-review.yml'

ai_code_review:
  extends: .pr_agent_review
  variables:
    GITLAB_TOKEN: $GITLAB_ACCESS_TOKEN
    AI_PROVIDER: openai
    OPENAI_API_KEY: $OPENAI_API_KEY
```

---

## Key Files Summary

| File | Operation | Description |
|------|-----------|-------------|
| `.github/workflows/ci.yml` | Create | 项目自身 CI workflow (PR validation) |
| `.github/workflows/release.yml` | Create | 项目自身 CD workflow (Docker build + deploy) |
| `.gitlab-ci.yml` | Create | 项目自身 GitLab CI pipeline |
| `backend/src/cli.ts` | **Create** | CLI 入口点（github-action / gitlab-ci 模式） |
| `backend/src/integrations/github/github-review.ts` | **Modify** | 新增 `runGitHubCiReview()` + helper 函数 |
| `backend/src/integrations/github/index.ts` | **Modify** | 导出 `runGitHubCiReview` |
| `backend/src/integrations/gitlab/gitlab-review.ts` | **Modify** | 新增 `runGitLabCiReview()` + helper 函数 |
| `backend/src/integrations/gitlab/index.ts` | **Modify** | 导出 `runGitLabCiReview` |
| `action.yml` | **Create** | GitHub Action 定义（供其他项目使用） |
| `templates/gitlab-ci-review.yml` | **Create** | GitLab CI Template（供其他项目使用） |

## Execution Dependency Graph

```
Step 5 (runGitHubCiReview)  ─┐
                              ├─→ Step 4 (cli.ts) ─→ Step 7 (action.yml)
Step 6 (runGitLabCiReview)  ─┘                    ─→ Step 8 (gitlab template)

Step 1 (ci.yml)       ─→ 独立
Step 2 (release.yml)  ─→ 独立
Step 3 (.gitlab-ci)   ─→ 独立
```

建议执行顺序：
1. Step 5 + Step 6（并行：新增 CI review 函数）
2. Step 4（CLI 入口，依赖 Step 5/6）
3. Step 7 + Step 8（并行：Action + Template，依赖 Step 4）
4. Step 1 + Step 2 + Step 3（并行：项目自身 CI/CD，相互独立）

## Risk & Mitigation

| Risk | Mitigation |
|------|------------|
| Fork PR accessing secrets | Use `pull_request` event; no secrets in fork PRs |
| Action supply chain attack | Pin all third-party actions by commit SHA |
| Stale CI runs wasting resources | Concurrency cancellation for PRs |
| Docker layer cache bloat | Scope-separated GHA caches; Kaniko cache repo |
| Accidental production deploy | Protected environment with manual approval gate |
| Asymmetric quality gates | Backlog: add backend lint, frontend test/typecheck |
| CLI mode bypassing webhook auth | CLI 模式无需 webhook 签名，直接用 GITHUB_TOKEN 认证 |
| Action Docker image过大 | 使用 multi-stage build，runtime 阶段仅含 Node.js + dist |
| 用户 AI API Key 泄露 | 文档要求使用 GitHub Secrets / GitLab Protected Variables |
| `.pr-agent.yml` 缺失 | 回退到内置默认配置，所有功能默认开启 |

## Prerequisites (Before Enabling)

1. **GitHub**: Create `staging` and `production` environments in repo settings
2. **GitHub**: Configure required status checks from CI workflow on `main` branch protection
3. **GitLab**: Set CI/CD variables as protected (registry credentials, deploy tokens)
4. **Both**: Replace placeholder deploy commands with actual rollout scripts
5. **Action Publishing**: 在 release.yml 成功推送镜像到 GHCR 后，Action 才可被外部项目使用

## SESSION_ID (for /ccg:execute)

- CODEX_SESSION: 019cf0cd-17f1-7503-bdb1-7bf2815a5698
- GEMINI_SESSION: b2310c2f-0490-4c90-b59d-5aaad6c6b33d
