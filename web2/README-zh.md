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
web2/
├── app/
│   ├── components/     # UI 区块（Hero、Features、Pricing …）
│   ├── i18n/           # en / zh 多语言
│   └── page.tsx        # 首页组合
├── lib/                # SEO、JSON-LD、公共工具
└── public/             # 静态资源（logo、图片）
```

## 架构

下图展示 PR Agent 后端的完整请求流——从 Webhook 入口到命令解析、通用评审引擎、输出与运维。

```mermaid
flowchart LR
    subgraph E["入口端点 (NestJS + Probot)"]
        E1["/api/github/webhooks<br/>GithubAppBootstrapService"]
        E2["/github/trigger<br/>GithubWebhookController"]
        E3["/gitlab/trigger<br/>GitlabWebhookController"]
        E4["/github/replay/:eventId<br/>/gitlab/replay/:eventId"]
        E5["/health /metrics /webhook/events"]
    end

    subgraph GHA["GitHub App 事件路由 (src/app.ts)"]
        A1["issues.opened, issues.edited<br/>runGitHubIssuePolicyCheck"]
        A2["pull_request.opened, edited, synchronize<br/>runGitHubPullRequestPolicyCheck"]
        A3["resolveGitHubPullRequestAutoReviewPolicy"]
        A4["pull_request.closed (merged)<br/>resolveGitHubReviewBehaviorPolicy"]
        A5["issue_comment.created (PR + Issue)<br/>handleGitHubIssueCommentCommand"]
        A6["pull_request_review_thread<br/>recordGitHubFeedbackSignal"]
    end

    subgraph GHW["原生 GitHub Webhook (src/integrations/github/github-webhook.ts)"]
        B1["handlePlainGitHubWebhook"]
        B2["verifyWebhookSignature + payload schema"]
        B3["pull_request / issues / issue_comment / review_thread dispatch"]
        B4["runGitHubPullRequestPolicyCheck + runGitHubIssuePolicyCheck"]
        B5["handleGitHubIssueCommentCommand"]
    end

    subgraph GLW["GitLab Webhook (src/integrations/gitlab/gitlab-review.ts)"]
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
        O5["mr_agent_* 指标 + replay 存储"]
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

## 部署

构建并运行生产环境：

```bash
pnpm --filter web2 build
pnpm --filter web2 start
```

### Coolify + Nixpacks（根目录部署 web2）

仓库根目录已提供 `nixpacks.toml`，核心命令如下：

- Install: `pnpm install --frozen-lockfile`
- Build: `pnpm --filter web2 build`
- Start: `pnpm --filter web2 exec next start -H 0.0.0.0 -p ${PORT:-3000}`

Coolify 中建议设置：

- Build Pack: `Nixpacks`
- Base Directory: `/`（仓库根目录）
- Port: `3000`
- 环境变量：`NODE_ENV=production`

## 许可证

MIT
