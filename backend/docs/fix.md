# P2 FixRun：受控修复

P2 实现了独立的修复建议、隔离验证、人工相关性标注和审批后的 GitHub Draft PR。默认不发布：没有真实 50 case / 10 repository 资格证据时，策略必须保持 `publishEnabled=false`。本仓库测试证明机制与故障处理，不证明真实修复质量达标。

## 实际执行路径

1. `POST /runs/:reviewRunId/fixes` 从同 tenant/integration、成功 deep review 中被 gate 接受的 finding 创建 `fix.propose.v1`。请求体仅 `{findingId}`，需要 `Idempotency-Key` 和 `fixes:create`。策略来自服务端，调用者不能提供命令、镜像或工具权限。
2. Intake 检查当前 revision，收集固定 SHA 的有界普通文件快照。敏感路径、链接、二进制、截断树和超限结果拒绝。快照按内容寻址；入库和 GC 使用同一 advisory lock。
3. Fix 模型最多两次修订，只能更改 finding 对应源码并新增测试。依赖、脚本、配置、既有测试等不可改。模型调用使用现有共享限流与 PG 预算。
4. 主 Run 保持唯一执行 lease，等待单独的 verifier job。外部 verifier 仅拥有该 job 的 lease；崩溃后可接管，旧 epoch 无权完成。主 Run 将结果作为 durable Step 提升到不可变 verification。
5. 四阶段各在独立容器运行：baseline+test、patched+同一 test、baseline regression、patched regression。首版仅支持服务端固定的 `node --test`，要求目标 fail→pass、四阶段实际执行测试、两组 regression 均 PASS。零测试、超时、缺模块、非 TAP 崩溃不能通过。日志仅留哈希，失败名称只留哈希；原始日志不持久化。
6. 技术结果始终保留自动 relevance `unknown`。另一名授权 actor 对确切 finding、proposal、test patch 和 verification hash 提交人工相关性 receipt；该 receipt 不能覆盖技术失败。
7. Proposal maker 创建审批预览，另一 actor 审批，事务内创建唯一 `fix.publish.v1` child。审批绑定不可变 ordered operation plan；生成后不改补丁。过期审批可创建新 generation，历史保留。
8. GitHub 的 branch→commit→Draft PR 整批先冻结，再在同一事务内消费审批并关联 child Run。每次实际写入再次检查消费记录与精确 operation set。commit 使用 GraphQL `expectedHeadOid`；Draft 的目标是原 PR 的 head branch。每次写后核验远端事实。响应丢失/结果不一致进入只读对账，不能自动重发。

GitLab FixRun 可生成建议，但发布明确禁用。其 [Commit API](https://docs.gitlab.com/api/commits/) 没有此实现可依赖的分支 expected-head 条件写入；`start_sha` 不能当作 CAS。GitHub 使用官方 [createCommitOnBranch](https://docs.github.com/en/graphql/reference/mutations#createcommitonbranch)。fork/cross-repository 发布也拒绝。Harness 模式下旧 `/implement` 被禁用。

## API 与权限

| 操作 | 接口 | 权限 |
|---|---|---|
| 创建建议 | `POST /runs/:reviewRunId/fixes` | `fixes:create` |
| 读取建议 | `GET /runs/:fixRunId/artifact` | `runs:read`；`raw=true` 还需 `runs:trace` |
| 人工相关性 | `POST /runs/:fixRunId/fix-relevance` | `fixes:approve`，禁止 maker 自证 |
| 创建审批预览 | `POST /runs/:fixRunId/fix-approvals`，body `{}`，Idempotency-Key | `fixes:create`，proposal maker |
| 审批 | `POST /runs/:fixRunId/fix-approvals/:approvalId/approve` | `fixes:approve`，maker≠checker |
| 撤销 | 同一路径 `/revoke` | `fixes:revoke` |

相关性 body：`commandKey, proposalId, proposalHash, testPatchHash, findingId, verificationResultHash, rubricVersion, reason`。审批/撤销 body：`commandKey, intentHash, expectedVersion`。撤销先于消费则 freeze 全事务回滚；消费先发生则撤销冲突。取消 Run 可阻止尚未派发的后继操作，不能撤回已发送 HTTP。审批跨 runtime 版本时返回冲突，需创建新 proposal。

## Docker 配置

PostgreSQL 已在根 `docker-compose.yml`。一次性 `database-init` 使用受限的 `pr_agent_migrator` 管理迁移和版本化最小授权；四个数据库角色密码都必须显式配置。旧 volume 不能由迁移 CLI 自动改变角色，必须先按 [旧 volume 角色升级](operations.md#旧-volume-角色升级) 执行显式 bootstrap。普通 web、worker、recovery 部署没有 Docker socket，也不部署 verifier。

构建 sandbox：`docker build --target verifier-sandbox -t pr-agent-fix-sandbox .`。通过 `docker image inspect pr-agent-fix-sandbox --format '{{.Id}}'` 获取不可变 image ID，在服务端 policy 使用该 SHA-256。镜像必须预先存在，运行时 `--pull never`。另行构建 operator：`docker build --target verifier -t pr-agent-verifier:local .`。

operator 只能部署在专用主机或 VM，并只连接该环境的本地隔离 Docker daemon。设置 `PR_AGENT_VERIFIER_IMAGE`、专用 `HARNESS_VERIFIER_DATABASE_URL`、daemon socket group 的 `VERIFIER_DOCKER_GID` 和 `FIX_POLICY_REGISTRY_JSON` 后，在该主机运行 `docker compose -f docker-compose.verifier-operator.yml up -d`。普通 Compose 的 PostgreSQL 不开放宿主端口；远端 operator 必须通过单独托管的数据库端点或受保护的私网访问，不能把数据库直接暴露到公网。operator Compose 不开放 HTTP，不含 provider/model/GitHub/GitLab 凭据。Docker socket 的只读 mount 不能限制 daemon API 权力，因此不能把 operator 合并进应用 Compose，也不能在应用主机复用 daemon。

服务端配置：`FIX_DEFAULT_POLICY_ID`、`FIX_POLICY_REGISTRY_JSON`、`FIX_APPROVAL_TTL_SECONDS`（300–86400 秒）。策略包含固定 image、argv、lock 路径/hash、resource limits、sandbox/publisher policy hash；`expectedSandboxPolicyHash` 计算实际隔离配置哈希。不得把 qualification 测试 fixture 当作生产资格 receipt。

快照内容以服务端生成的 hash-addressed PostgreSQL artifact 为权威。operator 按 job 中冻结的 hash 读取并验证内容，只能落到自身 tmpfs 下新建的临时目录，执行后删除；调用者不能提供宿主路径。普通应用和 operator 不共享快照 volume。

不可信 seed 与 test 容器都使用无网络、只读 root、non-root、cap-drop ALL、no-new-privileges，以及 CPU/memory/PID/tmpfs/ulimit/日志/时间限制；只挂载单个任务的只读快照，不挂整个多租户存储。

## 保留与验证

快照由 PostgreSQL artifact retention 与 hold 协议管理。活动 Run、未知外部效果、Fix/Evolution/qualification hold 会延长内容保留；引用释放后重新计算到期时间。Docker 临时资源另带 job/epoch/数据库 deadline 标签，由 verifier 启动及周期扫尾；只清理 deadline+grace 已过的资源，使用有界游标防止长期遗漏，失败会报告。

验证命令：`npm --prefix backend run check`、`build`、`test`、`test:harness:pg`。真实 Docker sandbox 测试另需 `FIX_VERIFIER_SANDBOX_IMAGE_DIGEST`，默认单测中的 skip 不代表该隔离验证已经运行。阶段证据见 [P2 验证记录](../validation/engineering/p2-verification.json)。
