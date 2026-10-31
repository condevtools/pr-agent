# GitHub App：安装即用

完整 GitHub App 模式由 `APP_ID`、`PRIVATE_KEY`（或 `PRIVATE_KEY_PATH`）和
`WEBHOOK_SECRET` 共同选择。App 安装到 GitHub.com 并选择仓库后，Web 进程会在启动时、
周期发现时或收到 installation 事件后同步安装与仓库；后续符合条件的 PR Webhook 会自动
进入评审。无需管理页面、repository-admin token 或逐仓库接入命令。公开和未公开/私有的
GitHub.com App 都支持；自动同步不支持 GitHub Enterprise Server origin。

## 部署配置

Compose 部署使用六个不同的随机数据库密码，前五个为既有运行角色，第六个是只授予
GitHub installation 控制面函数的 `pr_agent_onboarding`：

```env
HARNESS_BOOTSTRAP_PASSWORD=...
HARNESS_MIGRATION_PASSWORD=...
HARNESS_APP_PASSWORD=...
HARNESS_VERIFIER_PASSWORD=...
HARNESS_MAINTENANCE_PASSWORD=...
HARNESS_ONBOARDING_PASSWORD=...

APP_ID=123456
PRIVATE_KEY="-----BEGIN RSA PRIVATE KEY-----\\n...\\n-----END RSA PRIVATE KEY-----\\n"
WEBHOOK_SECRET=...
FEATURE_GITHUB_ONBOARDING=auto
```

`auto` 是默认值，在完整 App 模式开启正向同步；`on` 是显式同义值。`off` 只作为紧急
停止正向发现、创建、恢复和 deferred PR drain 的开关，不删除现有数据，也不会关闭
remove/suspend/delete 的限制性持久化。因此完整 App 模式在 `auto`、`on` 和 `off` 下都
要求 onboarding 密码、schema 与精确授权可用，否则启动/就绪检查失败。PAT/plain webhook
与 GitLab 不会因默认 `auto` 要求该密码。

Compose 的 `onboarding-role-init` 在迁移完成后幂等创建或轮换该受限角色，并为新 volume
和已有 volume 应用同一精确函数白名单。模型 provider key 只进入 worker；onboarding 密码
只进入 PostgreSQL、一次性 bootstrap 和 Web。外部 PostgreSQL 部署应实现同等顺序与权限，
不能把 bootstrap 管理员密码交给长期运行的应用容器。

## 已有安装与冲突

升级后无需重装 App。启动与周期发现会列出已有 installations，再读取完整分页仓库清单。
已有且归属唯一的 binding 会原位采用，保留 binding/tenant/run/budget 与 operator
blocked/draining 状态。一个 GitHub account 若关联多个历史 tenant，会停止该 account 的
正向自动接入并报告冲突；系统不会自动合并或移动历史。删除、暂停或移除仓库会立即限制
provider access，只有后续完整、当前 epoch 的新快照才可恢复 provider access。

首个 PR 与 installation 同步并发时，只持久化最小的 deferred PR 身份；同步完成后重新读取
GitHub 与当前策略再入队。原始 Webhook body、headers、token 和评论内容不会进入 deferred
表。GitHub API 故障或分页不完整不会被解释为空仓库清单。

## 运维与回滚

观察 `/ready`、安装同步 backlog/oldest age、deferred PR backlog/oldest age、冲突计数和循环
liveness。GitHub 外部 API 暂时不可用应表现为 backlog/degraded，而不是撤销缺席仓库。

`/ready` 的 `githubOnboardingQueue` 返回当前 App 的同步/PR 积压数量、最老等待秒数和
持久化冲突数；等待超过 5 分钟或存在冲突会标为 degraded，数据库与循环正常时不摘除
整个 Web 服务。受鉴权保护的 `/metrics` 提供 `pr_agent_github_onboarding_*` 和
`pr_agent_github_deferred_*` 计数器。Deferred PR 的等待期限为 72 小时，超过后不会补跑；
后续新的 PR synchronize/edit 事件仍可正常触发评审。

GitHub App 的 Webhook URL 使用 `/api/github/webhooks`；Nest `/github/trigger` 也支持用
App `WEBHOOK_SECRET` 签名的安装和 PR 事件。普通 `GITHUB_WEBHOOK_SECRET` 仅授权普通
仓库 Webhook，不能修改 App 安装权限；可信回放也不能执行安装接入/撤权。

若新版本必须回滚，唯一已规划的兼容基线是精确 commit
`701c6b97abe005b95c64e192e403d142e96f8696`。在启动该旧镜像前必须显式设置
`FEATURE_GITHUB_ONBOARDING=on`，并保留 App/onboarding credentials、migration 031 原函数签名
与授权；该旧版本拒绝 `auto`，变量未设置则会关闭限制性事件处理。必须先运行旧镜像+新
schema 的兼容测试和 signed removal smoke。不要降级 schema、清空 restrictions，且不要把
未验证的 `d06...` 镜像当作回滚目标。

本页描述仓库支持的部署流程，不表示任何具体环境已经部署或验收通过。紧急 binding/control
CLI 仍保留用于人工事故处理；它不是 GitHub App 正常安装接入步骤。

本地和 CI 使用 `pnpm test:github:onboarding:rollback` 构建上述精确旧版本，连接隔离的
当前 schema 数据库并验证签名撤权；需要 Docker、已安装依赖以及包含该 commit 的 Git
历史。测试不使用项目 `.env`、真实 GitHub 凭据或模型服务。
