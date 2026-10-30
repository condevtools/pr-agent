# Agent Runtime：PostgreSQL 持久执行与发布

PostgreSQL 由根目录现有 `docker-compose.yml` 管理，无需在宿主机安装数据库。当前实现覆盖发布持久化、Run worker、checkpoint、模型预算，以及 Run API、命令回执、SSE 和发布结局恢复。生产评审统一使用持久异步执行；API 鉴权、路由和人工恢复契约见 [run-api.md](run-api.md)。

Single、Deep、Fix 和 Evolution 的启用条件、绑定配置与 `/ready` 探针见 [capabilities.md](capabilities.md)。普通 PR 默认 Single，Fix 和 Evolution 默认关闭。

## 启动与账户

```sh
docker compose up -d --build
```

- `postgres`：PostgreSQL 17，持久卷 `harness-postgres`，仅 Compose 内网可访问，无宿主机数据库端口。
- `database-init`：一次性迁移容器，以 `pr_agent_migrator` 事务执行带校验和的迁移；该角色必须由首次数据库 bootstrap 创建为 schema owner，且必须是 `NOSUPERUSER NOBYPASSRLS`。
- `pr-agent`：等待数据库健康和迁移成功，以 `pr_agent_app` 连接；启动时拒绝超级用户或绕过 RLS 的账户。

保留原有 GitHub/GitLab 环境配置和 GitHub App 私钥文件要求。部署前必须在 `.env` 设置四个互不相同的随机密码：`HARNESS_BOOTSTRAP_PASSWORD`、`HARNESS_MIGRATION_PASSWORD`、`HARNESS_APP_PASSWORD`、`HARNESS_VERIFIER_PASSWORD`；Compose 不提供默认值。`.env` 只用于 Compose 插值，`pr-agent` 不会整体加载该文件，而是通过 `docker-compose.yml` 的显式白名单接收运行配置，因此拿不到 bootstrap、migrator 或 verifier 密码。初始化 SQL 只在首次创建空数据卷时执行，创建受限的 migrator、app、verifier 角色；修改环境变量不会轮换已有数据库密码。`docker compose down` 保留数据卷，不要用删除卷的方式升级或处理迁移失败。

全新部署复制 `.env.example`、替换四个密码及平台凭据后执行 `docker compose up -d --build`。`postgres` 健康后，`database-init` 必须成功退出，`pr-agent` 才会启动。可用 `docker compose ps` 和 `docker compose logs database-init` 核对结果。不要把 bootstrap 密码配置给应用或 verifier。

如果现有 volume 来自旧版 `POSTGRES_USER=pr_agent_migrator`（该角色仍为超级用户），不能直接启动新 `database-init`，也不能删除 volume。先备份并停止所有 writer，再按 [旧 volume 角色升级](operations.md#旧-volume-角色升级) 显式执行 `docker/postgres/upgrade-runtime-roles.sql`；脚本在迁移 021 之前安装 FORCE RLS owner policy，随后才降权 migrator。所有权或目标数据库不符合预期时脚本会中止，要求人工复核。

在线入口和集成测试统一使用 PostgreSQL 发布权威，Compose 固定 `HARNESS_PUBLICATION_MODE=postgres`。旧的 legacy 发布模式已移除。数据库配置只读取 `HARNESS_DATABASE_URL` 或 `HARNESS_PG_*`，不继承其他服务的 `DATABASE_URL`。

## 注册并启用仓库

新绑定默认为 `blocked`。绑定由管理员维护，Webhook 不能提供或改变 tenant、发布身份和凭证引用。以下 UUID、仓库和数值 ID 是示例，需要替换为已核实的目标：

```sh
docker compose run --rm database-init node dist/agent-runtime/cli.js bind \
  --tenant 11111111-1111-4111-8111-111111111111 \
  --id 22222222-2222-4222-8222-222222222222 \
  --platform github --origin https://api.github.com --repository owner/repo

docker compose run --rm database-init node dist/agent-runtime/cli.js configure \
  --tenant 11111111-1111-4111-8111-111111111111 \
  --id 22222222-2222-4222-8222-222222222222 \
  --repository-id 123 --actor-id 456 --credential-ref env:GITHUB_TOKEN --version 0
```

`repository-id` 是 GitHub repository / GitLab project 的不可变数值 ID；`actor-id` 是实际发布用户或 App bot 的数值 ID，不能用 App ID 代替 bot user ID。支持的凭证引用为 `env:GITHUB_TOKEN`、`env:GITHUB_WEBHOOK_TOKEN`、`env:GITLAB_TOKEN`、`github-app:<installation-id>`。数据库只保存引用，不保存 token。GitLab 发布也从服务端绑定重新解析凭证，不使用请求方提交的 token。

GitHub 用户 token 在发布前用 `/user` 验证实际身份；App 凭证从指定 installation 获取，并验证认证 App、installation 的归属/状态以及 `slug[bot]` 对应的 bot user。GitLab 验证 `/user`。凭证目的地必须匹配服务端 `GITHUB_API_URL` / `GITLAB_BASE_URL`。身份或仓库不匹配时停止发布。

切换前先实际停止旧版本发布实例，等待在途请求结束，并确认旧实例不会被自动重启。PostgreSQL 的 generation 无法约束不读取数据库的旧二进制程序；填写凭据或切换标记不能替代这一步。核实停止证据后激活：

```sh
docker compose run --rm database-init node dist/agent-runtime/cli.js authority \
  --tenant 11111111-1111-4111-8111-111111111111 \
  --id 22222222-2222-4222-8222-222222222222 \
  --action activate --version 1 --evidence 'deployment/change record confirming previous publishers stopped and drained'
```

`configure`、`authority` 输出最新 version；后续命令必须使用该值。激活递增 publication generation，审计身份来自 PostgreSQL `current_user`。quiescence evidence 是管理员声明，需要对应真实的部署记录；系统不会自动证明外部旧实例已经停止。

停止接收新发布意图使用 `authority --action drain --version <current>`；已冻结的操作继续恢复。只有不存在 `prepared/in_flight/unknown/manual_review` 时才允许 `block` 或重新 `activate`。重新激活需要新的停止证据并递增 generation。运行账户无权修改绑定。

## 发布、重放与恢复

GitHub/GitLab review 先生成完整输出，再在一个事务内冻结有序 batch、原始 payload、revision、source key/hash 和所有业务操作。数据库封存批次成员，不能在发布后追加或替换输出。相同来源的重放先加载原批次，再决定是否需要分析；已经冻结的输出不会重新调用模型生成。

每个外部写入先持久化操作并取得 slot 执行权，再允许 HTTP。底层 GitHub REST、原生 Octokit 和 GitLab HTTP 拒绝无执行权的写入。前序失败只跳过本批次的后续动作；其他批次共享的相同业务操作不会被误取消。

网络超时、响应丢失等结果进入 `unknown`，不会直接重发。独立恢复循环在服务启动后运行，每 5 秒轮询；数据库原子 claim、版本和到期时间防止重复接管。恢复次数在领取时持久化，进程崩溃也会消耗次数；默认最多 5 次后进入 `manual_review`，而不是无限重试。每次扫描、分页和重试都有上限。

对账校验远端仓库/目标、作者、完整规范化内容以及行评论位置；marker 只用于定位。托管评论更新还要求远端旧内容与冻结指纹一致。分页不能确认已结束、身份不符或证据不完整时保留不确定结果。HEAD 移动后发现的旧发布记录为 stale，不作为当前 revision 成功。

提供方读取与写入不是一个原子事务，最后一次检查后仍可能发生外部并发修改。这里保证本系统稳定的操作身份、unknown 不盲重发和可对账；不承诺任意网络时序下的全局 exactly-once，也不能用数据库锁消除提供方不支持的远端 CAS 竞争。

当前已接入 summary、managed comment、inline comment 和 labels。labels 按目标状态收敛，不伪称能证明具体作者。尚未接入操作账的命令、策略写入、`/implement` 和外部通知在 durable 路径被阻止或抑制；部分“命令未启用/限流”回复因此只记录错误，不另发绕过账本的评论。不要用 legacy 模式恢复这些写入。

## 人工处理不确定结果

```sh
docker compose run --rm database-init node dist/agent-runtime/cli.js inspect \
  --tenant 11111111-1111-4111-8111-111111111111 \
  --id 22222222-2222-4222-8222-222222222222
```

`inspect` 输出绑定和最近 100 个操作的状态、version、远端 ID。人工决定使用 JSON 文件，例如：

```json
{
  "tenantId": "11111111-1111-4111-8111-111111111111",
  "businessOperationId": "replace-with-inspected-operation-id",
  "expectedVersion": 5,
  "commandKey": "incident-123-confirmation-1",
  "decision": "confirm_occurred",
  "remoteId": "789",
  "evidence": {
    "kind": "provider_confirmation",
    "reference": "provider record or investigated incident reference",
    "actualRevision": "verified-head-sha"
  }
}
```

```sh
docker compose run --rm -v "$PWD/control.json:/run/control.json:ro" database-init \
  node dist/agent-runtime/cli.js control --input-file /run/control.json
```

人工证据是有数据库管理权限者的声明，**不是自动经过提供方验证的证明**。CLI 忽略调用者传入的 actor，审计记录实际数据库角色；不要把迁移账户交给普通应用调用者。自动 reconciler 另行执行提供方证据校验。

- `confirm_occurred`：提供远端 ID 和实际 revision，记录 current/stale。
- `confirm_not_occurred`：调查后确认未发生，仍停留在人工处理，不自动发起写入。
- `authorize_retry`：另一次命令，使用最新 version、相同业务操作和冻结 payload；实际已发出过请求时至少冷却 2 分钟，最多 3 次 dispatch。
- `abandon_publication`：终止未决发布，不删除已有远端效果。

命令有持久 receipt；同 key 同参数返回原结果，同 key 异参数冲突。新命令不得覆盖仍在执行或被有效恢复租约占用的操作。取消/放弃不代表撤销已经发生的外部效果。

关联非终态 Run 的操作必须经过 Run API 的 `resume`、一次消费的 wait 和 leased Worker，不能用上述独立 CLI 跳过执行权。所有关联 Run 都已终结时，CLI 只允许确认或放弃剩余未知结果，禁止 `authorize_retry`；再次执行需要新 Run。

## 异步 Run 与模型预算

`integration_bindings.review_execution_mode` 固定为 `harness_async`。需要暂停新评审时使用 execution drain，恢复时使用 execution resume；不要直接修改表来绕过排空和 generation 检查。操作步骤、保留策略、备份演练及故障证据见 [operations.md](operations.md)。

异步入口在确认签名、服务端仓库绑定和不可变 base/head SHA 后，同一事务保存 Run、初始 Event、Job、审计和预算 envelope，再返回 Run ID。输入只保存评审所需字段，凭证由 Worker 从服务端绑定重新解析。重复来源复用 Run，跨实例并发领取由 PostgreSQL Run lease 和单调 epoch 仲裁；Job 不另持有第二套租约。

Worker 每秒轮询，租约 60 秒、每 15 秒续租、每 5 秒清扫；过期和 deadline 使用 PostgreSQL 时钟。首版每 Run 最长 15 分钟、最多 3 次 Job/Step attempt。收集结果、模型结果及 publication-frozen checkpoint 持久化，恢复已完成 Step 不重复调用模型。发布 batch、Run 关联和 publication-frozen checkpoint 在同一事务封存。网络请求不持有数据库事务。

模型调用必须先有明确的 `HARNESS_MODEL_PRICING_JSON`。它包含 `version`、`currency`、`tenantLimits`、`runLimits` 和按 `provider:model` 索引的 `models`。两类 limits 都包含 `inputTokens`、`outputTokens`、`costMicros`；每个 model 包含 `rates`、`maxOutputTokens`、`maxPhysicalCallsPerStep`，OpenAI 兼容服务还需显式 `openAiTokenParameter`（`max_completion_tokens` 或 `max_tokens`）。`rates` 包含以下每百万 token 的微货币单位费率，必须根据实际供应商合同配置，不从模型输出或请求中读取：

- `inputMicrosPerMillion`
- `cachedInputMicrosPerMillion`
- `cacheWriteInputMicrosPerMillion`
- `outputMicrosPerMillion`
- `thoughtOutputMicrosPerMillion`
- `toolInputMicrosPerMillion`

Run 入队先预留 tenant envelope，每次物理调用再从该 envelope 预留。供应商原始 usage 与统一账分开保存，缓存和推理 token 按供应商口径处理。已知结果可复用；响应丢失、无 usage 或无法证明未计费时保留费用预留，不按零费用结算。终态预算维护只释放尚未分配额度；未知调用在等待窗口后按已预留上限保守结算，并保留未知调用事实。拿到供应商实际用量后，通过受保护的 usage reconciliation API 以版本 CAS 做幂等差额更正。Run 入队时冻结 UTC 月账期和价格快照，跨月更正记回原账期；配置变化只影响新 Run。测试专用零费用开关同时要求 `NODE_ENV=test` 和 `HARNESS_ALLOW_ZERO_COST_MODEL_POLICY=isolated-test-only`。

Durable 模式关闭 SDK/HTTP 隐藏重试；兼容回退也计为独立物理调用。完整源码 hash 用于审计；执行兼容性按工作流、步骤、生产依赖及任务冻结的模型策略判定。不兼容 Worker 不会领取、删除或终结别人的任务，任务等待兼容执行者；不会自动清空 checkpoint 重跑。编译时生成 `dist/agent-runtime/runtime-manifest.json`，缺失时拒绝执行。

## 验证、升级与后续范围

```sh
npm --prefix backend run check
npm --prefix backend run build
npm --prefix backend test
npm --prefix backend run test:harness:pg
docker compose config --quiet
```

PG 测试命令自行创建隔离 Docker 容器、随机本地端口和密码，按 suite 创建独立 `harness_test_*` 数据库，结束时只删除该次测试资源。它不读取 `.env` 或复用开发数据库。普通测试中的 PG skip 不代表数据库测试通过，必须单独运行 Docker PG 测试。

`docker compose run --rm database-init node dist/agent-runtime/cli.js migrate` 可以重复验证/应用迁移。已应用 SQL 有校验和保护；未来变更必须新增迁移，不能修改历史文件。升级前备份并验证恢复，回滚服务也必须保留同一发布账和权限协议，不能回到裸写旧版本。

当前提供 Run 控制 API、SSE、发布结果回流及显式启用的多 Agent Deep Review。Fix 保持独立权限域和验证/审批流程；Evolution 提供反馈、离线评测与候选策略控制面，两者默认关闭。PG 承担持久事实和恢复协调，当前没有额外引入 Redis/Kafka。能力开关和架构测试不代表真实模型质量已通过验收，也不代表已覆盖 Harness 原课全部 49 项能力。

多 Agent 深审的创建、证据门和 shadow 报告见 [deep-review.md](deep-review.md)。

## 调度、产物与资源上限

Worker 按 PG 中保存的游标轮转有到期工作的仓库绑定，每轮每个绑定最多领取一个任务。游标由多个 Worker 共享，不依赖进程内数组的位置；任务最终仍经过兼容性、能力、权限 generation 和 lease 检查。不兼容或关闭的能力不会因此被强行执行。

默认每个 Worker 进程最多执行 4 个任务，同一绑定跨 Worker 最多执行 2 个任务。发布结局和人工恢复任务共享最多 1 个特殊槽位；普通任务可以借用空闲槽位。公平性表示空闲槽位出现时持续可运行的绑定获得领取机会，不表示长任务有固定完成时限。多个 Worker 的总容量随进程数变化，不能把每进程 4 个槽位解释为集群总共 4 个槽位。

`HARNESS_WORKER_CONCURRENCY`、`HARNESS_WORKER_PER_BINDING_CONCURRENCY`、`HARNESS_WORKER_SPECIAL_CONCURRENCY` 和 `HARNESS_RECOVERY_BINDING_PAGE_SIZE` 在启动时校验并固定。Web、Worker、Recovery 的连接池分别由 `HARNESS_WEB_POOL_MAX`、`HARNESS_WORKER_POOL_MAX`、`HARNESS_RECOVERY_POOL_MAX` 控制，默认 8、8、4。调整这些值需要考虑副本数与 PostgreSQL 的连接上限。

步骤产物使用 PG 压缩内容存储和 SHA-256 引用，读取时校验 tenant、integration、Run、大小和内容 hash。单份产物最多 32 MiB 原始数据、8 MiB 压缩数据，同一个 Run 最多保存 128 MiB 原始产物。旧版 inline checkpoint 保留读取兼容；新产物不会再把完整输出重复写进 checkpoint。

只有评审上下文收集可以按确定规则省略尾部完整文件，并在覆盖范围中记录 partial、规则、保留数量与未覆盖路径。控制状态、审批材料、预算事实、发布结果和 Fix 验证输入不会被截断；无法安全容纳时明确失败。产物丢失或 hash 不符也会明确失败，不把缺失内容当作空评审。

产物默认保留 30 天；正在执行的 Run、未确定的发布/预算结果，以及 Fix、Evolution、资格认定等显式引用会延长保留期。Run retention 遇到任何未释放的产物 hold 时会保留整个 Run，不能出现来源内容已经清理但强引用仍宣称可读的状态。已退役且确认未被提案、评测或发布资格引用的数据集在清理时，只释放自己创建的 `dataset-case:<dataset-id>:<case-id>` hold；其他资格、Fix、Evolution、法律保留等 hold 不会被顺带释放。完整 hold 生命周期和自动维护调度仍属于后续维护阶段。解除引用后还保留 30 天。内容清理保留 hash 和元数据，防止把已清理内容误认为可用。应用账户没有直接 UPDATE/DELETE 产物的权限；当前清理器由受控维护过程调用，尚未接入自动周期调度。

Worker/Recovery 心跳的 `capability_report.databaseTiming` 记录固定维度的数据库测量：租户预算锁定查询、步骤提交事务和 lease 心跳。每项包含次数、错误数、总耗时、最大耗时及固定区间计数，且不记录 SQL、token 或仓库内容。耗时包含 SQL 执行和通信时间，不能直接当作纯锁等待时间。这些测试验证并发与资源边界，不代表已经完成生产吞吐量测试。
