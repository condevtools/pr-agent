# Backend

后端负责 PR 事件接入、仓库读取、模型执行、多角色评审、Fix、Evolution，以及长生命周期 Agent 的持久化运行。源码按能力组织：`agent-runtime/` 管理 Run、队列、持久化和恢复；`model/` 管理模型调用；`review/` 编排评审；`fix/` 和 `evolution/` 分别负责修复建议与持续演进；`integrations/` 对接 GitHub、GitLab 和通知渠道；`http/` 提供 API。

## 文档

- [Agent Runtime](docs/agent-runtime.md)：运行时、PostgreSQL、权威边界和恢复机制。
- [Run API](docs/run-api.md)：HTTP 接口、鉴权、命令和事件流。
- [运维手册](docs/operations.md)：启停、迁移、备份、容量和故障处理。
- [深度评审](docs/deep-review.md)：角色协作、证据门槛和影子运行。
- [Fix](docs/fix.md)：修复提案、验证、批准和发布。
- [Evolution](docs/evolution.md)：反馈、数据集、评测和版本发布。
- [EvoAgent 对比](docs/evoagent-comparison.zh.md)：两个项目的代码架构、能力差异和取舍。
- [验收证据](validation/README.md)：历史工程验证、容量测量和模型评测的适用边界。

## 本地运行

以下命令从仓库根目录执行。先根据根目录示例准备本地 `.env`；不要提交密钥。

```sh
pnpm install --frozen-lockfile
docker compose up -d --build
```

`docker compose` 启动后端及 PostgreSQL，无需在宿主机安装数据库。缺少对应平台或模型凭据时，相关集成功能不可用。

`pnpm --filter backend dev` 是宿主机开发入口，读取根目录 `.env`。使用前需配置宿主机可访问的数据库地址，并避免与 Compose 后端占用同一端口；默认 Compose PostgreSQL 仅在容器网络内开放。

## 验证

建议依次执行静态检查、构建、普通测试和构建产物检查：

```sh
pnpm --filter backend check
pnpm --filter backend build
pnpm --filter backend test
pnpm --filter backend test:coverage
pnpm --filter backend test:build
```

PostgreSQL 套件使用 runner 创建的隔离 Docker 容器和独立数据库：

```sh
pnpm --filter backend test:harness:pg
```

普通测试会保留需要真实 PostgreSQL、Docker 沙箱或外部条件的跳过项，因此普通套件通过不能代替对应的 Docker 验证。测试目录按业务能力与源码相互对应；`.pg.test.ts` 后缀表示 PostgreSQL 执行条件，`support/` 与 `fixtures/` 保存公共辅助代码和夹具。测试和合成样本只证明各自覆盖的工程行为，不能据此宣称真实模型质量已经通过独立验收。
