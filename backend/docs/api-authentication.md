# 管理 API 鉴权

Run、Fix、Evolution、metrics 和 Webhook replay 由全局 Nest Guard 检查权限。每个路由必须声明访问策略；遗漏声明会阻止应用初始化。普通 Webhook 继续使用 GitHub/GitLab 的签名验证，健康接口公开。

`HARNESS_API_PRINCIPALS_JSON` 使用带 SHA-256 token 摘要的作用域凭据。每条记录包含 `subjectId`、`actorType`、`tenantId`、`integrationId`、`tokenSha256` 和 `permissions`。可选字段：

- `keyId`：唯一凭据标识，便于轮换。
- `notBefore`、`expiresAt`：含时区的 ISO 时间，限制生效区间。
- `disabled`：设为 `true` 后拒绝该凭据。

`metrics:read` 允许读取运行指标；`replay:read` 和 `replay:execute` 分别允许查看和重放同一 tenant/integration 内的已验证事件。业务权限仍在服务层保留检查，Guard 防止新增路由遗漏入口鉴权。

需要不重启轮换时，设置 `HARNESS_API_PRINCIPALS_FILE`，把上述 JSON 数组以只读文件挂载到容器；不能同时设置 JSON 环境变量。用原子替换更新文件后，给每个 Web 进程发送 `SIGHUP`。配置无效时该进程会停用管理 API 凭据并记录不含凭据内容的告警。修正文件后再次发送信号即可恢复。

轮换会使已有认证快照失效；SSE 在下次轮询时关闭失效连接。客户端使用新凭据和持久化 cursor 重连。普通请求在进入业务操作前完成授权；已经提交的数据库事务不因后续凭据轮换而撤销。
