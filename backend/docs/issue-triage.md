# Issue Triage Agent

`issue.triage.v1` 为已经接入、处于 active 状态的 GitHub 仓库分析普通 Issue。新建 Issue 或修改其标题/正文会触发；普通评论、标签变动、机器人事件、关闭的 Issue 和 PR 不会触发。GitLab 行为不变。

这是一个有工具和结构化输出的独立 Agent 工作流：读取 Issue → 在最近 100 个 Issue 中查找最多 5 个相似项 → 一次结构化模型分析 → 规则分类 → 持久化结果 → 发布评论与标签。它复用现有 PostgreSQL Run、Worker、租约、模型预算和发布账本，不增加服务、Redis、Kafka 或数据库密码。

## 用户会看到什么

Issue 下的 `AI Issue Triage` 评论包括总结、可行性、关键风险、建议行动、相似 Issue 和建议标签。分析基于 Issue 文本及有限的历史检索，不声称已经阅读代码、执行测试或确认根因；不会提交代码、关闭 Issue 或批准 PR。

分类使用确定性规则，允许 `bug`、`enhancement`、`documentation`、`security`、`performance`、`testing`、`has-similar-issue` 和 `ai-triaged`。自动添加其中**仓库已经定义**的标签，保留仓库原有标签。缺少的标签只列为建议，可以由仓库管理员预先创建；本版本不自动创建或删除仓库标签。最多读取三页、每页 100 个标签，不能证明枚举完整时只展示建议。

同一内容重复投递只创建一个 Run、预留一次预算。内容身份包含 Issue id、number、title、body、state，排除评论数量、标签和 `updated_at`，避免机器人自己的写入触发重复分析。修改内容会生成带版本标识的新评论，保留历史结果；改回已经分析过的相同内容会复用之前的 Run/评论。发布前再次检查当前内容和状态；旧内容已失效时停止发布。外部请求结果不确定时继续使用现有对账流程，不盲目重复写入。

## 配置和上线

全局开关默认开启：

```dotenv
FEATURE_ISSUE_TRIAGE=on
```

Web 与 Worker 使用相同值；Recovery 使用相同部署配置。根 Compose 已包含此项。Coolify 自定义 Compose 可以在 Web/Worker 共用的 environment 中加入 `FEATURE_ISSUE_TRIAGE: "on"`；无需添加新容器或新密码。新镜像启动前，原有 `database-init` 服务应用增量迁移 `033_issue_triage.sql`。保留现有数据库卷，不重建数据库。`/ready` 应显示 `capabilities.issueTriage: true` 并检查新 schema 和兼容 Worker 心跳。

GitHub App 需要订阅 **Issues** 事件并获得 **Issues: Read and write** 权限。权限已有时无需重装 App。安装同步完成且仓库绑定 active 后才开始处理新事件；安装与首个 Issue 同时发生的竞态，本版本不会像 PR 那样持久化等待事件。同步前被忽略的 Issue 可以在接入后通过编辑标题/正文触发，没有历史 Issue 自动回填。

仓库 `.pr-agent.yml` 或 `.pr-agent.yaml`：

```yaml
issue:
  enabled: true
  triageEnabled: true
  autoLabelEnabled: true
```

`issue.enabled: false` 或 `triageEnabled: false` 关闭分析，`autoLabelEnabled: false` 保留评论而不自动添加标签。存在配置文件本身不会关闭功能。配置读取失败或解析失败时停止接纳，避免误用默认策略产生费用。

另有数据库绑定级 `issueTriage` 能力，默认开启。管理员现有 `capabilities` 命令支持可选的 `--issue-triage on|off`；省略时保留原值。全局或绑定开关关闭后不接纳、不领取新工作，已获得租约或冻结的发布仍可能完成、对账和结算。要停止特定任务或仓库写入，请使用现有 Run cancel 或 authority drain/block。

暂停功能优先关闭开关并保留当前镜像的 Worker/Recovery 完成已有操作。旧镜像不认识普通 Issue 的新发布目标，存在未完成或结果未知的 Issue 操作时不要直接切回旧镜像。升级沿用现有排空/兼容 Worker 流程，保留数据库 schema；本功能不宣称旧镜像回滚兼容。

## 成本、运行记录与验证

每仓库每小时最多接纳 30 个新内容版本，每个 Issue 作者每小时最多 10 个；重复内容不计数。限流计数、Run/job 创建和预算预留在同一 PG 事务内，拒绝时全部回滚。超过限额的事件被正常响应并忽略，不自动延迟排队；需要窗口结束后的新事件。模型错误不会生成冒充成功分析的固定回复。

结构化结果保存在 `issue.triage.result` step output，遵循现有运行内容保留策略。受保护的 Run trace 提供状态、调用和 hash 元数据；用户阅读 Issue 评论即可获得结果。本版本 `/runs/:id/artifact` 对 Issue Run 返回 404，`rerun` 返回 409；不会误入 Deep Review 的产物读取或 PR 输入解析。

指标为 `pr_agent_issue_triage_intake_total`（admitted、duplicate、disabled、unmanaged、rate_limited）及 `pr_agent_issue_triage_execution_total`（model_failed、stale、published、resumed）。它们表示对应调用尝试的观察结果；真实发布恢复以现有 publication 审计/对账记录为准。

本地验证命令：

```sh
pnpm --filter backend check
pnpm --filter backend build
pnpm --filter backend test:build
pnpm --filter backend test
pnpm --filter backend test:harness:pg issues/issue-triage.pg.test.ts
```

Docker PG 测试使用本地 GitHub/模型 HTTP fixture，不调用真实模型或向真实仓库发布。上线后用已经接入的测试仓库新建 Issue，确认评论章节、已有标签、重复投递和编辑行为。真实模型建议质量需要独立人工验收；基础设施健康不代表分析质量。
