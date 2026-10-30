# Harness 运行、恢复与验证

数据库仍由根目录 `docker-compose.yml` 提供。API、Run worker、publication recovery 和周期保留分别运行在 `pr-agent`、`worker`、`recovery` 和 `maintenance` 容器中；PostgreSQL 是任务、执行权、事件、预算和外部写入事实的权威。当前没有跨服务消息投递需求，因此没有再引入 Redis、Kafka 或第二套任务队列。每个 API 实例都能从持久事件游标恢复 SSE；内存只负责本实例的连接分发。

## 按仓库暂停与恢复

Publication authority 管理能否发布；execution authority 管理评审调度。生产绑定固定使用持久异步执行，不支持运行时模式切换。两种 authority 仍分别排空，避免停止新任务时连正在执行的 Run 也无法完成发布。

对已完成 publication enrollment 的单个测试 integration，先运行 `inspect` 获取当前 version，再执行：

```sh
docker compose run --rm database-init node dist/agent-runtime/cli.js execution-drain \
  --tenant <tenant-uuid> --id <integration-uuid> --version <current-version> \
  --evidence '<verified rollout/change record>'
```

该命令只暂停指定绑定的新 intake，需要管理数据库角色和 version CAS，并记录操作者与证据。证据是管理员声明，不能替代真实部署和验收。

Draining 阻止新 intake 和普通 claim。已取得租约的 Run 可以完成冻结和发布；特殊人工恢复与发布结局处理可继续收敛。切换要求该绑定没有非终态 Run，也没有 `prepared/in_flight/unknown/manual_review` publication。待领取、重试、人工等待任务需要先处理或通过 Run API 取消；不能直接删除数据库记录。取消后的外部未知效果仍须对账。

如果需要撤销排空，执行 `docker compose run --rm database-init node dist/agent-runtime/cli.js execution-resume --tenant … --id … --version … --evidence …`。它恢复该绑定的异步 intake，不改变 execution generation。

dispatch 领取在同一数据库事务中校验异步模式和 generation。旧 sealed batch 被 Run 复用前，必须校验固定 SHA、关联唯一 Run 并提交 publication checkpoint。其他 Run 不能偷偷占用同一 batch。

## 状态诊断

```sh
docker compose run --rm database-init node dist/agent-runtime/cli.js metrics \
  --tenant <tenant-uuid> --id <integration-uuid>
```

输出各 Run 状态数量、到期可领取队列数量与最老等待时间、过期租约、未决 publication 和预算预留。统计使用固定字段，不把源码、评论、仓库路径或错误正文放入指标。这里提供状态快照，告警发送与监控平台仍由部署环境配置。

| 现象 | 检查与处理 |
| --- | --- |
| queued/retry_wait 长期不动 | 检查 execution state/generation、runtime hash、deadline 和队列等待时间；错误版本明确进入死信，修复后显式 rerun |
| running 租约过期 | 检查 Worker 与数据库连接；Sweeper 在有限尝试范围内接管，旧 epoch 无写回权 |
| waiting_for_reconciliation | 查看 operation 状态及恢复尝试；unknown 不直接重发 |
| waiting_for_user | 使用 snapshot 中的 wait/version/hash 提交明确决定；人工 API 不直接发布 |
| failed/cancelled 仍有外部未决效果 | 独立对账；所有关联 Run 已终结时管理员只能确认或放弃，不能重新授权写入 |
| pending budget | 保留未知费用，检查 provider usage；不要按零费用释放来强行放行 |
| SSE cursor 410 | 用返回的 snapshot 替换本地状态，再从 resumeCursor 接续 |

普通数据库语句超时为 15 秒，等待锁为 5 秒，空闲事务为 15 秒。迁移在自身事务内使用 5 秒锁等待和 2 分钟语句上限。数据库事务不跨 provider HTTP 调用；失败会回滚，不能用超长事务维持执行权。

## 内容保留

保留操作使用专用 `pr_agent_maintenance` 数据库角色。常驻进程默认每 60 秒执行一次有界扫描，每批默认 100、可配置范围 1–1,000；`preview` 是安全默认，不删除内容。只有显式设置 `HARNESS_MAINTENANCE_MODE=apply` 才执行保留删除。默认 30 天后清除 Run 内容和 replay payload，90 天后删除已清内容的 replay 行，400 天后才允许删除 trace/audit 行和严格符合条件的普通 Run 完整 FK 图；启动时强制 `7 <= content < replay < trace <= 3650`。

手动调查和执行使用同一个专用维护进程、受限数据库角色、全局有界策略与原子 cycle receipt；不存在按 tenant 绕过这些保护的管理员删除入口。未指定 `--action` 时一次性运行固定为安全的 `preview`：

```sh
docker compose run --rm maintenance node dist/agent-runtime/maintenance-process.js --once

docker compose run --rm maintenance node dist/agent-runtime/maintenance-process.js \
  --once --action apply --cycle-id <uuid>
```

Apply 会删除候选的旧事件前缀，清除 Run 输入、Step 内联输出、checkpoint、模型响应与工具结果引用；它是实际数据删除操作。非终态、外部效果未决、费用未决或仍有未释放 artifact hold 的 Run 被排除。Run 和关联 operation 加锁后再次检查；新 hold 也遵守 Run → artifact 的锁顺序，不能在内容清理完成后补建引用。

在内容窗口与 trace 窗口之间，Run 身份、版本、哈希、用量数值、命令回执和 publication 账仍用于去重与审计。公开 snapshot 的 `contentPurgedAt` 标明 Run 的内联内容已清理，rerun 返回 410，必须从源 PR 创建新的 review。压缩 artifact 按独立保留期清理：默认 30 天，hold 释放后继续保留 30 天，因此该字段不代表压缩存储已经即时擦除。事件 floor 与审计同事务推进。

超过 trace 窗口后，只有不存在子 Run、artifact/hold、未结算费用、活动或共享 publication identity、资格/Fix/Evolution 等强引用的普通 Run，才能连同完整 FK 图删除。这之后原幂等键不再被保留，同键新请求可创建新 Run。有资格证据、活动 hold 或当前 publication slot 的图不会被这一路径删除。

已退休且没有提案、评测或发布引用的数据集在 purge 事务内释放自己的 `dataset-case` holds。其他 Fix、Evolution、资格认定和法律保留引用必须先由对应生命周期显式解除，不能为了释放磁盘空间跳过引用检查。

Fix artifact hold 只会在提案 Run 结束并超过 content 窗口后自动释放，因此该窗口也是创建首次人工审批的最短保留期；仍有效的审批、未结束的发布子 Run 或未决发布操作会继续阻止释放。hold 一旦释放，系统会拒绝再为该提案创建新的审批。

此策略不删除 publication 的冻结 payload、外部平台评论或数据库备份，也不是“扫描全表并删除所有旧行”的全库擦除接口。它只领取到期且无 hold 的有界批次；备份保存期、磁盘加密、外部效果审计与平台内容删除需要部署方分别管理。

## 备份、恢复和前滚

### 旧 volume 角色升级

本节只适用于旧版以 `POSTGRES_USER=pr_agent_migrator` 首次创建、且数据库名为 `pr_agent` 的 volume。脚本不会自动运行。执行前必须完成数据库备份、验证可恢复性，并停止 `pr-agent`、`worker`、`recovery`、`maintenance`、隔离 verifier operator 和其他 writer。旧 schema 及其中对象必须仍由 `pr_agent_migrator` 拥有；如果不是，脚本会中止，不能用 `REASSIGN OWNED` 绕过人工复核。

先把 `.env.example` 中五个数据库密码替换为互不相同的随机值。然后从终端安全读取旧 migrator 密码；下列命令只把密码作为环境变量传入容器，不放在命令参数或 SQL 文件中：

```sh
docker compose stop pr-agent worker recovery maintenance
# 在 verifier 专用主机上另行执行：
docker compose -f docker-compose.verifier-operator.yml stop verifier-operator
docker compose up -d --no-deps postgres

read -rsp 'Current legacy pr_agent_migrator password: ' PGPASSWORD
export PGPASSWORD
printf '\n'
docker compose exec -T -e PGPASSWORD postgres \
  psql -X --no-psqlrc -v ON_ERROR_STOP=1 \
  -U pr_agent_migrator -d pr_agent \
  < docker/postgres/upgrade-runtime-roles.sql
unset PGPASSWORD

docker compose run --rm database-init node dist/agent-runtime/cli.js migrate
docker compose up -d pr-agent worker recovery maintenance
```

脚本先创建或轮换受密码保护的 `postgres` bootstrap 管理角色、`pr_agent_app`、`pr_agent_verifier` 和 `pr_agent_maintenance`，再为所有已有 FORCE RLS 表安装 schema-owner maintenance policy；最后在 `SET ROLE postgres` 后把 `pr_agent_migrator` 降为 `NOSUPERUSER NOBYPASSRLS NOCREATEROLE`。这样迁移 021 的数据回填发生在降权后，但仍受明确 owner policy 授权。脚本限定数据库名和 namespace owner，保留现有数据与对象所有权，可安全重复执行；任何前置条件不符都必须停止并调查。

迁移成功后检查 `docker compose ps`、`docker compose logs database-init` 和 `/ready`。不要删除 volume 来“修复”角色或迁移失败，也不要把 bootstrap 密码交给应用服务。

```sh
npm --prefix backend run test:harness:backup
```

演练脚本自行创建 PostgreSQL 17 Docker 容器和源/目标数据库，不接受现有数据库 URL，不读取 `.env`。它生成 custom-format dump，检查归档目录，向新数据库执行 `pg_restore --single-transaction --exit-on-error --no-owner --no-acl`，再运行迁移两次，核对代表性记录哈希、事件游标、checkpoint 与受限角色的 RLS。最后只移除自己的测试资源。

这是隔离恢复演练，不等于生产灾备已配置。真实部署需要定期备份、受保护的备份存储和恢复演习；集群角色不是普通 `pg_dump` 的内容。恢复账户/权限通过受控 bootstrap 建立，不盲目继承另一个环境的 owner/ACL。参考 [PostgreSQL 17 pg_dump](https://www.postgresql.org/docs/17/app-pgdump.html) 和 [pg_restore](https://www.postgresql.org/docs/17/app-pgrestore.html)。

已提交迁移有 checksum，升级只新增迁移。故障测试实际 SIGKILL 了执行未提交 DDL 的子进程，确认没有半套可见 schema，随后前滚和重复迁移成功。当前演练使用本项目构造的可信归档；未声称恢复了真实生产数据或所有历史部署版本。

## 故障矩阵

在 `backend` 中执行 `npm run test:harness:pg`。可追加 `tests/` 下的相对路径或唯一的 `*.pg.test.ts` 文件名进行定向验证。每个 suite 使用单独的 Docker 数据库。

| 故障/不变量 | 主要可执行证据 |
| --- | --- |
| 创建响应丢失、重复投递、同键异参 | `agent-runtime/run-store.pg.test.ts`、`http/api.pg.test.ts` |
| 双 Worker、旧 epoch、checkpoint 兼容 | `agent-runtime/run-execution.pg.test.ts` |
| 模型返回后/结果提交前进程死亡 | `agent-runtime/crash-recovery.pg.test.ts`：本地 HTTP provider + SIGKILL，旧费用保留、新 attempt 有界 |
| checkpoint 后、终态提交后进程死亡 | 同上：不重复已完成模型工作，终态不复活 |
| provider 写入响应丢失、明确失败、stale head | `agent-runtime/publication.pg.test.ts`、`agent-runtime/provider-reconciliation.test.ts`、`agent-runtime/batches.pg.test.ts` |
| cancel 与 finish 并发、死信重驱幂等 | `agent-runtime/crash-recovery.pg.test.ts`：重驱以新 Run + parent link 实现，原终态保留 |
| 人工决定版本竞争、权限撤销、重复 resume | `agent-runtime/run-commands.pg.test.ts`、`agent-runtime/control.pg.test.ts` |
| 多 coordinator、特殊 job 重试上限、终态外部观察 | `agent-runtime/publication-outcome.pg.test.ts` |
| 异步 drain/resume、迟到 freeze、原子 dispatch fence | `agent-runtime/execution-rollout.pg.test.ts`、provider replay 测试 |
| RLS 与连接复用、共享预算争抢 | Run store/query、model budget PG suites |
| SSE 补历史、隐藏事件游标、慢消费者与权限撤销 | `http/sse.test.ts`、API/query suites、容量工具 |
| retention 与 operation revive 并发 | `agent-runtime/maintenance.pg.test.ts` |
| 迁移中断与恢复 | crash suite、备份恢复演练 |

当前调度完全依赖 polling；没有启用 LISTEN/NOTIFY，因此不存在“丢失通知导致任务永久不执行”的依赖，也不把未实现的通知重连算作已验证功能。进程故障测试为缩短运行时间在隔离库中推进 lease 到期，随后调用实际 PG-clock sweeper/claim；这不等于测量了真实生产机器的最坏故障切换时间。

## 容量测量

```sh
npm --prefix backend run test:harness:capacity
npm --prefix backend run test:harness:capacity -- --qualification
```

Quick 用于工具冒烟；qualification 分别运行 4 worker/10,000 durable noop job、100 并发租户预算争用、1,000 SSE 连接与重连、20 请求/秒持续 600 秒及 100 请求/秒持续 30 秒的入队测试。突发段 50% 请求是重复键。各负载阶段依次执行，不是同时叠加。

Intake 使用真实 Nest HTTP、受限 PG 角色和本地 provider fixture；worker 阶段只执行 durable claim/terminal transaction，不运行 LLM 或完整评审。SSE 容量使用真实 HTTP 连接；确定性背压故障另外通过 scripted socket 注入。主机 Node 版本与结果写入报告，Docker 中的生产 Node 22 构建另行验证。测量不证明真实模型时延、长期 SSE 稳定性或生产硬件容量。

性能阈值与实际结果应一起审阅；首次测量或某个 `passed` 字段不能代替对阈值的核对。真实业务基线尚未提供，多 Agent 质量和 Evolution promotion 需要后续独立数据。

2026-10-29 隔离资格测试的[完整结果](../validation/capacity/p0d-capacity-qualified.json)：15,000 次入队请求零失败，P95 226.7ms（阈值 <250ms）；10,000 个 noop Run 在 106.174 秒内完成，claim P95 26.28ms，重复领取为零。100 个并发预算申请严格得到 50 个准入、50 个拒绝。SSE 连接与游标重连检查通过。

[首轮反例](../validation/capacity/p0d-capacity-first-counterexample.json)保留原始数据：入队 P95 278.62ms，未达到门限。该历史文件的 `passed: true` 来自当时遗漏延迟判定的验证器，已被作废；不能作为通过证明。修正判定后重新完整运行，得到上述资格测试结果。此结果仅适用于报告描述的隔离环境，不代表生产 SLO。
