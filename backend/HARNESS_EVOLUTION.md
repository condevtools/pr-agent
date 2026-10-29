# 受控 Evolution

Evolution 将真实 review 的反馈变成可追溯评测数据，再对受限文本候选作离线比较。数据库队列复用现有 PostgreSQL Harness；无需 Redis/Kafka。P3a 提供反馈与数据底座，P3b 提供候选回放，P3c 提供受控发布。工程验收不能替代真实模型质量验收。

## P3a：反馈、标注与隔离数据集

`POST /evolution/runs/:id/feedback` 接受 `schemaVersion:1, artifactHash, sentiment, categories, comment?`，要求 `feedback:create` 和 `Idempotency-Key`。观察记录不会自动成为真值。

`POST /evolution/runs/:id/annotations` 要求 `annotations:create`、幂等键和 `artifactHash, labelSet, provenance`。labelSet 包括 `schemaVersion:1, rubricVersion:"review-quality.v1", completeness:"complete", expectedFindings:[{path,startLine,endLine,severity,title}]`；空数组表示经完整审查确认无问题。provenance.method 固定 `full_diff_review`。路径和行号必须属于持久化来源 diff。仅接受同租户、同 integration 的成功 `review.deep.v1`、完整 source coverage 与精确 artifact hash。

两位不同身份给出一致标签后产生独立版本的 trusted label。分歧使用 `POST /evolution/runs/:id/annotations/arbitrate`，要求 `annotations:arbitrate`，第三位身份绑定双方 annotation ID/hash 并选择其中一组，写入理由。更正使用 `supersedesAnnotationId`，保留历史并停用旧标签；新的首次异议同样停用旧标签，首次同意既有仲裁结果则保留。修订与数据冻结共享数据库锁，冻结拒绝失效标签。

`POST /evaluation-datasets` 使用 `{name,developmentBefore,validationBefore}` 建立 curator 所有的数据集，要求 `evaluations:create`。同 curator 可通过分别授权的 integration token 纳入多个仓库。`POST /:id/cases` 使用 `{expectedVersion,sourceRunId,labelSetId}`；服务端从已保存 collection step 和固定 SHA 的只读 provider adapter 只采集 changed files 和批准的 manifest/CI 配置文件，构建受限、脱敏 fixture，客户端不能上传 fixture、路径清单或 URL。

`POST /:id/freeze` 使用 `{expectedVersion}`。冻结按明确时间边界分为 development、validation、holdout；禁止仓库、PR lineage 或近重复样本跨 split。manifest 固定各 case 的来源、标签、fixture、版本与顺序；冻结后禁止修改。研究数据集可少于正式发布门槛，但不能因此获得发布资格。

`GET /evaluation-datasets/:id` 要求同 curator 和 `evaluations:read`。`GET /:id/cases/:caseId/fixture` 返回模型可见 fixture，holdout 另需 `evaluations:holdout`；标签不混入模型输入。fixture 明确记录实际可读取的路径和 repository-read partial 状态；超出快照的文件读取不能冒充完整仓库覆盖。仅删除且无可回放文件的来源显式拒绝。跨租户由 FORCE RLS 约束，同租户 integration 由来源查询授权约束。

管理员 CLI：`dataset-retire --tenant UUID --dataset UUID --version N` 退休冻结数据集；`dataset-purge --tenant UUID --dataset UUID` 清理已退休数据集原文。管理员需 PostgreSQL superuser/BYPASSRLS 身份。清理保留身份、哈希、manifest、计数和审计；其他未退休数据集仍引用的 fixture 保留。来源 Run retention 不破坏已复制的 dataset fixture。原文清理后 fixture 读取返回 410。

## 验证边界

真实 Docker PostgreSQL 测试使用 CLI 授予权限的 `pr_agent_app`（NOSUPERUSER/NOBYPASSRLS），验证 RLS、同租户错误 integration、幂等、独立仲裁、更正、三段隔离、并发冻结、内容清理和最小权限。单元测试验证 fixture 路径/敏感文件/标签边界。这里只证明工程行为；当前没有提供独立真实质量数据集，Evolution 有效性仍为 NOT_VERIFIED。

## P3b：受限提案与生产路径回放

`POST /evolution/proposals` 使用 `{datasetId}` 和 `Idempotency-Key`，要求 `evolution:propose`。服务端冻结 curator 所有数据集的 development 标签摘要、基线文本、数据版本和内容哈希；生成器没有工具，也没有 validation/holdout 输入。`evolution.propose.v1` 使用真实 Run 租约、持久 Step、模型预算与幂等结果。模型只能返回严格的 `{schemaVersion:1,prompt_text,tool_description_text}`，未知字段拒绝。每个文本限 32768 字符。候选身份、来源、状态、基线和模型配置由服务端决定。

`POST /evolution/evaluations` 使用 `{datasetId,candidateId,split}` 和幂等键，要求 `evaluations:create`；holdout 额外要求 `evaluations:holdout`。每个 split 最多 500 cases，调度策略固定为每 integration 全局最多四个活动子 Run；截止时间按工作量计算且至少七天。PG 协调器对 split 内每个 case 建立 baseline/candidate 各三次无固定 seed 的独立 `eval.replay.v1` 子 Run。任务身份哈希不是模型 seed。版本、样本、fixture、标签、验证器与候选内容均固定；恢复复用同一子 Run，不挑选最好的一次。

回放与线上 deep review 共用 `executeDeepReviewWithContext`、结构化模型、只读工具 Registry、两个评审角色、Critic 和证据 gate。角色与 Critic 的实际 system prompt 包含固定 envelope 和被冻结的候选文本；最终文本进入 Step 输入哈希。模型和工具权限、拓扑、预算、schema、handler 不由候选改变。仅成功的提案 Run 所产生候选可读取或评测；部署组件不匹配会形成明确失败矩阵，不会无限占用租约。回放工具只从不可变 fixture 读文件及 CI，不访问真实 provider，也不发布评论或代码。

只有子 Run 终态后，评分器才读取独立标签。超时会取消未完成子 Run 并保存最终计数、指标哈希及已观察/尚未确定的费用。失败与取消保留在样本分母，记录逐次得分、方差、成本、延迟和高严重度误报/漏报；缺失用量、失败或可观测模型版本漂移会阻止可比性判断。模型未暴露的供应商内部版本变化无法据此证明不存在。

候选内容始终保持不可变的 `research_draft`；每个仓库的发布状态单独管理，完成测试或 synthetic 回放都不代表实际质量改善。数据集存在提案或评测引用时，退休/清理会拒绝操作以保护复现证据。

## P3c：按仓库发布、灰度与回滚

发布范围由已认证 principal 的 tenant/integration 决定，HTTP body 不能选择其他租户或仓库。全局候选不因一个仓库上线而变成全局生产版本。`evolution_release_assignments` 管理每仓库 CAS 版本和 `evaluated_experimental → approved_canary → promoted` 状态；回滚进入 `rolled_back`。所有审批、版本前后快照、证据哈希和 Run 实际选用文本均留下不可变记录。

发布默认关闭，只有服务端明确设置 `EVOLUTION_RELEASE_ACTIVATION_ENABLED=true` 才能启用；仓库 Compose 不设置该开关。开关只是工程前提，不能跳过数据、评测和审批门槛。所有 deep Run 继续遵守既有只读、shadow 执行边界，发布选择不授予 provider 写权限。

离线资格要求冻结数据集至少 300 cases、30 个仓库，高/中/低严重度各至少 30 cases，TypeScript 和 JavaScript 各至少 30 cases。validation 与 holdout 必须使用同一候选、数据版本、组件和可观测供应商模型版本，分别完成 baseline/candidate 各三次独立回放。两个 split 的严重度加权 F1 都至少为非零基线的 1.03 倍；候选高严重度误报/漏报、安全回归、不完整分析为零；成本 p50 不超过非零基线的 1.2 倍。失败、缺失用量、待确认费用、版本漂移、无效标签会阻止资格。当前产品基线与提案冻结基线也必须相同。

API 均位于 `/evolution/releases`，写操作要求 `Idempotency-Key`，权限按动作拆分为 `evolution:release:qualify|request|approve|revoke|rollback`，查询要求 `evolution:release:read`：

| 接口 | 请求内容与作用 |
| --- | --- |
| `POST /qualify` | `{candidateId,datasetId,validationEvaluationId,holdoutEvaluationId}`，服务端计算资格证据 |
| `POST /request` | `{target,candidateId,qualificationId,expectedVersion,candidateBps?}`；target 为 shadow、canary、promote |
| `POST /approve` | `{requestId,decision:"approve"|"reject"}`；独立人工身份决策 |
| `POST /revoke` | `{requestId}`；申请人在消费前撤回 |
| `POST /rollback` | `{expectedVersion,reason}`；持专用权限的身份紧急回滚 |
| `GET /` | 读取当前认证仓库的发布状态 |

shadow/canary/promote 每次升级都要求两位不同人工身份，申请 24 小时过期，消费审批与 assignment CAS、receipt 写入同一事务。shadow 为候选影子执行；canary 的 `candidateBps` 范围 1–500，即最多 5%，其余使用固定基线作为 control。晋级 full 需同一 assignment 版本至少运行 24 小时，并具有至少 100 个终态 candidate 和 100 个终态 control，错误率、不完整率、成本 p50、延迟 p95 不劣于 control，且不存在未知发布结果或缺失费用证据。

Run 创建时使用租户、仓库、事件身份、head SHA、assignment 版本和 salt 确定 bucket，冻结实际文本、prompt/tool hashes 和发布 receipt。模型、工作流、权限策略与 runtime hashes 不随文本选择改变。Run、预算和选择记录同事务提交；重复投递返回原 Run，回滚只影响新 Run。失效资格、标签更正或组件漂移会让新 Run 回到基线。

`GET /runs/:id/trace` 在 `runs:trace` 权限下返回不可变的 `release_selection` 条目，包括 assignment 版本、routing、selection、candidate/qualification/receipt ID、实际文本哈希及 prompt/tool/selection hashes。候选执行时 `reviewTextHash` 等于候选内容哈希；control/baseline 展示其实际基线文本哈希。trace 不返回完整提示词或工具说明文本。

当前离线比较固定为产品基线，因此禁止在已上线候选 A 上直接叠加候选 B；回滚目标就是该已知产品基线。支持任意 A/B 连续演进及恢复历史候选需要先扩展评测的 control 身份，不能用 B 对旧产品基线的结果冒充 B 对 A 的验证。

发布引用的候选、提案、数据集，以及资格来源 Run 和 candidate/control 观测 Run 保留复现证据，不能由普通 retention 清理；历史发布元数据不删除。这是保守保留策略，目前没有解除发布证据保留的管理接口，需要容量规划。

发布门槛测试使用明确标识的合成工程数据，模型与 provider 使用本地替身；不产生真实发布资格，也没有开启生产激活。真实质量结论仍为 **NOT_VERIFIED**。
