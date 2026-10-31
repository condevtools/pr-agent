# Langfuse 可观测性与质量工作流

Langfuse 是可选的可观测与质量协作层。PostgreSQL 仍然是 Run、步骤、预算、Prompt 激活状态、同步任务、人工审核、发布和恢复的权威数据源；Langfuse 不参与调度、授权或发布判定。Tracing 故障不会改变业务 Run 的结果，质量同步任务则在 PostgreSQL 中保留状态并按受限重试策略执行。

当前接入面向 Langfuse Server `3.225.5`，Tracing 使用 `@langfuse/tracing` 与 `@langfuse/otel` `5.14.0`。项目中的 LLM-as-a-Judge 是 PR Agent 自己拥有、由 PostgreSQL 预算约束的 `eval.judge.v1` 工作流，不是 Langfuse v4 Managed Evaluator API。Server 升级到 4.59.0 之前不要直接把客户端升级到 Langfuse SDK 6。

## 能看到和操作什么

### Trace

一个被 Worker claim 的 Run attempt 对应一个 trace；同一 PostgreSQL Run 的重试通过 `sessionId=runId` 聚合。trace 包含：

- workflow、job 类型、attempt、最终状态和耗时；
- durable step，以及步骤是实际执行还是复用 checkpoint；
- Deep Review 的 `security`、`correctness`、`critic` Agent 执行；
- 每次真实发送到 OpenAI、OpenAI-compatible、Anthropic 或 Gemini 的物理模型请求；
- provider、model、request ID、token 用量、冻结价格策略下的成本和安全错误类型。

模型用量缺失时记录为 `unavailable`，不会伪造为零。Langfuse 的价格推断不能替代 PostgreSQL 预算账本。Publication、Recovery、普通数据库查询和框架 HTTP span 不会被伪造成 Agent 或 Tool。

### 五类质量工作流

1. **Managed Prompts**：13 个固定 `text` Prompt key 可以从 Langfuse 拉取、校验并由管理员激活。新 Run 在创建时冻结已激活版本；模型执行期间不访问 Langfuse。动态仓库上下文、JSON Schema 和工具定义仍由代码生成。
2. **Dataset export**：把 PostgreSQL 中冻结的 development/validation 数据集副本以稳定 identity 写到 Langfuse。holdout 内容永远不导出。
3. **Evaluation export**：把 PR Agent 已完成的离线 replay 结果链接到对应 trace，并导出确定性指标。它不会在 Langfuse 内重新执行模型。
4. **Human annotation**：把 trace 加入 Langfuse annotation queue，再把人工 score 拉回 PostgreSQL `pending_review` inbox。拉回的 score 默认不可信；必须由 `actorType=user` 的审核者完成显式 full-diff 审核后才能 promote 为内部标注；可信标签仍要求现有独立双人共识或仲裁。
5. **Budgeted Judge**：对一个成功且内容完整的 `review.deep.v1` 产物运行 `eval.judge.v1`，最多评估 20 个 finding，并复用 Run 预算、租约、checkpoint 和审计边界。Judge 指标是不可信度量，不会写入发布资格或可信标签；需要显式导出到 Judge 自己的 trace。

Managed Prompt reference 只附着在实际共享该 Prompt 的 LLM generation 上。一个 generation 最多把主 Prompt 显示为 Langfuse 原生 Prompt link，其余引用保留在 generation metadata；使用本地 fallback 时不会伪造远端链接。

## 功能与权限边界

Tracing 只需要 Worker 的 Langfuse tracing 配置。质量 API 和后台同步还需要一个带作用域的管理 principal；服务端只保存 bearer token 的 SHA-256 摘要，不保存明文 token。

| 能力 | API | CLI | 主要权限 |
|---|---|---|---|
| Prompt 列表/拉取/激活 | `GET /quality/prompts`、`POST /quality/prompts/pull`、`POST /quality/prompts/:id/activate` | `prompts list/pull/activate/bootstrap` | `quality:prompts:read`、`quality:prompts:approve`、`quality:sync:read`、`quality:sync:execute` |
| 数据集导出 | `POST /quality/exports/datasets` | `datasets export` | `quality:sync:execute`、`quality:sync:read` |
| 评测与 score 导出 | `POST /quality/exports/evaluations`、`POST /quality/exports/scores` | `evaluations export/scores` | `quality:sync:execute`、`quality:sync:read`、`evaluations:read` |
| 人工标注 | `POST /quality/annotations/queue|pull`、`GET/POST /quality/annotations/inbox/...` | `annotations queue/pull/inbox/reject/promote` | `quality:sync:execute`、`quality:sync:read`、`quality:annotations:review`；promote 还需要 `annotations:create` |
| Judge | `POST /quality/evaluators/judge`、`GET /quality/evaluators/judge/:id`、`POST /quality/exports/scores` | `judge run/get/export` | `quality:evaluators:run`、`runs:read`、`quality:sync:execute`、`quality:sync:read` |

同步任务通过 `GET /quality/jobs`、`GET /quality/jobs/:id` 和 `POST /quality/jobs/:id/retry` 查询或重试。Prompt 拉取/激活、同步任务入队、任务重试和 Judge admission 需要 `Idempotency-Key`；annotation inbox 的 reject/promote 使用内容哈希生成确定性命令 identity。

数据集、replay 和 Judge 依赖 Evolution 的数据与权限边界：必须同时设置 `FEATURE_EVOLUTION=on`，并在目标 repository binding 开启 Evolution capability。开启能力不会自动运行付费 Judge、创建数据集、启动 replay 或导出内容；这些操作仍需要带权限的显式 API/CLI 请求。

## 环境变量

| 变量 | 默认值 | 进程 | 说明 |
|---|---|---|---|
| `LANGFUSE_ENABLED` | `auto` | Web / Worker | Tracing：URL 和两个 key 完整时启用；`on` 表示要求启用；`off` 禁用 |
| `LANGFUSE_QUALITY_ENABLED` | `auto` | Web、Worker | 质量控制面：合法 URL 与 public key 完整时启用；Worker 同步还必须有 secret key |
| `LANGFUSE_BASE_URL` | 空 | Web、Worker | Langfuse origin，不附加 `/api/public` |
| `LANGFUSE_ALLOW_INSECURE_HTTP` | `false` | Web、Worker | 显式允许可信的 HTTP 部署；生产优先 TLS 或私有 Docker/VPN 地址 |
| `LANGFUSE_PUBLIC_KEY` | 空 | Web、Worker | 项目 public key，用于目标 identity；不是秘密 |
| `LANGFUSE_SECRET_KEY` | 空 | Worker | Tracing 和质量同步的项目 secret；只注入 Worker |
| `LANGFUSE_CAPTURE_CONTENT` | `off` | Worker | `off` 只传元数据；`redacted` 额外传有限长度、脱敏后的 Prompt/回答 |
| `LANGFUSE_TRACING_ENVIRONMENT` | Compose 为 `production` | Worker | Langfuse 环境筛选值 |
| `LANGFUSE_RELEASE` | 空 | Worker | 可选镜像 commit/tag |
| `HARNESS_API_PRINCIPALS_JSON` / `HARNESS_API_PRINCIPALS_FILE` | 空 | Web、Worker | Web 鉴权以及 Worker 对队列中 principal 快照的重新授权；二选一 |

`auto` 不等于绕过校验。Web 缺少 public 配置时质量 API 关闭；Worker 在质量功能已启用但缺少 secret key 时拒绝启动同步循环。Recovery 和 Maintenance 不需要任何 Langfuse key。

真实 key 只放在本地 `.env` 或 Coolify Runtime Secret，不写入 Compose、镜像或 Git。Coolify 单行值不要再包一层引号。`redacted` 会处理已知 secret 字段、私钥、常见 token 和当前进程已配置的秘密值，并限制深度与大小，但不能保证识别所有个人信息或业务机密。即使 capture 为 `off`，HTTP 仍携带项目凭据；公网 HTTP 必须显式设置 `LANGFUSE_ALLOW_INSECURE_HTTP=true` 并接受风险。

### Principal 示例

先在可信终端生成一次 token 和摘要，明文 token 只交给 CLI 操作者：

```bash
TOKEN="$(openssl rand -hex 32)"
TOKEN_SHA256="$(printf %s "$TOKEN" | shasum -a 256 | awk '{print $1}')"
```

把摘要写入 `HARNESS_API_PRINCIPALS_JSON`。下面的 UUID 必须替换成已激活 binding 的真实 tenant/integration；不要把 `$TOKEN` 写进服务端配置：

```json
[{"subjectId":"langfuse-quality-admin","actorType":"user","tenantId":"00000000-0000-4000-8000-000000000001","integrationId":"00000000-0000-4000-8000-000000000002","tokenSha256":"replace-with-sha256","permissions":["runs:read","annotations:create","evaluations:read","quality:prompts:read","quality:prompts:approve","quality:sync:read","quality:sync:execute","quality:annotations:review","quality:evaluators:run"]}]
```

若使用 `HARNESS_API_PRINCIPALS_FILE`，同一份文件必须只读挂载到 Web 和 Worker 的相同路径。不能同时配置 JSON 和 FILE。Worker 需要它来确认入队后 principal 没有被禁用、过期或撤权。

## Compose 与 Coolify

根 `docker-compose.yml` 已按最小权限分配变量：

- Web：quality mode、base URL、public key、transport policy 和 principal 配置；
- Worker：上述 public 配置、secret key、Tracing 配置和相同 principal 配置；
- Recovery/Maintenance：不接收 Langfuse key。

最小 `.env` 示例：

```dotenv
LANGFUSE_ENABLED=auto
LANGFUSE_QUALITY_ENABLED=auto
LANGFUSE_BASE_URL=https://langfuse.example.com
LANGFUSE_ALLOW_INSECURE_HTTP=false
LANGFUSE_PUBLIC_KEY=pk-lf-replace-me
LANGFUSE_SECRET_KEY=sk-lf-replace-me
LANGFUSE_CAPTURE_CONTENT=off
LANGFUSE_TRACING_ENVIRONMENT=production
LANGFUSE_RELEASE=sha-image-commit
HARNESS_API_PRINCIPALS_JSON=[{"subjectId":"langfuse-quality-admin","actorType":"user","tenantId":"replace","integrationId":"replace","tokenSha256":"replace","permissions":[]}]
```

Coolify 使用相同变量。public key 虽不是秘密，也建议作为 Runtime variable 管理；secret key 和 principal JSON 必须是 Runtime Secret，Build time 不需要。不要把 Langfuse secret 放进共享的 `x-review-environment`，否则 Recovery/Maintenance 也会收到它。

### 从没有质量表的现有部署升级

此次升级只需要新应用镜像、环境变量补丁和数据库迁移 `034_langfuse_quality.sql`、`035_langfuse_quality_runtime.sql`、`036_quality_retention.sql`；不需要 Redis、Kafka、新数据库容器或新 volume。

1. 备份现有 PostgreSQL，并保留 Coolify 当前 external volume 名称；不要删除或改名 volume。
2. 把同一个新镜像 ref 更新到 `pr-agent`、`worker`、`recovery`、`maintenance`、`database-init`。
3. 给 Web/Worker 增加上述变量，并让 Worker 获得与 Web 相同的 principal JSON 或只读文件。
4. Redeploy。`database-init` 应先执行并以 `0` 退出；随后 Web、Worker、Recovery、Maintenance 应为 healthy。
5. 检查 `/ready`、`database-init` 日志和 Worker 日志。迁移失败时调查原因，不要通过删除 PostgreSQL volume 重试。

这只是支持的升级步骤，不代表某个生产环境已经完成部署或真实模型质量验收。

## CLI 操作

CLI 调用 PR Agent 的受保护 API，不直接连接 PostgreSQL 或 Langfuse。先设置：

```bash
export PR_AGENT_API_URL=https://mr-agent.example.com
export PR_AGENT_API_TOKEN="$TOKEN"
```

根目录脚本可用时执行 `pnpm quality:langfuse ...`；等价的直接调用是：

```bash
pnpm --filter backend exec node --import tsx scripts/quality-langfuse.ts prompts list
```

常用示例：

```bash
# 把本地 13 个 v1 seed 创建/拉取到 Langfuse，等待 job 完成并逐个激活
pnpm quality:langfuse prompts bootstrap

# 导出 development/validation；holdout 不接受
pnpm quality:langfuse datasets export \
  --dataset-id <uuid> --split validation --manifest-hash <sha256> \
  --idempotency-key dataset-export-v1

# 导出评测 trace links 和确定性 scores
pnpm quality:langfuse evaluations export \
  --evaluation-id <uuid> --manifest-hash <sha256> \
  --idempotency-key evaluation-export-v1

# 送入人工队列，之后拉回 pending_review inbox
pnpm quality:langfuse annotations queue --source-run-id <uuid> --idempotency-key annotation-queue-v1
pnpm quality:langfuse annotations pull --source-run-id <uuid> --idempotency-key annotation-pull-v1

# 运行 app-owned budgeted Judge，查询结果，再把不可信指标导出到 Judge trace
pnpm quality:langfuse judge run \
  --source-run-id <deep-review-run-uuid> --artifact-hash <sha256> \
  --idempotency-key judge-v1
pnpm quality:langfuse judge get --id <judge-run-uuid>
pnpm quality:langfuse judge export --id <judge-run-uuid> --idempotency-key judge-export-v1

# 查看异步同步任务
pnpm quality:langfuse jobs list --status dead_letter
pnpm quality:langfuse jobs get --id <job-uuid>
```

`prompts bootstrap` 需要 API、Worker、Langfuse 和 principal 权限都已就绪；它会产生远端写入。它不会调用模型。其他 export 命令也只同步既有不可变结果，不会触发外部模型调用；只有显式 `judge run` 会进入预算受控的模型工作流。

## 验证与停用

部署前可运行 tracing 合成 smoke：

```bash
pnpm test:langfuse:smoke
```

它使用本地物理模型 fixture 验证 trace 层级、token 和成本，不调用真实 GitHub、PostgreSQL 或付费模型；但会使用项目 key 把 smoke trace 写到 Langfuse 并回读验证。随后用一个非敏感测试 PR/Issue 验证真实 Worker trace，再分别用 CLI 验证 Prompt list、一个 development/validation export、annotation pending-review 流程和 Judge 的显式运行/导出。

停止 tracing 和依赖 trace 的质量功能：设置 `LANGFUSE_ENABLED=off`，并将 `LANGFUSE_QUALITY_ENABLED` 设为 `auto` 或 `off`（显式 `on` 会报告配置冲突）。只停质量控制面、保留 tracing：设置 `LANGFUSE_QUALITY_ENABLED=off`。两者都停用不会删除 PostgreSQL 数据，也不会改变普通评审、发布或恢复；Worker 停机时仍会先 drain 已执行的 Run，并在有限时间内 flush tracing。


## 同步与数据保留

同步任务按仓库串行领取，带租约续期、超时、指数退避和人工重试。人工评分按本项目创建的队列和评分配置筛选，分页游标作为持久续传任务保存。实验按 baseline/candidate 与重复次数分别命名，避免同一数据项覆盖另一轮实验。

迁移 036 将质量表接入现有维护进程：preview 只计数；apply 才按已有 content/replay/trace 保留周期，分批清理候选 Prompt、终态同步任务、过期标注和无引用 trace 关联。Run 内冻结的 Prompt 不依赖候选记录继续存在。

工程验收记录见 [Langfuse quality verification](../validation/engineering/langfuse-quality-verification.json)。合成数据集 `pr-agent-integration-smoke-20261031-v1` 仅用于连通性检查；人工标注队列仍需要真实人员填写，不能把该数据集或应用内 Judge 输出当作已校准的质量结论。
