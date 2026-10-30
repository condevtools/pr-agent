# 能力与就绪状态

普通 GitHub/GitLab PR webhook 默认创建 `review.single.v1`。Deep Review 通过受保护的 `POST /runs` 显式请求，或由管理员为仓库绑定设置默认工作流；请求头不能开启能力。

| 能力 | 进程开关默认值 | 仓库绑定要求 | 结果和边界 |
| --- | --- | --- | --- |
| Single Review | 始终启用 | 已激活绑定 | 经 PG 发布账本发布评审 |
| Deep Review | `FEATURE_DEEP_REVIEW=on` | 允许 Deep | 多角色评审生成持久化 shadow artifact，不自动写代码 |
| Fix | `FEATURE_FIX=off` | 显式允许 Fix | 基于成功 Deep 的 accepted finding、服务器策略和验证结果提出补丁 |
| Evolution | `FEATURE_EVOLUTION=off` | 显式允许 Evolution | 保存反馈、整理数据集、离线评测和受控策略发布 |

开关只接受 `on` 或 `off`。部署配置开启后仍须满足仓库绑定授权及 API principal 权限。环境变量作用于读取它的进程，分开部署时必须一致配置；仓库绑定是 PostgreSQL 中各进程共同遵循的能力边界。

关闭能力阻止新任务接纳及新的执行领取，不会自动取消已取得租约的任务或撤销已经冻结的发布意图。已有工作仍可完成、对账和结算；历史读取、同一资源的精确幂等回执，以及撤销、拒绝、回滚和放弃等安全控制继续可用。人工授权重新发起写入仍需能力开启。需要停止具体任务时使用 Run 取消接口，需要撤销仓库发布权限时使用 authority drain/block；不要用功能开关代替这些控制。

Fix 的测试通过不等于可以自动发布。相关性不能证明时保持 `suggestion_only`；发布继续要求匹配的人工相关性证明，以及 maker/checker 审批。关闭 Fix 的部署无需为了普通评审配置 verifier。

管理员先用 `inspect` 获取绑定的当前 `version`，再通过受限的迁移账户调整能力。例如保留 Single 默认、允许显式 Deep，关闭 Fix 和 Evolution：

```sh
docker compose run --rm database-init node dist/agent-runtime/cli.js capabilities \
  --tenant <tenant-uuid> --id <integration-uuid> --version <authority-version> \
  --deep on --fix off --evolution off --default-review single
```

该命令检查版本并记录审计，不允许普通应用账户直接修改绑定。将 `--default-review` 改为 `deep` 必须同时允许 Deep；修改全局开关还需要更新 `.env` 并重新创建对应服务。只修改 `.env` 不会自动改变数据库里的绑定授权。

## 反馈不等于人工标注

可信反馈必须指向同一绑定、平台、origin、仓库和 PR/MR 中的成功 Deep Run，由服务器读取产物 hash。没有可信产物关联的 thread resolved/unresolved 事件不会自动归到最近的 Deep Run。

开启 Evolution 并完成绑定授权后，有仓库写权限的 GitHub 用户或 GitLab Developer 以上成员，可在对应 PR/MR 评论：

```text
/feedback <deep-run-uuid> positive 解释清晰，指出的问题已确认
/feedback <deep-run-uuid> negative 这里存在误报
/feedback <deep-run-uuid> mixed 部分建议有用，但遗漏了关键问题
```

`deep-run-uuid` 来自受保护的 Run API。机器人在服务端校验用户权限、Run 归属与产物；评论不能自行声明可信 artifact hash。重复投递使用持久幂等键。关闭 Evolution、普通评论或缺少可信关联的 thread 事件不会创建反馈。此命令保存反馈，不会直接写一条绕过发布账本的回复评论。

反馈是用户观察，不能直接变成评测真值、自动批准修复或自动晋升策略。正面、负面和混合反馈保留各自含义。正式质量验收仍需要独立样本和人工标注；架构测试与合成样本不能替代它。

## 探针

`GET /health` 仅表示 HTTP 进程存活，不生成模型请求，也不证明数据库、后台处理和全部功能已就绪。

`GET /ready` 按当前进程角色和已启用能力检查数据库权限、schema 和后台心跳等依赖；未就绪返回 HTTP 503。响应不包含连接串、密钥或租户明细。只开启普通评审时，缺少 Fix verifier 不影响就绪状态。

没有 HTTP 服务的 Worker 或 Recovery 进程可执行同一就绪检查：

```sh
node dist/agent-runtime/cli.js ready --role worker
node dist/agent-runtime/cli.js ready --role recovery
```

CLI 输出集群依赖检查结果，就绪时退出码为 0，否则为 1。它查找符合要求的存活后台实例，不证明运行 CLI 的容器本身正在处理任务，不能单独替代该容器的实例健康检查。`PR_AGENT_PROCESS_ROLE` 可取 `web`、`worker`、`recovery`、`all`；默认 `all`，分开部署时各进程应使用同一数据库和一致的能力设置。

生产环境应同时观察存活和就绪状态。一次就绪检查通过不是未来外部 API 可用性或模型评审质量的承诺。
