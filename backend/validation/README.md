# 验收证据归档

本目录保存已经执行过的工程验收、容量测量和模型评测证据。每份文件只证明其记录的代码提交、环境、数据和门槛；它们是历史快照，不会随着当前代码变更而改写，也不能单独代表生产环境已经通过验收。

## 工程验收

- [P1](engineering/p1-verification.json)：Agent Runtime 与深度评审基础验证。
- [P2](engineering/p2-verification.json)：Fix 工作流工程验证；生产资格仍以文件中的结论为准。
- [P3A](engineering/p3a-verification.json)：反馈与 Evolution 数据链路验证。
- [P3B](engineering/p3b-verification.json)：候选评测和研究草案验证。
- [P3C](engineering/p3c-verification.json)：发布控制与综合工程验证。合成 fixture 不能证明真实模型质量。

## 容量测量

- [首轮反例](capacity/p0d-capacity-first-counterexample.json)：保留当时的原始结果。文件中的 `passed: true` 来自遗漏延迟门槛的旧验证器，已经作废，不能作为容量通过证明。
- [资格测试](capacity/p0d-capacity-qualified.json)：修正判定后重新执行的隔离环境结果；适用边界以报告字段和运维文档为准，不等于生产 SLO。

## 模型评测

- [真实模型冒烟](model/real-model-smoke-verification.json)：验证模型调用和核心流程可运行，不是独立真实 PR 质量验收。
- [EvoAgent 100 条合成样本报告](model/evoagent-100/evoagent-100-real-model-report.zh.md)及其[机器可读汇总](model/evoagent-100/evoagent-100-real-model-summary.json)：用于工程回归和问题定位，正式质量状态为 `NOT_VERIFIED`。该合成数据没有独立人工标注，不能据此宣称真实 PR 质量达标。

临时日志、原始运行输出和本机诊断产物应写入本地且不提交的 `.omx/` 等输出目录。只有经过脱敏、能够说明适用范围且需要长期审阅的稳定证据才进入本归档。
