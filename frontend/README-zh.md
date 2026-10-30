# PR Agent — 落地页

**PR Agent** 的营销与文档站点，基于 GitHub App + GitLab Webhook 工作流的 AI 代码评审服务。

**技术栈**：Next.js (App Router) · Tailwind CSS · GSAP · TypeScript

## 快速开始

```bash
pnpm install
pnpm dev
```

浏览器打开 [http://localhost:3000](http://localhost:3000) 预览。

## 项目结构

```
frontend/
├── app/
│   ├── components/     # UI 区块（Hero、Features、Pricing …）
│   ├── i18n/           # en / zh 多语言
│   └── page.tsx        # 首页组合
├── lib/                # SEO、JSON-LD、公共工具
└── public/             # 静态资源（logo、图片）
```

## 架构

下图展示后端生产请求流。Webhook 只负责入队，持有租约的 Worker 执行评审；支持的命令和能力配置见根目录 README。

```mermaid
flowchart LR
    GH[GitHub App / webhook] --> SIGN[验签与载荷校验]
    GL[GitLab webhook] --> SIGN
    SIGN --> ROUTE[统一事件与命令识别]
    ROUTE --> IGNORE[忽略普通、不支持或未纳管事件]
    ROUTE --> AUTH[仓库绑定；命令作者权限]
    AUTH --> ENQUEUE[显式评审入队]
    API[受保护 Run API] --> ENQUEUE
    ENQUEUE --> PG[(PostgreSQL: Runs, budget, events, artifacts)]
    PG --> WORKER[持有租约的兼容 Worker]
    WORKER --> REVIEW[Single / 显式 Deep Review]
    REVIEW --> MODEL[受预算约束的模型网关]
    REVIEW --> PUB[持久化发布批次]
    PUB --> PROVIDER[GitHub / GitLab]
    RECOVERY[Recovery：对账未知外部效果] --> PUB
    FEEDBACK[授权反馈命令 / API] --> PG
    FIX[可选 Fix、隔离验证与人工审批] --> PG
    EVOLUTION[可选 Evolution 评测与发布] --> PG
    MAINT[受限维护：预览 / 保留清理] --> PG
    HEALTH[存活与按能力就绪检查] -.-> PG
```

## 部署

构建并运行生产环境：

```bash
pnpm --filter frontend build
pnpm --filter frontend exec next start -H 0.0.0.0 -p ${PORT:-3000}
```

### Coolify + Nixpacks（根目录部署 frontend）

仓库根目录已提供 `nixpacks.toml`，核心命令如下：

- Install: `pnpm install --frozen-lockfile`
- Build: `pnpm --filter frontend build`
- Start: `pnpm --filter frontend exec next start -H 0.0.0.0 -p ${PORT:-3000}`

Coolify 中建议设置：

- Build Pack: `Nixpacks`
- Base Directory: `/`（仓库根目录）
- Port: `3000`
- 环境变量：`NODE_ENV=production`

## 许可证

MIT
