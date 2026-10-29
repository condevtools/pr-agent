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

PostgreSQL 已在根 `docker-compose.yml`。`harness-migrate` 管理迁移和最小权限；旧 volume 在提供 `HARNESS_VERIFIER_PASSWORD` 时可安全自举 verifier role。web 容器没有 Docker socket；可选 `verifier` profile 的控制器有 socket 和独立 PG 凭据，没有 provider/model 凭据。

构建 sandbox：`docker build --target verifier-sandbox -t pr-agent-fix-sandbox .`。通过 `docker image inspect pr-agent-fix-sandbox --format '{{.Id}}'` 获取不可变 image ID，在服务端 policy 使用该 SHA-256。镜像必须预先存在，运行时 `--pull never`。运行 profile：`docker compose --profile verifier up -d`。

服务端配置：`FIX_DEFAULT_POLICY_ID`、`FIX_POLICY_REGISTRY_JSON`、`FIX_VERIFIER_SNAPSHOT_ROOT`、`FIX_APPROVAL_TTL_SECONDS`（300–86400 秒）。策略包含固定 image、argv、lock 路径/hash、resource limits、sandbox/publisher policy hash；`expectedSandboxPolicyHash` 计算实际隔离配置哈希。不得把 qualification 测试 fixture 当作生产资格 receipt。

不可信容器使用无网络、只读 root、non-root、cap-drop ALL、no-new-privileges，以及 CPU/memory/PID/tmpfs/日志/时间限制；只挂载单个任务的只读快照，不挂整个多租户 volume。Docker socket 的只读 mount 不限制 daemon API 权力，verifier 控制器仍是可信边界，应部署在隔离主机/daemon。

## 保留与验证

先按现有 `retention` 管理 DB 内容；再以 admin 身份执行 `node dist/agent-runtime/cli.js snapshot-retention --action preview` 或 `--action apply`（可选 `--days`、`--limit`）。GC 检查所有 tenant 的 queued Run、未清理 proposal/job、未消费审批及活动 publish child；不会跟随 symlink。Docker 临时资源另带 job/epoch/数据库 deadline 标签，由 verifier 启动及周期扫尾；只清理 deadline+grace 已过的资源，使用有界游标防止长期遗漏，失败会报告。生产 retention 容器需要挂载对应 snapshot volume。

验证命令：`npm --prefix backend run check`、`build`、`test`、`test:harness:pg`。真实 Docker sandbox 测试另需 `FIX_VERIFIER_SANDBOX_IMAGE_DIGEST`，默认单测中的 skip 不代表该隔离验证已经运行。阶段证据见 `validation/p2-verification.json`。
