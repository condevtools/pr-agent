# PostgreSQL publication harness

PostgreSQL 由根目录现有 `docker-compose.yml` 管理，无需在宿主机安装数据库。当前实现覆盖 P0a 的发布持久化、恢复和权限切换；评审分析仍沿用现有执行流程。它还不是完整的 durable Run worker、多 Agent、FixRun 或 EvolutionRun。

## 启动与账户

```sh
docker compose up -d --build
```

- `postgres`：PostgreSQL 17，持久卷 `harness-postgres`，仅 Compose 内网可访问，无宿主机数据库端口。
- `harness-migrate`：迁移账户 `pr_agent_migrator`，事务执行带校验和的迁移，授予运行账户最小权限。
- `pr-agent`：等待数据库健康和迁移成功，以 `pr_agent_app` 连接；启动时拒绝超级用户或绕过 RLS 的账户。

保留原有 GitHub/GitLab 环境配置和 GitHub App 私钥文件要求。部署前在 `.env` 设置不同的 `HARNESS_APP_PASSWORD`、`HARNESS_MIGRATION_PASSWORD`；Compose 默认值仅供本地开发。初始化 SQL 只在首次创建数据卷时执行，修改环境变量不会轮换已有数据库密码。`docker compose down` 保留数据卷，不要用删除卷的方式升级或处理迁移失败。

在线入口强制使用 PostgreSQL 发布权威，Compose 固定 `HARNESS_PUBLICATION_MODE=postgres`。`legacy` 仅用于隔离测试；不能靠修改 `NODE_ENV` 或运行中切换环境变量绕过在线入口已锁定的发布边界。数据库配置只读取 `HARNESS_DATABASE_URL` 或 `HARNESS_PG_*`，不继承其他服务的 `DATABASE_URL`。

## 注册并启用仓库

新绑定默认为 `blocked`。绑定由管理员维护，Webhook 不能提供或改变 tenant、发布身份和凭证引用。以下 UUID、仓库和数值 ID 是示例，需要替换为已核实的目标：

```sh
docker compose run --rm harness-migrate node dist/harness/cli.js bind \
  --tenant 11111111-1111-4111-8111-111111111111 \
  --id 22222222-2222-4222-8222-222222222222 \
  --platform github --origin https://api.github.com --repository owner/repo

docker compose run --rm harness-migrate node dist/harness/cli.js configure \
  --tenant 11111111-1111-4111-8111-111111111111 \
  --id 22222222-2222-4222-8222-222222222222 \
  --repository-id 123 --actor-id 456 --credential-ref env:GITHUB_TOKEN --version 0
```

`repository-id` 是 GitHub repository / GitLab project 的不可变数值 ID；`actor-id` 是实际发布用户或 App bot 的数值 ID，不能用 App ID 代替 bot user ID。支持的凭证引用为 `env:GITHUB_TOKEN`、`env:GITHUB_WEBHOOK_TOKEN`、`env:GITLAB_TOKEN`、`github-app:<installation-id>`。数据库只保存引用，不保存 token。GitLab 发布也从服务端绑定重新解析凭证，不使用请求方提交的 token。

GitHub 用户 token 在发布前用 `/user` 验证实际身份；App 凭证从指定 installation 获取，并验证认证 App、installation 的归属/状态以及 `slug[bot]` 对应的 bot user。GitLab 验证 `/user`。凭证目的地必须匹配服务端 `GITHUB_API_URL` / `GITLAB_BASE_URL`。身份或仓库不匹配时停止发布。

切换前先实际停止旧版本发布实例，等待在途请求结束，并确认旧实例不会被自动重启。PostgreSQL 的 generation 无法约束不读取数据库的旧二进制程序；填写凭据或切换标记不能替代这一步。核实停止证据后激活：

```sh
docker compose run --rm harness-migrate node dist/harness/cli.js authority \
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
docker compose run --rm harness-migrate node dist/harness/cli.js inspect \
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
docker compose run --rm -v "$PWD/control.json:/run/control.json:ro" harness-migrate \
  node dist/harness/cli.js control --input-file /run/control.json
```

人工证据是有数据库管理权限者的声明，**不是自动经过提供方验证的证明**。CLI 忽略调用者传入的 actor，审计记录实际数据库角色；不要把迁移账户交给普通应用调用者。自动 reconciler 另行执行提供方证据校验。

- `confirm_occurred`：提供远端 ID 和实际 revision，记录 current/stale。
- `confirm_not_occurred`：调查后确认未发生，仍停留在人工处理，不自动发起写入。
- `authorize_retry`：另一次命令，使用最新 version、相同业务操作和冻结 payload；实际已发出过请求时至少冷却 2 分钟，最多 3 次 dispatch。
- `abandon_publication`：终止未决发布，不删除已有远端效果。

命令有持久 receipt；同 key 同参数返回原结果，同 key 异参数冲突。新命令不得覆盖仍在执行或被有效恢复租约占用的操作。取消/放弃不代表撤销已经发生的外部效果。

## 验证、升级与后续范围

```sh
npm --prefix backend run check
npm --prefix backend run build
npm --prefix backend test
npm --prefix backend run test:harness:pg
docker compose config --quiet
```

PG 测试命令自行创建隔离 Docker 容器、随机本地端口和密码，按 suite 创建独立 `harness_test_*` 数据库，结束时只删除该次测试资源。它不读取 `.env` 或复用开发数据库。普通测试中的 PG skip 不代表数据库测试通过，必须单独运行 Docker PG 测试。

`docker compose run --rm harness-migrate` 可以重复验证/应用迁移。已应用 SQL 有校验和保护；未来变更必须新增迁移，不能修改历史文件。升级前备份并验证恢复，回滚服务也必须保留同一发布账和权限协议，不能回到裸写旧版本。

P0b/P0c 后续补齐 Run lease/heartbeat/checkpoint、预算、异步评审 worker、Run 控制 API 和 SSE。P1 再加入证据驱动的多 Agent 评审；FixRun 保持独立权限域和验证/审批流程；EvolutionRun 作为离线评测与候选改进控制面。当前不引入 Redis/Kafka：PG 已承担持久事实和恢复协调，暂没有证明需要额外队列的容量数据。不能据本阶段宣称 Harness 49 项全部达标或自动修复、自我演化已上线。
