# 多 Agent 深审

`POST /runs` 增加可选 `workflow: "review.deep.v1"`。默认仍为 `review.single.v1`；相同创建键切换 workflow 返回 409，省略该字段和显式指定 single 保持旧幂等身份。Webhook 继续使用 single，深审需要具有 `runs:create` 权限的显式请求。

```json
{"number":42,"workflow":"review.deep.v1","mode":"report"}
```

深审固定执行 Security 和 Correctness 两个只读角色，再由 Critic 对已有 candidate 作决定，最后经过服务端 evidence gate。没有模型决定的动态拓扑。两个角色各最多 3 轮模型、2 次工具、20 个 candidate 和 90 秒；Critic 最多 60 秒。模型每轮经过现有全局并发限制和同一 PostgreSQL 预算账，原 Run 输入/输出 token 与费用预算分为 30% / 30% / 40%，未知费用继续占用额度。角色上限不能借用 Critic 的额度。

角色可调用 `read_file_range`、`search_changed_files`、`find_symbol_references`、`read_manifest` 和 `read_ci_status`。查询绑定当前 integration、仓库和固定 head SHA，模型不能指定 URL、凭据、tenant、ref 或 HTTP method。引用搜索只覆盖有界 changed-file snapshot，不是全仓库语义索引。文件路径、树模式、大小、行数和 HTTP 响应受限；二进制、符号链接和敏感路径被拒绝，可能的密钥被脱敏。

每个模型和工具动作有自己的 Step、attempt 与 checkpoint。可重试的 provider 故障先等待并行角色结束再重试 Run；已成功 Step 复用原输出。永久错误、耗尽额度和最后一次失败进入 partial/failed coverage。两个角色都失败时 Run 失败并保留 incomplete artifact。模型输出中的文字、代码和工具结果均不能提升权限。

Evidence 由成功工具 Step 的精确输出登记，服务端校验 request hash、内容 hash、tenant/integration/Run/repository/revision 和来源 attempt。Critic 只能接受、拒绝或请求更多证据，不能新增发现。发布门要求唯一有效 Critic 决定、当前 Run/head 的已登记完整文件范围证据，以及实际新增 diff 行。截断、脱敏、伪造引用、旧 revision、重复决定和缺失证据会被拒绝。V1 不接受跨文件调用链或删除行的发现；这些限制会明确影响覆盖状态。

这个 gate 证明证据来源与代码位置可信，不证明缺陷结论正确。当前没有独立标注 benchmark，因此深审始终 `publicationMode: "shadow"`：只生成报告，不创建 publication batch，也不调用评论、标签、branch 或 PR 写接口。空 diff 和已有旧批次也走同一个只读边界。Run 成功表示报告流程完成；判断完整程度应读取 `analysisStatus`、`verdict` 和 coverage。

## 查询和保留

- `GET /runs/:id`：增加 artifactAvailable、analysisStatus、coverageStatus、publicationMode。
- `GET /runs/:id/artifact`：`runs:read` 权限，返回覆盖状态和通过 gate 的脱敏 findings。
- `GET /runs/:id/artifact?raw=true`：另需 `runs:trace`，可查看 candidate、Critic、gate 决定；无隐藏推理链。
- 内容保留操作同步清除 evidence、candidate、decision 和 artifact 正文，保留 hash、身份和审计。

四张新表采用 tenant RLS 和复合外键；应用角色只有 INSERT/SELECT 权限。已登记的内容不能被重写。Workflow、prompt、model、tool、policy 和 runtime hashes 继续由 Run 固定；代码或配置不兼容的旧 Run 必须显式重跑。

## 验证边界

自动化测试覆盖真实 Docker PostgreSQL 的角色并发、Step 复用、预算拒绝、证据伪造、跨 Run/revision 拒绝、不可变报告、内容保留，以及只读工具的路径、响应和符号链接限制。模型测试使用确定性 fixture；它们不构成真实精确度/召回率、修复成功率或 Evolution 改善证据。单审与深审的真实质量、成本和时延比较尚未提供，自动发布继续关闭。

本阶段最终验证：290 项单元测试、130 项 Docker PostgreSQL 测试（19 suites）、typecheck/build 和编译镜像的 Compose smoke 通过。可复现命令和证据边界见 [验证记录](../validation/engineering/p1-verification.json)。
