# Hermit 全部 helper 验收记录

## 结论

Hermit 和 vm2api 已接入全部七项原生 helper：`refresh`、`usage`、`profile`、`models`、`count-tokens`、`reset-status`、`reset-redeem`。本轮完成合成 OAuth 和 API Key 的端到端验收。hook 和固定官方 Claude Code 2.1.318 没有改变。

真实账号、真实 OAuth 服务、真实消息上游、生产 TLS 和生产部署仍为 NOT RUN。包的 `production` 保持 `false`。本轮没有推送或部署，也没有调用真实订阅。

## 固定工件

```text
Hermit source base: e03862c (dirty: true)
vm2api source base: eb57650f (uncommitted changes)
Hermit package: 0.0.0-dev.helpers.ready.e03862c
archive sha256: f37ccf230ca8e195d2ad6b00045a39552a611dac5ff5d25f7ffe8c7066b2b4c3
manifest sha256: 470b2369f0cec86da8dd2af4997ddfb8d4c3d74e472355e8a4636e1a233a6ad5
Hermit binary sha256: 73fb0de238916c0ed87796c612ba9e1e52aa510baf5762e83f95280bc4f47778
control image: sha256:8bdf4ea4913256ae745f85b60bcdea1daf92bc6495a18f177c0ae8d594c0f003
Claude Code version: 2.1.318
Claude Code sha256: 708c77b204db30086ff6f1ed34577bda03e1be74ced80557cbf7b54249ebf0bd
```

包不包含官方 CLI 二进制。槽位继续使用固定摘要的共享 CLI。Hermit 的 108 项源码摘要与最终包清单一致。候选控制镜像的 391 项源码及入口校验通过。该镜像叠加当前后端源码，不是完整生产发布构建。

## 验证结果

| 场景 | 结果 | 验证边界 |
| --- | --- | --- |
| 原生全部 helper | 53 项 PASS | 实际包二进制、Unix socket、隔离网络、模拟上游 |
| 原生 models-only 兼容 | 33 项 PASS | 最终包未配置新 helper 时的旧行为 |
| API Key 实际控制容器 | 84 项 PASS | 实际 Compose、固定内外 CLI、受管 Hysteria 2 |
| OAuth 实际控制容器 | 67 项 PASS | 实际 Compose、固定内外 CLI、刷新与消息续接 |
| 旧包和能力拒绝 | 26 项 PASS | 完整 HTTP、真实 API kernel、记录调用的进程替身 |
| 版本包 HTTP | 43 项 PASS | 上传、安装、共享 CLI 缓存、helper 入口校验 |
| 原内核凭据接口 | 3 项 PASS | 导入、原刷新路径、凭据替换 |

原生实验覆盖全部操作、内部认证、错误认证模式和并发拒绝。实验还覆盖非法 reset、认证头覆盖、凭据反射和异常上游响应。无效 grant、RT-only 初始化和令牌轮换也已验证。无效或超大的 token 响应不会保存凭据，也不会自动重试。兑换传输失败返回未知结果，且不重复兑换。

API Key 容器实验保留原有拒绝门禁、换 Key、模型同步、Read、外部 MCP、控制平面重启和出口故障恢复。API Key 不适用的 OAuth 操作返回 `credential_mode_unsupported`。

OAuth 容器实验验证以下顺序：

1. 通过管理接口显式刷新令牌。
2. 保存轮换后的 canonical 凭据。
3. 关闭旧 owner 并创建新 owner。
4. 用新 access token 发起下一条消息。
5. 将令牌设为过期，再发起消息。
6. 在 CLI 发送请求前触发 `needs_refresh`。
7. 完成第二次刷新、owner 重建和消息重试。

OAuth 实验只发生两次 refresh grant。两次均使用预期的轮换 refresh token。所有消息、模型查询和刷新请求均来自受管出口 `127.0.0.2`。refresh token 没有进入内层 CLI 配置。外部工具未重复执行，完整外部历史得到恢复。

两轮实际控制容器均满足以下条件：

- `source_unchanged: true`。
- `namespace_gone: true`。
- `daemon_removed: true`。
- `fixture_removed: true`。
- `unexpected_processes` 为空。

原生实验的 owner 清理和 IPv4、IPv6 外网拒绝均通过。宿主生产 vm2api 仍运行 `commit-94df6a23`。实验使用独立的无外网 Docker daemon。

本轮没有新增或修改单元测试。原内核凭据接口只运行上述三个用例。既有完整凭据套件中的槽位 reset 用例没有计为本轮通过。上一切片已在干净基线复现该用例缺少 `kin-computer` 的错误。

## 复现和证据

当前契约见 [helper 说明](hermit-helper.md)。原生入口为 Hermit 的 `experiment/native_helpers_e2e.py`。实际容器入口为 `test/e2e/hermit-factory.py`。分别使用 `--slot-api-key` 和 `--oauth`。

本地工件目录为 `.tmp/hermit-all-helpers-20261108/`。目录保留以下工件：

- `primaryserver-evidence.tar.gz`：两轮实际容器、原生 53 项、兼容 33 项和清理收据。
- `hermit-source-snapshot.tar.gz`：最终包的源码、原生实验和协议文档。
- `control-context.tar.gz`、`vm2api-source.tar.gz`：控制镜像输入和实验源码。
- `hermit-manifest.json`、`hermit-release.json`：最终包身份。
- `helpers-*-control-args.json`：两种认证的完整执行参数。
- `verified-summary.json`：下载后重新核对的验收结果。
- `compatibility/`、`packages/` 和 `credentials.tap`：HTTP 回归工件。
- `artifact-sha256.json`：本地工件摘要。

primaryserver 的最终目录为 `/tmp/hermit-native-linux.GgJ0o4/all-helpers-package-verified`、`models-helper-backcompat-ready`、`helpers-apikey-control` 和 `helpers-oauth-control`。最终包保存在 Hermit 的 `experiment/evidence/native-helpers-ready-20261108/package/`。

工件中的令牌均为合成值。生成包、共享 CLI 输入和原始工件由忽略规则排除，不应加入源码提交。
