# EvoAgent 与 PR-Agent：源码对照与迁移选择

本对照来自本地 `/Users/lemonade/Downloads/EvoAgent(3)/evoagent` 源码，以及本仓库实际调用链。它不把 README 中的能力宣称当作运行证据，也不据此断言哪个项目的模型审查准确率更高。

## EvoAgent 实际做了什么

`agentic_core.py` 中的 `AgenticReviewer` 使用四种固定角色：Lead、Security、Correctness/Reliability、Critic。它们共享 `JsonChatClient`，通过 prompt、阶段和 `ROLE_PERMISSIONS` 分工。Security 与 Correctness/Reliability 使用 `ThreadPoolExecutor` 并行，属于同一进程中的逻辑角色，不是四个独立服务。

`ReviewHarness` 外层通过 `AgentRuntime.execute()` 顺序执行 planning、executing、reviewing。内部 agentic 阶段才进入 Lead delegation → workers → 高风险可选的一轮 revision → Critic → Lead synthesis。普通风险 worker 可以单步返回，高风险才开放更多工具和修订；因此不能把每次调用都理解为完整多轮团队协作。

`RepositoryToolSuite` 提供文件读取、diff 搜索、符号/AST、Git、扫描器和仓库检查。Agent Skill 包与角色允许的工具取交集；scanner、Skill 和 agent role 是不同对象。`repository_tools.py` 的检查结果明确标记 `network_disabled: False`，其 subprocess 检查不能直接视作适用于不可信 PR 的完整网络沙箱。

修复是显式 API 请求中的独立路径：`service.py` 调用 patch/fix 流程，`patching.py` 校验路径、hunk、上下文与编译，并在配置了测试命令时比较 baseline 和 patched archive。发布 commit/Draft PR 是后续动作。`evolution_v2.py` 的 `RootCauseEvolutionGenerator` 则分析失败轨迹并生成配置提案；它不是每个 PR 内自动运行的第五个审查角色。

主要源码入口：

| 能力 | EvoAgent 源码 |
| --- | --- |
| 角色 prompt、权限与有界循环 | `agentic_core.py:25–224`，`BoundedRole.run` |
| Lead/worker/Critic 编排 | `agentic_core.py`，`AgenticReviewer._agentic` |
| worker 并行与 Skill 权限交集 | `agentic_core.py:900–1002`、`:1061–1095` |
| 外层运行时与 checkpoint | `runtime.py:123–218`，`harness.py:76–82` |
| 工具 schema、证据与本地检查 | `repository_tools.py:29–64`、`:264–431` |
| finding gate | `gates.py:39–57` |
| 修复生成、校验和发布入口 | `patching.py:124–225`，`service.py:463–480` |
| 根因演化提案 | `evolution_v2.py:10–75` |

行号对应本次本地源码快照，后续修改可能改变位置。

## 与 PR-Agent 的联系和主要区别

PR-Agent 原有核心是平台集成驱动的单次结构化审查：[ai-reviewer.ts](./src/review/ai-reviewer.ts) 负责 provider、schema 和全局并发限制；GitHub/GitLab collector、policy、CI、secret scan、报告与评论发布已有完整调用链。EvoAgent 的重点更多落在审查角色协作、工具探索和离线演化实验。二者都围绕代码 review，但可迁移的主要是执行模式和证据方法，不是直接复制 Python 服务。

| 方面 | EvoAgent 源码表现 | PR-Agent 的选择 |
| --- | --- | --- |
| 审查编排 | Lead 模型选择委派、高风险修订与合成 | 保留 single；deep 使用确定性 Router、两个只读角色及 Critic |
| 执行框架 | 自建 Python runtime，节点内线程并行 | 复用 Nest/TypeScript；逻辑角色共享 durable Run，分别记 Step/Attempt |
| 平台能力 | GitHub、仓库工具与研究流程 | 保留现有 GitHub/GitLab、多 provider、政策与 renderer |
| 证据 | evidence ID 与工具输出关联；gate 检查其形状 | 绑定 tenant/integration/repository/固定 SHA，从服务端记录核验，不能相信模型自报 ID |
| 外部写入 | review/fix 流程包含平台写动作 | 统一 publication ledger、generation、冻结 payload、unknown 对账及人工回执 |
| 重启与并发 | 有 runtime/checkpoint/存储代码；不能仅凭存在就证明全部故障窗口 | PG Run lease、epoch、job、checkpoint、预算与事件同事务协议，使用 Docker PG 和进程强杀验证 |
| Fix | 显式生成 patch 并进行可配置检查 | 独立 FixRun；code/test patch 分离、Docker 差分验证、精确意图审批，默认 suggestion |
| Evolution | 根因生成器可提出 prompt/delegation/tool/budget 配置 | 离线 EvolutionRun；V1 只允许 prompt/tool description 文本，禁止修改权限、预算和拓扑 |

当前生产底座的源码位置包括 [Run worker](./src/harness/review-run-worker.ts)、[执行存储](./src/harness/run-execution-store.ts)、[模型预算](./src/harness/model-budget-store.ts)、[发布账](./src/harness/publication.ts)、[Run API](./src/modules/harness/runs.service.ts)。阶段实现与实际验证分别报告；P1 的 deep 已实现为显式触发、强制 shadow 的只读工作流，见 [实现与验证边界](HARNESS_DEEP_REVIEW.md)；Fix 已实现为独立建议/隔离验证/人工审批子 Run，GitHub 受控 Draft PR、GitLab suggestion-only，见 [Fix 实现边界](HARNESS_FIX.md)；Evolution 的 P3a 反馈、独立标注及冻结数据集已实现，见 [Evolution 实现边界](HARNESS_EVOLUTION.md)；P3b 进一步提供受限候选与生产路径离线回放，P3c 继续接入受控发布。功能实现不等于独立质量验收。

## 优势、短板与补强顺序

EvoAgent 值得借鉴的是明确的专业角色、受限工具、证据引用、Critic 反驳和失败案例回流。它的局限在于这些能力的存在不自动证明生产中的租户隔离、网络沙箱、外部写入幂等和评测无泄漏。尤其不能照搬仅校验 evidence 形状的 gate，也不能把模型生成的 delegation/budget 变更直接用于生产策略。

PR-Agent 的优势是现有平台和产品功能可以直接复用，不必为了多 Agent 重新搭建服务。原有短板是单次审查缺乏角色独立恢复、跨文件证据检索、显式 partial coverage、独立修复验证和受控评测回流。新增 Harness 解决的是运行可靠性；它本身不提高模型推理质量。

补强按四层推进：

1. **P0：可靠执行。** PostgreSQL、Run API、租约、预算、checkpoint、统一 publication、对账、运维与故障验证。
2. **P1：只读深审。** Security + Correctness/Reliability 并行，Critic 只能处理已有候选，最终由代码校验证据和位置。角色失败、截断、工具超时必须显示覆盖不完整。
3. **P2：受控修复。** FixRun 默认只产 patch；同一回归测试在原代码上失败、修复后通过且原回归不恶化，满足精确审批才有资格创建 Draft PR。缺 verifier 时保持 suggestion。
4. **P3：离线演化。** 反馈先是 observation，双人标注/仲裁后才作标签；真实数据隔离评测、人工审批与灰度/回滚构成发布门。缺数据时保留研究提案，不能宣称演化有效。

## 为什么暂不引入 Redis 或 Kafka

多 Agent 不要求消息 Broker。当前所有角色共享一个服务与 PostgreSQL，`job_queue + SKIP LOCKED` 已能提供单一执行权；事件历史同时支持 SSE 重连。增加 Redis/BullMQ 会引入第二份调度状态；增加 Kafka 则还需要 Outbox、至少一次消费与跨服务权限协议，而当前没有相应业务交付需求。

若后续测量证明 SSE fanout 或缓存成为瓶颈，可以引入 Redis 作为加速层，持久事实仍在 PG。若需要跨服务/跨区域事件消费，再考虑 Kafka 和事务 Outbox。该选择应由实际负载与部署边界触发，不能把中间件数量当作多 Agent 成熟度。

参考的 12 表模型按职责落地：Run、Step、Event、model/tool calls、checkpoint、usage、audit、job、dead letter 和 repository operation；PG 内直接事务投递 job 时，没有创建“数据库 outbox 再投递回同数据库 job”的重复流程。新增命令、审批、证据和评测表则承担自己的并发和审计责任，不追求字面上的恰好 12 张表。
