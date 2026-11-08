# Hermit 槽位认证验收：2026-11-08

## 结论

最终实际控制容器轮次通过 80 项检查。HTTP 回归通过 41 项检查。原实验 Key 路径通过 19 项检查。

最终 5 个消息请求均使用更换后的槽位 Key。请求不含 Bearer 认证头。请求来源均为受管出口 `127.0.0.2`。最终轮次通过源码固定、外网隔离、进程清理、daemon 删除和临时目录删除检查。

本切片修改 vm2api 的凭据选择和内核复用检查。Hermit 的 Go 代码、hook 和包能力没有改变。生产激活限制保持不变。

## 验证边界

实验在 primaryserver 的独立 Docker daemon 中运行。实验使用实际 Compose 控制容器、标准槽位创建路径、固定内外 Claude Code 2.1.318、实际受管 Hysteria 2 和本地模拟消息上游。实验不访问真实账号或外部消息服务。

槽位 Key 与全局实验 Key 不同。实验通过统一凭据写入器生成合成凭据，不调用面板凭据导入接口。

## 验证行为

- 缺失文件、空 Key、Bearer、未封存权限、符号链接、错误凭据类型、混合凭据和自定义端点应拒绝启动。
- 无效槽位凭据不应回退到全局实验 Key。
- 统一存储的 `0444` 封存模式应保留。
- `native-slot.json` 应使用 `0600`。配置不应包含 refresh token。
- 活动内核凭据改变时，显式激活应返回 `hermit_authentication_changed`。
- 停止槽位、写入新 Key、再启动槽位后，内层 CLI 应使用新 Key。
- 上游请求应只发送槽位 `x-api-key`，不应发送 Bearer 认证头。
- Key 不应出现在激活响应和控制平面日志中。
- Read、外部 MCP、工具结果续接和完整历史恢复应成功。
- 控制容器重启后，槽位应继续使用同一 Key。
- helper 故障应禁止直连，原有探测应修复出口。

活动 CLI 固定使用启动凭据。普通消息不热加载凭据。换 Key 的顺序见 [认证说明](hermit-authentication.md)。

## 镜像与源码

最终候选控制镜像：

```text
sha256:3079f9b979b140d04b83a3f65b5e50a89818032913adf2e1710c360ef734adca
```

候选镜像中的 390 个源码文件及实际入口摘要与本地构建记录一致。候选镜像沿用固定基础镜像及依赖锁。该镜像不是完整生产发布构建。

## 失败记录

`auth-red` 证实旧版本在槽位 Key 缺失时仍返回激活成功。

`auth-control-final` 在换 Key 时失败。新增门禁错误拒绝了统一存储的 `0444` 封存格式。测试在负面用例后使用 `0600` 恢复文件，掩盖了初始格式冲突。修正后的测试保留原模式，并检查封存模式。统一凭据模块没有改变。失败轮次的隔离和清理检查通过。

`auth-control-sealed` 随后通过 77 项检查。最终轮次补齐停止槽位后换 Key 的请求验证，并通过全部检查。各轮输出分别保留。

`auth-control-rotation` 的停槽和新 Key 启动均成功，但首个请求失败。停槽终止了容器内的模拟上游转发进程。测试现已重新启动转发进程，并检查监听端口就绪。生产代码没有因此改变。

## 工件与复现

本地证据目录：`.tmp/hermit-auth-20261108/`。最终 primaryserver 目录：`/tmp/hermit-native-linux.GgJ0o4/auth-control-complete`。

使用 [控制容器实验](hermit-control.md) 的输入和命令。增加 `--slot-api-key`，并指定本页的候选控制镜像。使用新的输出目录。`reproduction.json` 记录本轮固定输入。`primaryserver-evidence.tar.gz` 保存源码、请求、工具结果、镜像核对及清理收据。`artifact-sha256.json` 记录本地工件摘要。

## 未验收范围

OAuth 刷新、生产 helper 认证、真实上游、真实账号和面板凭据导入均为 NOT RUN。`helper_integration` 仍为 `false`。本轮没有修改 Go 代码，也没有新增单元测试。
