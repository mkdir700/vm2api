# Hermit 与受管 Hysteria 2 验收：2026-11-08

## 结论

受管 Hysteria 2 与 Hermit 的隔离联合实验通过 55 项检查。原 SOCKS5 场景复验通过 40 项检查。两轮均通过源码固定、网络隔离、进程清理、容器删除和临时目录删除检查。

本轮没有修改生产逻辑。实验复用 vm2api 提交 `75392ca4` 中的代理池、受管出口管理和 Hermit 标准创建路径。新增变更为端到端实验及文档。Hermit 独立包与 Linux 支持已提交为 `7db468d`。

## 已验证行为

- 错误的可写配置挂载不会被标记为已应用。
- 未就绪出口不能绑定槽位，原槽位绑定保持不变。
- 修正只读挂载后，管理 API 成功应用配置并发布就绪状态。
- 公开响应不包含受管监听器用户名、密码或私有配置。
- 透明出口 helper 保留受管控制 socket。
- 真实内外 Claude Code 完成 Read、外部 MCP 和工具结果续接。
- 控制平面重启后恢复出口就绪状态，并恢复完整外部历史。
- helper 停止后，容器不能回退直连。标准代理探测可以修复 helper。
- 错误的 Hysteria 2 密码触发 `managed_apply_failed_rolled_back`，出口保持未就绪。
- 错误出口不能替换已有绑定。
- 移除错误配置并重新应用后，第 4 轮用户输入成功。

最终共记录五个模拟消息上游请求。全部来源为 Hysteria 2 服务绑定的 `127.0.0.2`。真实消息上游没有运行。

## 身份与证据

```text
host: primaryserver
isolated Docker daemon: 29.9.3
Docker-in-Docker image:
sha256:08a98015fce594af7c382883bea080ea206de74402a95da9dc52b6428c8cd121
managed sing-box image:
sha256:3c1ee82d450df9b336b6f63b1d272cf86e3835392d99596ef8c35f206a457999
Hermit slot image:
sha256:05516632dc38371fe17c1bd5592b87bafcb4050dba747557c5d4c8568c183c91
```

镜像按原固定摘要导入。配置和根文件系统均已核对。测试没有放宽 `ManagedEgressDocker` 的镜像、Compose 身份、网络或只读挂载检查。

本地证据目录为 `.tmp/hermit-managed-20261108/`。`primaryserver-evidence.tar.gz` 包含最终两轮、基础联合实验和镜像导入失败实验。每轮包含源码快照、请求、工具结果、镜像身份和清理收据。`artifact-sha256.json` 记录工件摘要。

primaryserver 原始目录为 `/tmp/hermit-native-linux.GgJ0o4/managed-final` 和 `/tmp/hermit-native-linux.GgJ0o4/managed-socks-regression`。它们不是部署目录。

## 复现与边界

复现方法见 [联合验收说明](hermit-managed-egress.md)。使用新的输出目录。

Hysteria 2 使用临时自签名证书及 `insecure: true`。控制平面由驱动运行在隔离网络中，控制容器提供实际 Compose 标签和挂载身份。本轮没有通过真实 Compose 部署入口运行整个控制平面。

真实 OAuth、生产 helper、真实消息上游、生产证书和执行中工具恢复仍为 NOT RUN。生产激活仍默认拒绝。测试没有调用真实订阅，也没有修改现有生产容器。
