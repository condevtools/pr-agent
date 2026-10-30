# GitHub 仓库接入管理

GitHub 仓库接入页用于发现当前 GitHub App 账户下可见的仓库，并在人工确认旧发布者已经停止后，创建或重新验证受信任的 integration binding。页面和管理 API 都由后端提供，不依赖根目录的 Next.js 前端。

该能力默认关闭。开启后，管理页位于 `/api/admin/github`；关闭 `FEATURE_GITHUB_ONBOARDING` 会同时撤回页面和管理 API，但不会删除已经创建的 binding，也不会自动恢复处于 blocked、draining、revoked 或 suspended 状态的 binding。

本版管理页支持公共 GitHub App（`https://api.github.com`）。GitLab、PAT 和 GitHub Enterprise 的既有接入流程保持原样。已安装的 App 无需卸载重装，服务端会直接发现授权仓库。

## 生成受限管理员凭据

先为拥有 GitHub App installation 的个人或组织生成一个有过期时间的管理员凭据：

```sh
pnpm github:admin:create -- --account condevtools \
  --tenant <已有-tenant-uuid> \
  --subject <管理员审计标识>
```

命令通过 GitHub 公共 `/users/{login}` API 获取不可变的数字 account ID，不使用 GitHub token。无法联网时，可改用从 GitHub API 独立核实的数字 ID：

```sh
pnpm github:admin:create -- --account-id <numeric-account-id> \
  --tenant <已有-tenant-uuid> \
  --subject <管理员审计标识> \
  --expires-in-days 30
```

未传 `--tenant` 时会生成新的 UUID；需要把新 tenant 纳入现有运维流程。默认有效期为 30 天，最长 365 天。命令只向当前终端输出一次 bearer token、SHA-256 principal 和待配置字段，不修改 `.env`、数据库或部署。把输出的 `principal` 追加到现有 `HARNESS_API_PRINCIPALS_JSON` 数组；不要覆盖已有 Run、Fix 或 Evolution principal。bearer token 只交给授权管理员，不能写入数据库、日志、Issue、PR、镜像或仓库文件。

## 部署配置

Web 服务需要以下配置：

```dotenv
FEATURE_GITHUB_ONBOARDING=on
HARNESS_ONBOARDING_PG_PASSWORD=<独立的随机数据库密码>
HARNESS_API_PRINCIPALS_JSON=<包含 repository_admin principal 的完整 JSON 数组>
```

`HARNESS_ONBOARDING_PG_PASSWORD` 只配置给 `PR_AGENT_PROCESS_ROLE=web` 的容器。Worker、recovery、maintenance、database-init 和 verifier 不需要该密码。Compose 部署应从一个部署级 secret 映射同一个值，而不是复用 app、migrator、maintenance 或 bootstrap 密码：

```yaml
services:
  pr-agent:
    environment:
      FEATURE_GITHUB_ONBOARDING: "on"
      HARNESS_ONBOARDING_PG_PASSWORD: ${HARNESS_ONBOARDING_PASSWORD:?}
  postgres:
    environment:
      HARNESS_ONBOARDING_PASSWORD: ${HARNESS_ONBOARDING_PASSWORD:?}
```

`pr_agent_onboarding` 是仅供 Web 接入流程使用的受限数据库角色。新建空 volume 时，PostgreSQL 初始化脚本会先用 `HARNESS_ONBOARDING_PASSWORD` 创建角色，然后 database-init 应用迁移 `031_github_onboarding.sql` 和角色授权。

### 现有 Coolify PostgreSQL volume

已有 volume 不会重新执行 `/docker-entrypoint-initdb.d`。先备份数据库，在功能仍为 `off` 的情况下部署新镜像，让 `database-init` 完成迁移 031；然后在 Coolify 中创建部署级 secret `HARNESS_ONBOARDING_PASSWORD`，把它加入 PostgreSQL 服务环境，并以 bootstrap 管理员执行仓库提供的一次性脚本。该脚本要求迁移 031 的函数已经存在，然后创建或轮换角色并收紧、重授唯一需要的权限：

```sh
docker compose exec -T postgres \
  psql -X --no-psqlrc -v ON_ERROR_STOP=1 -U postgres -d pr_agent \
  < docker/postgres/enable-github-onboarding.sql
```

脚本从 PostgreSQL 容器的进程环境读取 `HARNESS_ONBOARDING_PASSWORD`，不要把密码放进 SQL 参数或 shell 历史。确认角色与授权成功后，再把同一个部署级 secret 映射为 Web 服务的 `HARNESS_ONBOARDING_PG_PASSWORD`，设置 `FEATURE_GITHUB_ONBOARDING=on` 并重启 Web。不能靠反复重启或删除 volume 修复角色或授权失败。

部署完成后，先检查 `/ready`，再访问 `https://<服务域名>/api/admin/github`。在登录框粘贴一次性 bearer token；token 只保存在当前页面的 JavaScript 内存中，刷新或点击“断开凭据”后需要重新输入。选择仓库前必须确认“当前仓库没有其他正在发布评审的旧实例”。active 表示已接入；blocked 或 draining 不会被页面自动启用；suspended 必须先在 GitHub 恢复 App installation 权限，再执行重新验证。

开启功能时，Web 的 `/ready` 还会检查专用数据库角色及必要函数权限。普通 Worker 无需接入管理员数据库密码。管理令牌和原有 Run API 令牌互不通用；管理员授权范围由 tenant 和 GitHub 数字 account ID 共同约束。

仓库访问恢复、重命名或 App 重装后，点击“重新验证”。服务器重新查询 GitHub 的仓库、App、安装和 bot 身份，并检查访问版本，避免旧事件覆盖新状态。如果仍存在已经发出但结果未确认的发布操作，API 返回冲突，必须先完成对账。重新验证不会把手工 blocked 或 draining 的绑定改成 active。

旧 CLI 绑定缺少 App/account 元数据时，可以在原 installation 仍有效的情况下重新验证并补全。若这种旧绑定对应的 App 已被卸载重装，服务器无法仅凭旧记录确认原账户身份，本版要求管理员人工核实；不会自动替换 installation。新页面创建或已补全元数据的绑定支持重装后的显式重新验证。

## 验收与回滚

接入后用一个真实测试 PR 验证 webhook、异步 Run、Worker heartbeat 和评审发布。不要用管理页替代旧实例停机检查；两个发布者同时工作会造成重复评论或状态竞争。

需要快速撤回管理面时，把 `FEATURE_GITHUB_ONBOARDING` 设为 `off` 并重启 Web 容器。此操作关闭 `/api/admin/github` 页面、管理 API 和使用专用账号的 lifecycle 持久化处理，不撤销已有 binding、不清理 tenant，也不解除已有访问限制。评审接入、Worker 开始执行及新发布仍实时验证 GitHub App 访问，已有不确定结果的操作仍可对账。原有 bind、configure、authority 和 control 管理命令保留。不要降级数据库结构；若需要回滚应用镜像，保留新增权限限制的执行逻辑。
