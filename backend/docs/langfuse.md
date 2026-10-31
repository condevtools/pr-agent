# Langfuse Agent 可观测性

Langfuse 是可选的可观测层。PostgreSQL 仍然是 Run、步骤、预算、发布和恢复的权威数据源；Langfuse 不参与调度或业务判定，无法连接时也不会改变评审结果。启用与否不作为 `/ready` 的就绪条件。

当前接入兼容 Langfuse Server `3.225.5`，使用 `@langfuse/tracing` 与 `@langfuse/otel` `5.14.0`。Server 4.59.0 之前不要把客户端直接升级到 Langfuse SDK 6。

## 能看到什么

一个被 Worker claim 的 Run attempt 对应一个 trace；同一个 PostgreSQL Run 的重试通过 `sessionId=runId` 聚合。trace 中包括：

- Run workflow、job 类型、attempt、最终状态和耗时；
- durable step，以及该步骤是实际执行还是复用了 checkpoint；
- Deep Review 的 `security`、`correctness` 和 `critic` 三个真实 Agent 执行；
- 每一次真实发送到 OpenAI、OpenAI-compatible、Anthropic 或 Gemini 的物理模型请求；
- provider、model、request ID、token 用量和按冻结价格策略结算的实际成本；
- 安全错误类型和明确的 usage 状态。

第一阶段不记录数据库查询、普通 HTTP 请求或低层框架 span。Publication 和 Recovery 只通过 Run outcome 体现，不额外伪造 dispatch/reconcile tool span。Langfuse 也不会自动启动 LLM-as-a-Judge、创建评测数据集或写回反馈。

模型用量缺失时显示 `unavailable`，不会写成零；PostgreSQL 中的 pending reservation 仍由原有预算对账机制处理。Langfuse 自己按模型推测出的价格不能替代 PostgreSQL 的预算记录。

## 环境变量

Langfuse 在执行 Worker 的进程中初始化；拆分部署时仅 `worker` 服务需要以下变量，`all` 一体模式也支持：

| 变量 | 默认值 | 说明 |
|---|---|---|
| `LANGFUSE_ENABLED` | `auto` | `auto` 在 URL 和两个 key 都存在时启用；`on` 表示希望启用；`off` 禁用。不完整或不安全的配置会安全降级为关闭并记录告警，不阻止 Worker 启动 |
| `LANGFUSE_BASE_URL` | 空 | Langfuse origin，不附加 `/api/public` |
| `LANGFUSE_ALLOW_INSECURE_HTTP` | `false` | 显式允许可信部署的 HTTP 地址；回环、私有数字 IP 和单标签 Docker 服务名无需此例外，带点的私有 DNS 名仍需 HTTPS 或例外 |
| `LANGFUSE_PUBLIC_KEY` | 空 | 项目 public key |
| `LANGFUSE_SECRET_KEY` | 空 | 项目 secret key |
| `LANGFUSE_CAPTURE_CONTENT` | `off` | `off` 只传运行元数据；`redacted` 传输有限长度、脱敏后的提示词和回答 |
| `LANGFUSE_TRACING_ENVIRONMENT` | Compose 中为 `production` | Langfuse 中用于筛选部署环境；直接启动 Node 时可显式设置 |
| `LANGFUSE_RELEASE` | 空 | 可选镜像 commit，例如 `sha-cff4b029f556` |

真实 key 只放在本地 `.env` 或 Coolify 的 Runtime Secret 中，不写入 Compose、镜像或 Git。Coolify 的单行值不要额外包一层单引号或双引号。

`redacted` 会处理已知 key 字段、私钥、常见 token 和当前进程已配置的秘密值，并限制深度、数组长度和内容大小。它无法保证识别所有个人信息、业务机密或自定义格式的凭据。私有仓库代码不应通过公网明文 HTTP 发送。即使 `LANGFUSE_CAPTURE_CONTENT=off`，HTTP 请求仍携带 Langfuse 项目凭据，因此公网 HTTP 默认也会被拒绝。正式部署应配置可信 HTTPS，或让 Worker 通过 loopback、私有 Docker/VPN 网络访问 Langfuse。确实需要连接现有公网 HTTP 服务时，必须显式设置 `LANGFUSE_ALLOW_INSECURE_HTTP=true`。

## 根 Compose

`.env` 中设置上述变量后，根 `docker-compose.yml` 已把它们仅注入 `worker`。不需要增加容器、PostgreSQL 表、Redis、Kafka 或 migration。先以 metadata-only 验证：

```dotenv
LANGFUSE_ENABLED=auto
LANGFUSE_BASE_URL=https://langfuse.example.com
LANGFUSE_ALLOW_INSECURE_HTTP=false
LANGFUSE_PUBLIC_KEY=pk-lf-replace-me
LANGFUSE_SECRET_KEY=sk-lf-replace-me
LANGFUSE_CAPTURE_CONTENT=off
LANGFUSE_TRACING_ENVIRONMENT=production
LANGFUSE_RELEASE=sha-image-commit
```

确认 trace 正常后，需要查看模型决策上下文时把 `LANGFUSE_CAPTURE_CONTENT` 改为 `redacted` 并重新部署 Worker。

## Coolify

保留当前 Compose 结构，只在 `worker.environment` 下加入以下内容。不要放到共用的 `x-review-environment`，否则 Web 和 Recovery 也会获得 secret key。

```yaml
  worker:
    environment:
      LANGFUSE_ENABLED: ${LANGFUSE_ENABLED:-auto}
      LANGFUSE_BASE_URL: ${LANGFUSE_BASE_URL:-}
      LANGFUSE_ALLOW_INSECURE_HTTP: ${LANGFUSE_ALLOW_INSECURE_HTTP:-false}
      LANGFUSE_PUBLIC_KEY: ${LANGFUSE_PUBLIC_KEY:-}
      LANGFUSE_SECRET_KEY: ${LANGFUSE_SECRET_KEY:-}
      LANGFUSE_CAPTURE_CONTENT: ${LANGFUSE_CAPTURE_CONTENT:-off}
      LANGFUSE_TRACING_ENVIRONMENT: ${LANGFUSE_TRACING_ENVIRONMENT:-production}
      LANGFUSE_RELEASE: ${LANGFUSE_RELEASE:-}
```

在 Coolify Environment Variables 创建同名变量。`LANGFUSE_PUBLIC_KEY` 和 `LANGFUSE_SECRET_KEY` 设为 Runtime 可用，Build time 不需要。`LANGFUSE_CAPTURE_CONTENT=redacted` 适合排查回答质量。使用公网 HTTP 地址时，仅把 capture 改为 `off` 仍不够，因为请求会发送认证 key；优先配置可信 TLS 或私有地址。保留已有公网 HTTP 部署时，需要明确设置 `LANGFUSE_ALLOW_INSECURE_HTTP=true` 并接受传输风险。

代码和环境配置更新后发布新镜像：

```bash
pnpm docker:image:push
pnpm docker:image:inspect
pnpm docker:image:ref
```

将 `docker:image:ref` 输出的完整 `ghcr.io/...:sha-...` 同时更新到 Coolify 中的 `pr-agent`、`worker`、`recovery`、`maintenance` 和 `database-init`，再 Deploy/Restart。Langfuse 变量只需要加入 Worker。

## 验证与停用

创建一个测试 Issue 或 PR 触发真实 Worker Run。Langfuse 中应先看到一个 workflow Agent，下层是 durable steps；Deep Review 会显示三个角色 Agent，真实模型请求显示为 generation。重试会形成同一 session 下的新 attempt trace，复用 checkpoint 的 model step 不会新增 generation。

部署前也可以运行合成 smoke：

```bash
pnpm test:langfuse:smoke
```

它使用合成 RunWorker 输入和三个本地物理模型 fixture 验证 trace 结构，不调用真实 GitHub、PostgreSQL 或付费模型。发送后会使用项目凭据回读 Langfuse，确认 16 个节点、父子关系以及精确的 fixture token 和成本，只有验证成功才输出 `verified: true`；认证失败或超时会使命令失败。该命令仍需要 Worker 相同的 Langfuse 环境变量；公网 HTTP 测试也必须显式设置 `LANGFUSE_ALLOW_INSECURE_HTTP=true`。

快速停用时把 `LANGFUSE_ENABLED` 改为 `off` 并重新部署 Worker。业务 Run、PostgreSQL 数据、发布和 `/ready` 都继续工作。停机时 Worker 会先停止接单并等待执行结束，再在有限时间内 flush Langfuse；flush 失败只写安全日志。
