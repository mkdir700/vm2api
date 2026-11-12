# tag 发布与独立部署器

部署器已迁入 [true-router/deployer](https://github.com/true-router/deployer)。完整宿主机安装、固定 Compose、配置、生产锁和恢复说明由该仓库的 `docs/operations.md` 维护。

本仓库保留会话网关、业务组签名准入、执行回执、身份权威库和真实业务排空证明。现有整组发布方案不变。新旧业务组仍需独立账号、slot 和可变目录。共享 slot 改造不在本次迁移范围。

## 本仓库提供的接口

- `src/session-gateway.mjs`：持久会话归属、总准入、结算与控制接口。
- `src/lib/rollout`：业务组与网关实现。
- `scripts/rollout-install-hermit.mjs`：固定业务镜像内的包安装接口。
- `scripts/rollout-authority.mjs`：初次迁移身份元数据的运维工具。

包安装接口版本为 1。参数为绝对候选路径和 JSON，字段为 `version`、`commit`、`manifest_sha256`。成功输出 `schema=1`、`result=PASS` 与完全一致的版本、源码、清单摘要。内部继续复用既有下载和包校验器。先检查所有候选槽位，不修改活动组。部署器确认候选停止后才调用该接口。

Dockerfile 已将 `scripts` 打包进业务镜像。独立部署器必须使用包含该接口的固定镜像 digest。旧镜像缺少接口时拒绝发布。不得通过宿主机源码路径绕过固定工件。

## 初次身份迁移

先使用 `node scripts/rollout-authority.mjs --source /实际目录/data/kin.db --target /独立权威目录` 查看计划。安排窗口并停止原控制面后，再添加 `--apply --stopped-container 实际容器 --receipt /私有路径/import.json`。工具核对停止状态与挂载，保留既有身份和额度，不复制供应商凭据。此步骤不属于日常发布。

## CI 与验收

业务 tag 工作流继续构建并验收确切业务镜像，再使用原通知协议发送到部署器。`ROLLOUT_ENABLED` 默认关闭。部署器的验收已迁往独立仓库。业务镜像保留以下端到端验收：

```sh
node --test test/e2e/session-rollout.e2e.test.mjs test/e2e/rollout-group.e2e.test.mjs test/e2e/rollout-gateway-handoff.e2e.test.mjs test/e2e/rollout-authority.e2e.test.mjs test/e2e/rollout-package.e2e.test.mjs
```

包安装验收覆盖错误摘要拒绝、候选元数据保持和正确固定包安装。身份迁移验收继续核对真实 SQLite 与原 API Key 鉴权。原生双组链路使用 `test/e2e/rollout-native.py`，不依赖部署器源码。
