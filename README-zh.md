# PR Agent

基于 TypeScript + NestJS 构建的 AI 代码评审服务。当前仓库已经调整为 `pnpm` monorepo：后端服务位于 `backend/`，Next.js 前端位于 `frontend/`。

[English README](./README.md)

## 目录

- [Beta 阶段说明](#beta-阶段说明)
- [功能特性](#功能特性)
- [评审触发](#评审触发)
- [路线图与流程资产](#路线图与流程资产)
- [系统架构](#系统架构)
- [技术栈](#技术栈)
- [项目结构](#项目结构)
- [快速开始](#快速开始)
- [配置说明](#配置说明)
- [部署指南](#部署指南)
- [平台接入](#平台接入)
- [评论命令](#评论命令)
- [仓库策略配置](#仓库策略配置)
- [可观测性](#可观测性)
- [测试](#测试)
- [许可证](#许可证)

---

## Beta 阶段说明

- PR Agent 当前处于 **beta** 阶段。
- 当前唯一正式支持的接入方式是 **GitHub App**。
- 仓库里仍可能保留普通 GitHub Webhook 和 GitLab 的代码路径，但它们目前不属于受支持的部署范围。

## 功能特性

**核心评审**
- PR 打开 / 更新 / 合并时自动 AI 代码评审
- 行内评论，支持 GitHub Suggested Changes 建议代码块
- Report 模式汇总评审，含风险等级评估
- 增量评审（仅评审上次评审后的新提交）
- 报告内 Mermaid 变更结构图（按目录/文件可视化）
- Diff 中疑似密钥泄露检测（轻量正则扫描）
- 自动标签（bugfix / feature / refactor / docs / security）

**交互命令**
- `/ai-review` — 手动触发评审（comment 或 report 模式）
- `/improve [重点]` — 仅输出改进建议导向的评审
- `/add_doc [重点]`（`/add-doc`）— 仅输出文档/注释改进建议
- `/improve_component <组件>` — 针对指定组件的改进评审

**流程守卫**
- `.pr-agent.yml` 仓库级评审策略
- `.github/.gitlab` 模板/流程文件识别（workflow/template/CODEOWNERS/CONTRIBUTING）并给出流程建议

**当前支持范围**
- 仅支持 GitHub App
- 普通 GitHub Webhook — 当前 beta 不支持
- GitLab Webhook — 当前 beta 不支持
- GitHub Actions — 暂不支持

**多模型 Provider**
- OpenAI
- OpenAI 兼容（DeepSeek 等）
- Anthropic（Claude）
- Google Gemini

### 评审触发

| 触发方式 | 评审模式 | 去重窗口 |
|---|---|---|
| PR 打开（`opened`） | comment / report（按配置） | 5 分钟 |
| PR 更新（`synchronize`） | comment / report | 5 分钟（按新 commit SHA） |
| PR 编辑（`edited`） | comment / report | 5 分钟 |
| PR 合并（`closed` + merged） | report | 24 小时（可配置） |
| `/ai-review` 评论命令 | comment / report | 5 分钟 |
| `/ai-review report` | report | 5 分钟 |
| `/ai-review comment` | comment | 5 分钟 |
| Issue 创建 / 编辑 | 流程预检（GitHub）+ 缺省策略自动分诊（无策略文件时） | 5 分钟 |
| PR 创建 / 编辑 / 同步 | 合并前预检（GitHub） | — |

手动评审命令要求 GitHub 仓库 write 及以上权限，或 GitLab Developer 及以上权限。GitHub App 需要 Metadata 读取权限以核查评论者；GitLab 使用服务端 API token 核查项目成员权限，Webhook secret 是另一项必填凭据。普通评论和不支持的命令会被忽略，不调用模型。

### 路线图与流程资产

- 竞争差距落地 backlog：`docs/roadmap/2026-02-19-competitive-gap-backlog.md`
- GitHub Issue 模板：`.github/ISSUE_TEMPLATE/bug_report.md`、`.github/ISSUE_TEMPLATE/feature_request.md`
- GitHub PR 模板：`.github/pull_request_template.md`
- GitLab Issue 模板：`.gitlab/issue_templates/Bug.md`、`.gitlab/issue_templates/Feature.md`
- GitLab MR 模板：`.gitlab/merge_request_templates/default.md`

**建议的 GitHub Flow 基线：**

1. 开启 Branch Protection，至少要求 `PR Agent Policy` 与 CI 必过。
2. 在仓库启用 `.pr-agent.yml` 的 `mode: enforce`（可先从核心仓库灰度）。
3. 统一使用 Issue/PR 模板，避免需求与验证信息缺失。

---

## 系统架构

### 仓库拓扑

```mermaid
graph LR
    ROOT[pr-agent monorepo]
    ROOT --> BE[backend/<br/>NestJS + Probot + tests]
    ROOT --> FE[frontend/<br/>Next.js 官网 / 控制台]
    ROOT --> OPS[Docker / Compose<br/>后端部署]
    ROOT --> NP[Nixpacks<br/>前端部署]
    ROOT --> DOCS[docs/<br/>路线图与流程资产]
```

### 整体架构

```mermaid
graph TB
    subgraph 平台入口
        GH_APP[GitHub App<br/>Probot]
        GH_WH[GitHub Webhook]
        GL_WH[GitLab Webhook]
    end

    subgraph NestJS 应用
        direction TB
        CTRL[Controllers<br/>路由 & 校验]
        SVC[Services<br/>签名验证 & 分发]
        INT[集成层<br/>GitHub / GitLab 适配器]
        RE[评审引擎<br/>AI Reviewer + Patch 解析]
        RR[报告渲染器<br/>Markdown + 建议代码块]
    end

    subgraph 外部服务
        AI[AI Providers<br/>OpenAI / Anthropic / Gemini]
        GH_API[GitHub API]
        GL_API[GitLab API]
        NOTIFY[通知推送<br/>Slack / Discord / 企业微信]
    end

    GH_APP -->|Webhook 事件| CTRL
    GH_WH -->|Webhook 事件| CTRL
    GL_WH -->|Webhook 事件| CTRL
    CTRL --> SVC
    SVC --> INT
    INT --> RE
    RE -->|LLM 调用| AI
    RE --> RR
    RR -->|发布评论 / 报告| GH_API
    RR -->|发布评论 / 报告| GL_API
    INT -.->|可选| NOTIFY
```

### 请求处理流程

```mermaid
sequenceDiagram
    participant P as 平台 (GitHub/GitLab)
    participant C as Controller
    participant S as Service
    participant D as 去重模块
    participant I as 集成层
    participant A as AI 评审引擎
    participant R as 报告渲染器

    P->>C: Webhook 事件
    C->>S: 验证签名 & 解析请求体
    S->>D: 去重检查（FNV 哈希，5 分钟窗口）
    alt 重复请求
        D-->>S: 跳过（已处理过）
    else 新请求
        D-->>S: 放行
        S->>I: 分发到平台处理器
        I->>I: 获取 diff、文件内容、策略配置
        I->>A: 发送上下文 + diff 给 AI 模型
        A-->>I: 结构化评审结果（Zod 校验）
        I->>R: 格式化报告 / 行内评论
        R->>P: 通过 API 发布评审
        I-->>P: 可选：通知 Webhook
    end
```

### 模块依赖关系

```mermaid
graph LR
    APP[AppModule] --> HTTP[http: capability APIs]
    APP --> BOOT[bootstrap: Probot and lifecycle]
    HTTP --> RUN[agent-runtime]
    HTTP --> FIX[fix]
    HTTP --> EVO[evolution]
    BOOT --> REV[review: standard and deep]
    BOOT --> CMD[commands]
    RUN --> REV
    RUN --> FIX
    RUN --> EVO
    RUN --> PG[PostgreSQL]
    REV --> MODEL[model]
    REV --> REPO[repository]
    REV --> INT[integrations]
    CMD --> REV
    CMD --> MODEL
    CMD --> INT
    FIX --> MODEL
    FIX --> REPO
    EVO --> MODEL
    EVO --> REV
    MODEL --> CORE[core]
    REPO --> CORE
    INT --> CORE
```

### 详细请求流

下图追踪每一条请求路径——从 Webhook 入口经过事件路由、命令解析、通用评审引擎，到最终输出与运维。

```mermaid
flowchart LR
    subgraph E["入口端点 (NestJS + Probot)"]
        E1["/api/github/webhooks<br/>GithubAppBootstrapService"]
        E2["/github/trigger<br/>GithubWebhookController"]
        E3["/gitlab/trigger<br/>GitlabWebhookController"]
        E4["/github/replay/:eventId<br/>/gitlab/replay/:eventId"]
        E5["/health /metrics /webhook/events"]
    end

    subgraph GHA["GitHub App 事件路由 (backend/src/bootstrap/probot-app.ts)"]
        A1["issues.opened, issues.edited<br/>runGitHubIssuePolicyCheck"]
        A2["pull_request.opened, edited, synchronize<br/>runGitHubPullRequestPolicyCheck"]
        A3["resolveGitHubPullRequestAutoReviewPolicy"]
        A4["pull_request.closed (merged)<br/>resolveGitHubReviewBehaviorPolicy"]
        A5["issue_comment.created (PR + Issue)<br/>handleGitHubIssueCommentCommand"]
        A6["pull_request_review_thread<br/>recordGitHubFeedbackSignal"]
    end

    subgraph GHW["原生 GitHub Webhook (backend/src/integrations/github/webhooks/handler.ts)"]
        B1["handlePlainGitHubWebhook"]
        B2["verifyWebhookSignature + payload schema"]
        B3["pull_request / issues / issue_comment / review_thread dispatch"]
        B4["runGitHubPullRequestPolicyCheck + runGitHubIssuePolicyCheck"]
        B5["handleGitHubIssueCommentCommand"]
    end

    subgraph GLW["GitLab Webhook (backend/src/integrations/gitlab/webhooks/adapter.ts)"]
        C1["runGitLabWebhook"]
        C2["verify token + payload schema"]
        C3["handleGitLabMergeRequestWebhook"]
        C4["handleGitLabNoteWebhook"]
        C5["resolveGitLabReviewPolicy (.pr-agent.yml)"]
    end

    subgraph CMD["命令解析层"]
        D1["parseReviewCommand"]
        D2["parseAsk / parseMention / parseChecks / parseGenerateTests"]
        D3["parseDescribe / parseChangelog"]
        D4["parseImprove / parseAddDoc / parseReflect / parseSimilarIssue / parseFeedback"]
    end

    subgraph CORE["通用评审引擎"]
        R1["runGitHubReview / runGitLabReview"]
        R2["去重 + 限流 + 增量 head + 反馈信号"]
        R3["收集上下文: diff/files/ci/policy"]
        R4["analyzePullRequest / answerPullRequestQuestion"]
        R5["patch 解析 + hunk 优先级 + 行映射"]
        R6["密钥扫描 + 自动标签"]
    end

    subgraph OUT["输出与运维"]
        O1["buildReportCommentMarkdown"]
        O2["buildIssueCommentMarkdown"]
        O3["createComment / notes / managed upsert"]
        O4["publishNotification (可选)"]
        O5["pr_agent_* 指标 + replay 存储"]
    end

    E1 --> A1
    E1 --> A2 --> A3 --> R1
    E1 --> A4 --> R1
    E1 --> A5
    E1 --> A6

    E2 --> B1 --> B2 --> B3
    B3 --> B4 --> R1
    B3 --> B5

    E3 --> C1 --> C2
    C2 --> C3 --> C5 --> R1
    C2 --> C4 --> C5

    A5 --> D1
    A5 --> D2
    A5 --> D3
    A5 --> D4
    B5 --> D1
    B5 --> D2
    B5 --> D3
    B5 --> D4
    C4 --> D1
    C4 --> D2
    C4 --> D3
    C4 --> D4

    D1 --> R1
    D2 --> R4
    D3 --> R4
    D4 --> R1

    R1 --> R2 --> R3 --> R4 --> R5
    R4 --> R6
    R5 --> O1 --> O3
    R5 --> O2 --> O3
    R6 --> O3
    O3 --> O4

    E4 --> B1
    E4 --> C1
    E5 --> O5
    E2 --> O5
    E3 --> O5
    O3 -. 反馈信号 .-> R2
```

---

## 技术栈

| 层级 | 技术 |
|---|---|
| 运行时 | Node.js 22 (Alpine) |
| 语言 | TypeScript 5.7（ES2022，严格模式） |
| 框架 | NestJS 11 |
| HTTP 服务 | Express 4 |
| GitHub App | Probot 13 |
| AI 客户端 | OpenAI SDK 4（同时用于兼容 Provider） |
| 校验 | Zod 3 |
| 状态存储 | PostgreSQL 17（业务状态）/ 进程内存（可重新获取缓存） |
| 容器 | Docker（多阶段构建） |

---

## 项目结构

后端启动、测试与功能文档见 [后端开发指南](backend/README.md)。

```
pr-agent/
├── backend/
│   ├── src/
│   │   ├── main.ts                  # NestJS 启动入口
│   │   ├── app.module.ts            # NestJS 根模块
│   │   ├── bootstrap/               # Probot、GitHub App 与关闭协调
│   │   ├── http/                    # 路由、鉴权、Runs / Fixes / Evolution API
│   │   ├── agent-runtime/           # Run 执行、预算、持久化、发布恢复
│   │   ├── model/                   # 模型契约、配置、Provider、并发与健康检查
│   │   ├── review/                  # 标准评审、多 Agent 深度评审、策略与渲染
│   │   ├── commands/                # 命令解析、Ask 会话与命令编排
│   │   ├── repository/              # 仓库读取契约、diff 与内容安全
│   │   ├── issues/                  # 相似 Issue、分诊与策略
│   │   ├── fix/                     # 修复提案、验证、审批与发布
│   │   ├── evolution/               # 反馈、数据集、评测、候选与发布控制
│   │   ├── integrations/            # GitHub / GitLab / notifications 适配层
│   │   ├── core/                    # 通用配置、HTTP、状态、安全与基础工具
│   │   └── types/                   # 共享类型声明
│   ├── tests/                      # 按功能模块组织的测试
│   │   ├── support/                # 公共测试辅助 API
│   │   └── fixtures/               # 测试输入与子进程夹具
│   ├── docs/                       # 运行时、API、运维及业务功能文档
│   ├── validation/                 # 工程、容量与模型评测历史证据
│   ├── README.md                   # 后端开发与验证入口
│   ├── package.json
│   └── tsconfig.json
├── frontend/
│   ├── app/                        # Next.js App Router 页面与布局
│   ├── components/                 # 前端 UI 组件
│   ├── public/                     # 静态资源
│   ├── package.json
│   └── next.config.ts
├── docs/                           # 本地规划资料（不纳入版本管理）
├── data/                           # 本地/运行时持久化数据挂载点
├── secrets/                        # 本地私钥挂载目录（不提交）
├── Dockerfile                      # 后端容器镜像
├── docker-compose.yml              # 后端部署与本地运维
├── nixpacks.toml                   # 根目录 Nixpacks 入口，部署 frontend
├── package.json                    # Workspace 脚本
├── pnpm-lock.yaml
├── pnpm-workspace.yaml
├── turbo.json
├── README.md
└── README-zh.md
```

### Workspace 说明

- 仓库根目录 `.env` 同时供本地后端开发和 Docker Compose 使用。
- `backend/` 是可部署的评审服务；使用根目录 `nixpacks.toml` 时部署的是 `frontend/`，不是后端。
- 容器内后端持久化路径默认是 `/data/pr-agent/...`，宿主机对应为 `data/pr-agent/...`。

### 后端路径别名

后端包使用 Node.js ESM subpath imports（配置位于 `backend/tsconfig.json` 和 `backend/package.json`）：

| 别名 | 映射路径 |
|---|---|
| `#core` | `backend/src/core/index.ts` |
| `#review` | `backend/src/review/index.ts` |
| `#model` | `backend/src/model/index.ts` |
| `#integrations/github` | `backend/src/integrations/github/index.ts` |
| `#integrations/gitlab` | `backend/src/integrations/gitlab/index.ts` |
| `#integrations/notifications` | `backend/src/integrations/notifications/index.ts` |

---

## 快速开始

### 前置条件

- Node.js >= 22
- pnpm >= 10

### 本地开发

```bash
# 安装 workspace 依赖
pnpm install

# 在仓库根目录准备环境变量文件
cp .env.example .env

# 启动后端（backend 包会读取 ../.env）
pnpm dev:backend

# 启动前端
pnpm dev:frontend

# 生产构建后端
pnpm --filter backend build

# 启动已构建的后端
pnpm --filter backend start
```

后端默认监听 `3000` 端口（可通过 `PORT` 环境变量配置）。前端单独运行时也默认使用 `3000`。

### 健康检查

```bash
curl http://localhost:3000/health
curl http://localhost:3000/ready              # 检查已启用能力的运行依赖
curl http://localhost:3000/github/health       # GitHub 配置状态
```

---

## 配置说明

### 环境变量

复制 `.env.example` 并填入所需值。当前受支持的最小配置模板是：

- `.env.github-app.min.example` — GitHub App 最小配置

普通 GitHub Webhook 和 GitLab 的最小示例文件仍保留在仓库中，仅供参考，不属于当前 beta 的受支持部署路径。

### AI Provider 配置

```mermaid
graph LR
    ENV[AI_PROVIDER 环境变量]
    ENV -->|openai| OAI[OpenAI<br/>OPENAI_API_KEY + OPENAI_MODEL]
    ENV -->|openai-compatible| OC[OpenAI 兼容<br/>OPENAI_BASE_URL + OPENAI_COMPATIBLE_MODEL]
    ENV -->|anthropic| ANT[Anthropic<br/>ANTHROPIC_API_KEY + ANTHROPIC_MODEL]
    ENV -->|gemini| GEM[Gemini<br/>GEMINI_API_KEY + GEMINI_MODEL]
```

**OpenAI（默认）**
```env
AI_PROVIDER=openai
OPENAI_API_KEY=sk-...
OPENAI_MODEL=gpt-4.1-mini
```

**OpenAI 兼容（如 DeepSeek）**
```env
AI_PROVIDER=openai-compatible
OPENAI_BASE_URL=https://api.deepseek.com/v1
OPENAI_COMPATIBLE_API_KEY=...
OPENAI_COMPATIBLE_MODEL=deepseek-chat
```

**Anthropic**
```env
AI_PROVIDER=anthropic
ANTHROPIC_API_KEY=sk-ant-...
ANTHROPIC_MODEL=claude-3-5-haiku-latest
ANTHROPIC_MAX_TOKENS=8192
```

**Gemini**
```env
AI_PROVIDER=gemini
GEMINI_API_KEY=...
GEMINI_MODEL=gemini-2.0-flash
```

### 状态持久化

PostgreSQL 统一保存 Run、限流、评审游标、反馈以及验签后的 Webhook replay。进程内存只用于可重新获取的缓存。

### 通知推送（可选）

支持企业微信、Slack、Discord 和通用 JSON Webhook：

```env
NOTIFY_WEBHOOK_URL=https://hooks.slack.com/services/...
NOTIFY_WEBHOOK_FORMAT=slack   # wecom | slack | discord | generic
```

### 关键调参

**AI 提供商调参**

| 变量 | 默认值 | 说明 |
|---|---|---|
| `AI_HTTP_TIMEOUT_MS` | `30000`（30 秒） | AI 评审请求 HTTP 超时 |
| `AI_HTTP_RETRIES` | `2` | AI 提供商临时故障时的重试次数 |
| `AI_HTTP_RETRY_BACKOFF_MS` | `400` | AI 请求重试基础退避时延（毫秒） |
| `AI_MAX_CONCURRENCY` | `4` | AI 请求最大并发数 |
| `AI_MAX_QUEUE_SIZE` | `200` | AI 等待队列上限（超限后拒绝新任务） |
| `AI_SHUTDOWN_DRAIN_TIMEOUT_MS` | `15000`（15 秒） | 进程关闭时等待进行中 AI 请求完成的超时时间 |
| `AI_DEBUG_LOGS` | `false` | 记录 AI 请求/响应载荷用于调试 |
| `HEALTHCHECK_AI_TIMEOUT_MS` | `5000`（5 秒） | 深度健康检查 AI 探测超时 |
| `FEATURE_DEEP_REVIEW` | `on` | 允许显式 Deep Review；普通 PR webhook 默认仍为 Single |
| `FEATURE_FIX` | `off` | 需同时满足绑定授权、策略和 verifier 依赖 |
| `FEATURE_EVOLUTION` | `off` | 为已授权绑定启用反馈和离线评测 |

`AI_CONCURRENCY_LIMIT` 已废弃，不再生效。请改用 `AI_MAX_CONCURRENCY` 与 `AI_MAX_QUEUE_SIZE`。

**全局运行时与命令限流**

| 变量 | 默认值 | 说明 |
|---|---|---|
| `WEBHOOK_BODY_LIMIT` | `1mb` | 全局 Express body-parser 上限（超限返回 `413`） |
| `COMMAND_RATE_LIMIT_MAX` | `10` | 每用户、每 PR/MR、每命令在窗口内的最大触发次数 |
| `COMMAND_RATE_LIMIT_WINDOW_MS` | `3600000`（1 小时） | 命令限流时间窗口 |

**GitHub 专属**

| 变量 | 默认值 | 说明 |
|---|---|---|
| `GITHUB_MERGED_DEDUPE_TTL_MS` | `86400000`（24 小时） | `merged + report` 事件去重窗口 |
| `GITHUB_FEEDBACK_SIGNAL_TTL_MS` | `2592000000`（30 天） | 反馈学习信号保留时长 |
| `GITHUB_INCREMENTAL_STATE_TTL_MS` | `604800000`（7 天） | 增量评审 SHA 缓存有效期 |
| `GITHUB_POLICY_CONFIG_CACHE_TTL_MS` | `300000`（5 分钟） | `.pr-agent.yml` 策略/评审配置缓存 |
| `GITHUB_WEBHOOK_MAX_BODY_BYTES` | `10485760`（10MB） | `/github/trigger` 的额外请求体硬上限 |
| `GITHUB_WEBHOOK_SKIP_SIGNATURE` | `false` | 仅调试可用；`NODE_ENV=production` 时禁止开启 |

**GitLab 专属**

| 变量 | 默认值 | 说明 |
|---|---|---|
| `GITLAB_MERGED_DEDUPE_TTL_MS` | `86400000`（24 小时） | `merged + report` 去重窗口 |
| `GITLAB_INCREMENTAL_STATE_TTL_MS` | `604800000`（7 天） | 增量评审状态缓存 |
| `GITLAB_FEEDBACK_SIGNAL_TTL_MS` | `2592000000`（30 天） | 反馈学习信号保留窗口 |
| `GITLAB_POLICY_CONFIG_CACHE_TTL_MS` | `300000`（5 分钟） | `.pr-agent.yml` 策略缓存 |
| `GITLAB_WEBHOOK_MAX_BODY_BYTES` | `10485760`（10MB） | `/gitlab/trigger` 的额外请求体硬上限 |
| `GITLAB_WEBHOOK_SECRET` | GitLab 必填 | 缺失或不匹配时拒绝 Webhook；请求头不能提供 API 凭据或覆盖评审策略 |
| `ALLOW_INSECURE_GITLAB_HTTP` | `false` | 仅本地调试允许 `http://` GitLab 地址 |

**调参建议：**

- `MERGED_DEDUPE_TTL_MS` — 控制 `merged + report` 事件的去重窗口，防止 Webhook 重投时重复评审。遇到较多 Webhook 重试/Redeliver 时可调大到 `48h~72h`；需要更快允许同一 PR 合并事件再次触发时可调小到 `1h~6h`。该变量只影响合并自动触发；手动评论命令触发（`/ai-review ...`）仍使用短窗口（5 分钟）去重策略。
- `FEEDBACK_SIGNAL_TTL_MS` — 控制 review thread resolved/unresolved 信号的保留时长。团队评审节奏慢、希望长期记忆偏好可设为 `60~90` 天；规则变化快、希望更快"遗忘"历史偏好可设为 `7~14` 天。
- `COMMAND_RATE_LIMIT_*` — 控制评论命令的防滥用阈值。高活跃仓库可适当上调，命令刷屏场景可下调。

`.env.example` 提供基础变量参考；上方补充的是代码已实现但通常不在最小模板中的高级开关。

---

## 部署指南

### Docker 部署（推荐）

```mermaid
graph LR
    subgraph Docker 构建
        B1[构建阶段<br/>编译后端]
        B2[依赖阶段<br/>仅生产依赖]
        B3[运行时阶段<br/>非 root node:22-alpine]
        B1 -->|dist| B3
        B2 -->|node_modules| B3
    end
    B3 --> W[web 容器]
    B3 --> Q[worker 容器]
    B3 --> R[recovery 容器]
```

**构建 & 运行**

```bash
docker build -t pr-agent:latest .
docker run -d \
  --name pr-agent \
  --user 10001:10001 --read-only --cap-drop ALL \
  --security-opt no-new-privileges --tmpfs /tmp:rw,noexec,nosuid,nodev,size=256m \
  -p 3000:3000 \
  --env-file .env \
  pr-agent:latest
```

应用镜像不内置 PostgreSQL，也不会为外部数据库创建角色。单独运行容器时，部署平台必须预先提供 PostgreSQL、受限 schema owner / 应用角色，并完成迁移。单容器 `all` 角色只适合本地验证；生产部署应分别运行 `web`、`worker` 和 `recovery`，平台未托管这些进程时使用下方 Compose。

发布到镜像仓库时，用 Buildx 生成同时包含两种架构的 manifest。verifier operator 需要 Docker CLI，因此使用独立 tag；普通应用镜像不会包含 Docker CLI：

```bash
docker buildx build --platform linux/amd64,linux/arm64 --target default \
  -t ghcr.io/OWNER/pr-agent:TAG --push .
docker buildx build --platform linux/amd64,linux/arm64 --target verifier \
  -t ghcr.io/OWNER/pr-agent-verifier:TAG --push .
```

使用 `docker buildx imagetools inspect` 检查 manifest。BuildKit provenance 显示的 `unknown/unknown` 是附属于两种运行时镜像的证明，不是第三种架构。

### Docker Compose

将 `.env.example` 复制为 `.env` 并替换全部占位值。Compose 强制要求四个互不相同的随机 PostgreSQL 密码，不提供默认回退值：

```env
HARNESS_BOOTSTRAP_PASSWORD=...
HARNESS_MIGRATION_PASSWORD=...
HARNESS_APP_PASSWORD=...
HARNESS_VERIFIER_PASSWORD=...
```

```bash
# 启动
docker compose up -d --build

# 查看日志
docker compose logs -f pr-agent worker recovery

# 重启
docker compose restart pr-agent worker recovery

# 停止
docker compose down
```

`docker-compose.yml` 使用：

- `harness-postgres` — PostgreSQL 业务状态与迁移账本
- `pr-agent` — 只承载公网 `web` 进程
- `worker` 与 `recovery` — 独立的持久执行进程
- `PRIVATE_KEY` — 默认以内联方式提供 GitHub App PEM，适合 Coolify 等密钥环境变量管理器
- `docker-compose.secret-file.yml` — 可选的 PEM 文件 overlay，供已管理 secret 文件的主机使用

全新 volume 首次启动时，PostgreSQL 会创建受限的 migrator、应用和 verifier 角色；一次性 `database-init` 服务在三个应用角色启动前应用 schema。修改 `.env` 不会轮换已有 volume 中的密码。由旧版超级用户 `pr_agent_migrator` 创建的 volume 必须先备份，再按 [旧 volume 角色升级](backend/docs/operations.md#旧-volume-角色升级) 显式处理；不要删除 volume，也不要先运行新版迁移容器。

Compose 只把 `.env` 用于插值。应用服务通过显式运行配置白名单接收变量，不会整体加载该文件，因此应用容器中不存在 bootstrap、迁移或 verifier 凭据。

所有应用角色都使用固定 UID/GID `10001:10001`、只读根文件系统、有上限的 tmpfs、`cap-drop ALL` 和 `no-new-privileges`。基础 Compose 只接收内联 `PRIVATE_KEY`，并让 `PRIVATE_KEY_PATH` 保持为空，因此 Coolify 不需要宿主 PEM 文件。需要文件时使用 `docker compose -f docker-compose.yml -f docker-compose.secret-file.yml up -d`；overlay 会清空内联 key，只挂 PEM 路径。本地 Compose 不保证 file secret 的 `uid/gid/mode` 重映射，因此 Linux 宿主必须把源文件设置为 UID/GID `10001:10001`、权限 `0400`，或使用平台原生 secret-file。应用容器均不挂 Docker socket 或 verifier 快照目录。

普通 Compose 不部署 Fix verifier。启用 Fix 时，只能在拥有独立本地 Docker daemon 的专用主机或 VM 上运行 `docker-compose.verifier-operator.yml`。operator 只接收受限 PostgreSQL URL、冻结策略和本地 daemon socket，不开放 HTTP，也不接收 GitHub、GitLab、模型或 webhook 凭据。普通 Compose 内置的 PostgreSQL 没有宿主端口，因此远端 operator 需要单独托管的 PostgreSQL 端点或受保护的私网链路，绝不能把 PostgreSQL 直接暴露到公网。Docker socket 即使只读挂载也拥有 Docker API 控制权，因此绝不能进入应用部署。

### Nixpacks（仅前端）

根目录 `nixpacks.toml` 用于从仓库根目录部署 `frontend/`，不会构建或启动后端。

- Install: `pnpm install --frozen-lockfile`
- Build: `pnpm --filter frontend build`
- Start: `pnpm --filter frontend start`

### 生产部署清单

```mermaid
graph TD
    A[选择平台模式] -->|GitHub App| B1[创建 GitHub App]
    A -->|普通 Webhook| B2[生成 PAT Token]
    A -->|GitLab| B3[生成 API Token]

    B1 --> C[配置 AI Provider]
    B2 --> C
    B3 --> C

    C --> D[初始化 PostgreSQL schema]
    D --> E[部署容器]
    E --> F[配置 Webhook URL]
    F --> G[验证健康检查端点]
    G --> H[测试 /ai-review 命令]
```

1. **使用 GitHub App 接入模式** — 这是当前 beta 唯一受支持的接入方式
2. **配置 AI Provider** — 设置 `AI_PROVIDER` 及对应的 API Key / 模型名称
3. **初始化 PostgreSQL** — Compose 必须配置四个数据库密码并确认 `database-init` 成功；外部 PostgreSQL 则必须先建立等价的受限角色，再运行迁移 CLI
4. **部署容器** — Docker、Docker Compose、Render、Railway、Fly.io 或 K8s
5. **配置 Webhook URL** 为 `https://<域名>/api/github/webhooks`
6. **验证** — 访问健康检查端点，并在 PR 中测试 `/ai-review` 命令

### 快速部署参考

这是一个适用于 Render/Railway/Fly.io/Docker/K8s 的精简部署路径。

1. **使用 GitHub App 模式**
2. **使用最小环境变量**

**GitHub App 最小配置（`.env.github-app.min.example`）**

```env
APP_ID=123456
PRIVATE_KEY="-----BEGIN RSA PRIVATE KEY-----\\n...\\n-----END RSA PRIVATE KEY-----\\n"
# PRIVATE_KEY_PATH=/run/secrets/github-app-private-key.pem
WEBHOOK_SECRET=replace-with-webhook-secret
AI_PROVIDER=openai
OPENAI_API_KEY=replace-with-openai-key
OPENAI_MODEL=gpt-4.1-mini
```

**必需的持久化运行配置**

```env
HARNESS_DATABASE_URL=postgresql://pr_agent_app:password@postgres:5432/pr_agent
```

Webhook replay 会在验签后写入 PostgreSQL。管理接口使用带 `replay:read` 或 `replay:execute` 权限的作用域 API principal。

3. **启动后端应用**

```bash
pnpm install --frozen-lockfile
pnpm --filter backend build
pnpm --filter backend start
```

后端服务监听 `PORT`（默认 `3000`）。

4. **配置 Webhook 地址**
   - GitHub App：`https://<域名>/api/github/webhooks`
5. **Docker 一键启动**

```bash
docker build -t pr-agent:latest .
docker run -d --name pr-agent --user 10001:10001 --read-only --cap-drop ALL \
  --security-opt no-new-privileges --tmpfs /tmp:rw,noexec,nosuid,nodev,size=256m \
  -p 3000:3000 --env-file .env pr-agent:latest
```

6. **验证清单**
   - `GET /health`
   - `GET /github/health`
   - `GET /metrics`
   - 在 PR/MR 评论中测试：`/ai-review`、`/ai-review comment`
   - Webhook 失败响应应包含结构化字段：`error/type/status/path/method/timestamp`

使用具备对应作用域权限的 API principal：
- `GET /webhook/events`
- `POST /github/replay/:eventId`
- 请求头：`Authorization: Bearer <HARNESS_API_PRINCIPAL_TOKEN>`

### Nginx 反向代理

当前仓库未提交 `deploy/nginx/` 示例文件，可直接使用下方片段作为基线：

```nginx
server {
    listen 443 ssl;
    server_name pr-agent.example.com;

    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
```

---

## 平台接入

### GitHub App（当前唯一支持的方式）

1. 创建 GitHub App，配置以下权限：
   - **Pull requests**：Read & write
   - **Issues**：Read & write
   - **Contents**：Read-only
   - **Checks**：Read-only
   - **Metadata**：Read-only
2. 订阅事件：
   - `Pull request`（`opened` / `edited` / `synchronize` / `closed`）
   - `Issue comment`
   - `Pull request review thread`（`resolved` / `unresolved`，用于反馈学习）
3. Webhook URL 设为 `https://<域名>/api/github/webhooks`
4. 配置环境变量：

```env
APP_ID=123456
PRIVATE_KEY="-----BEGIN RSA PRIVATE KEY-----\n...\n-----END RSA PRIVATE KEY-----\n"
# PRIVATE_KEY_PATH=/run/secrets/github-app-private-key.pem
WEBHOOK_SECRET=your-webhook-secret
```

- GitHub App 启用条件（见 `backend/src/bootstrap/github-app/github-app-bootstrap.service.ts`）：`APP_ID` +（`PRIVATE_KEY` 或 `PRIVATE_KEY_PATH`）+ `WEBHOOK_SECRET`。
- 基础 `docker-compose.yml` 使用内联 `PRIVATE_KEY`，不要求宿主 PEM 文件，这也是 Coolify 兼容路径。可选 `docker-compose.secret-file.yml` overlay 从 `./secrets/github-app.private-key.pem` 创建文件 secret；Linux 上必须先把它设置为 UID/GID `10001:10001`、权限 `0400`。
- 仅在使用可选文件 overlay 时创建受管秘钥目录：`mkdir -p secrets`。

> 若未配置 `APP_ID` + `PRIVATE_KEY`（+ `WEBHOOK_SECRET`），GitHub App 模式会被禁用，此时当前 beta 部署也视为不完整。

### 当前 Beta 不支持的集成方式

- 普通 GitHub Webhook 目前不是受支持的部署目标。
- GitLab Webhook 目前不是受支持的部署目标。

---

## 评论命令

所有命令通过 PR/MR 评论触发。标记 **(仅 PR)** 的命令需要 Pull Request 上下文（diff、CI 检查），在 Issue 评论中不可用。

| 命令 | 说明 |
|---|---|
| `/ai-review` **(仅 PR)** | 触发 AI 评审（未显式指定时默认 `report`） |
| `/ai-review report` **(仅 PR)** | 强制 Report 模式（汇总评论） |
| `/ai-review comment` **(仅 PR)** | 强制 Comment 模式（行内评论） |
| `/ai-review --mode=report` / `--mode=comment` **(仅 PR)** | 参数方式指定评审模式（与位置参数等价） |
| `/improve [重点]` **(仅 PR)** | 以改进建议为主进行评审 |
| `/add_doc [重点]` / `/add-doc [重点]` **(仅 PR)** | 仅输出文档/注释改进建议 |
| `/improve_component <组件>` **(仅 PR)** | 针对指定组件的改进评审 |

GitHub 支持上面的四类命令；GitLab 当前仅支持 `/ai-review`。其他评论会被正常确认并忽略，不会调用模型。

---

## 仓库策略配置

在仓库根目录添加 `.pr-agent.yml` 来配置仓库级行为：

```yaml
review:
  enabled: true
  mode: comment         # comment | report
  onOpened: true        # PR 打开时评审
  onEdited: false
  onSynchronize: true   # 新提交时评审
  includeCiChecks: true
  improveCommandEnabled: true
  addDocCommandEnabled: true
  secretScanEnabled: true
  autoLabelEnabled: true
  secretScanCustomPatterns:  # 可选：仓库自定义密钥正则
    - "(?i)my_internal_token_[a-z0-9]{16,}"
  customRules:
    - 所有公开 API 必须提供类型注释
    - 不允许新增 any 类型
```

GitHub 和 GitLab 都读取 `.pr-agent.yml` 中的 `review:` 段。PostgreSQL 命令路径不包含 Issue/PR 模板强制校验。

**review 字段说明：**

| 字段 | 说明 |
|---|---|
| `enabled` / `mode` | 启用 AI 评审，设置默认模式（comment / report） |
| `onOpened` / `onEdited` / `onSynchronize` | 控制哪些 PR 事件自动触发评审 |
| `includeCiChecks` | 是否把 CI 检查结果带入 AI 上下文 |
| `improveCommandEnabled` | 是否启用 `/improve` 命令 |
| `addDocCommandEnabled` | 是否启用 `/add_doc`（`/add-doc`）命令 |
| `secretScanEnabled` | 是否扫描 diff 中疑似密钥泄露并发布安全提示 |
| `secretScanCustomPatterns` | 仓库自定义密钥正则补充规则 |
| `autoLabelEnabled` | 是否根据变更内容自动追加 PR 标签 |
| `customRules` | 团队自定义评审规则（自然语言），在评审与问答中都会强制纳入 |

---

## 可观测性

### 指标

Prometheus 格式指标通过 `GET /metrics` 暴露：

- `pr_agent_webhook_requests_total` — 按平台和事件统计的 Webhook 请求数
- `pr_agent_webhook_results_total` — 按平台和结果（ok/error）统计
- `pr_agent_webhook_replay_total` — 回放执行结果统计
- `pr_agent_webhook_store_writes_total` — 调试事件存储写入次数
- `pr_agent_webhook_store_trim_total` — 调试事件存储裁剪次数
- `pr_agent_health_checks_total` — 健康检查端点调用次数
- `pr_agent_http_errors_total` — 全局 HTTP 错误计数
- `pr_agent_process_uptime_seconds` — 进程运行时间
- `pr_agent_ai_requests_active` — 当前 AI 活跃请求数
- `pr_agent_ai_wait_queue_size` — AI 并发等待队列长度
- `pr_agent_ai_shutdown_requested` — AI 关停标记（0/1）
- `pr_agent_runtime_state_backend_info{backend=...}` — 当前状态后端信息指标

### 健康检查

| 端点 | 用途 |
|---|---|
| `GET /health` | 存活探针 |
| `GET /ready` | 检查已启用能力及运行时依赖是否就绪 |
| `GET /github/health` | GitHub Webhook 配置校验 |
| `GET /gitlab/health` | GitLab Webhook 遗留配置校验（当前 beta 不支持） |

### 错误处理

Webhook 错误返回结构化 JSON。已知 Webhook 错误（如 `BadWebhookRequestError`、`WebhookAuthError`）包含描述性消息；未识别的内部错误会被过滤为 `"internal server error"` 以防止信息泄露。

```json
{
  "ok": false,
  "error": "webhook secret verification failed",
  "type": "WebhookAuthError",
  "status": 401,
  "path": "/github/trigger",
  "method": "POST",
  "timestamp": "2026-01-01T00:00:00.000Z"
}
```

请求体超过 `WEBHOOK_BODY_LIMIT`（默认 `1mb`）时返回 `413 Payload Too Large`。

### Webhook 回放

验签后的成功与失败 envelope 会写入 PostgreSQL。端点要求 tenant 与 integration 作用域的 API principal：
- `GET /webhook/events` — 列出已存储的事件
- `POST /github/replay/:eventId` — 回放 GitHub 事件
- `POST /gitlab/replay/:eventId` — 回放 GitLab 事件

### 韧性机制

- **HTTP 重试**：指数退避（2 次重试，400ms 基础延迟），针对 408/429/5xx 状态码
- **请求去重**：FNV 哈希，5 分钟窗口（合并事件 24 小时）
- **限流**：按作用域限制，防止 API 滥用
- **优雅关停**：收到 SIGTERM/SIGINT 后排空进行中的请求

---

## 测试

```bash
# 后端测试
pnpm test:backend

# 后端覆盖率
pnpm --filter backend test:coverage

# 后端类型检查
pnpm --filter backend check

# 前端生产构建回归检查
pnpm --filter frontend build
```

后端测试使用 Node.js 内置测试运行器（`node:test`）。建议的回归检查覆盖：
- AI 并发控制
- 缓存与去重行为
- Diff 解析与 Hunk 优先级
- GitHub/GitLab 集成逻辑
- HTTP 重试与错误处理
- 策略校验
- 通知适配器
- NestJS 模块装配

---

## 许可证

私有项目 — 详见仓库说明。
