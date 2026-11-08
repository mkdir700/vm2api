# Hermit 与受管 Hysteria 2 联合验收

## 范围

本实验复用 vm2api 的 `ManagedEgressHost`、`ManagedEgressDocker`、代理池和标准槽位创建路径。它不增加 Hermit 专属出口类型。生产激活限制保持不变。

实验使用真实 sing-box Hysteria 2 服务、真实受管客户端容器、真实透明出口 helper，以及固定的内外 Claude Code。消息上游使用本地模拟服务。实验不使用真实订阅。

## 隔离环境

在 primaryserver 创建独立 Docker daemon。外层容器使用 `--network none`。网络、iptables、Compose 标签、镜像标签和测试槽位均属于该 daemon。

受管客户端使用源码指定的固定 sing-box 镜像摘要。驱动校验导入镜像的 ID、配置和根文件系统。它在隔离 daemon 中恢复仓库标签，使固定摘要引用可以解析。生产镜像身份检查保持不变。

Docker 29 的默认容器镜像存储保留原始镜像摘要。经典 vfs 存储在本实验的离线导入中没有保留仓库摘要关联。因此，受管场景使用固定的 Docker 29 镜像。原 SOCKS5 场景仍可使用 Docker 27 与 vfs。

控制平面由测试驱动在隔离网络中启动。一个实际 Docker 控制容器提供 Compose 项目标签和挂载身份。受管客户端使用只读根文件系统、只读配置挂载和 `--network host`。这里的 host 是隔离 daemon 的网络，不是生产宿主网络。

Hysteria 2 服务使用临时自签名证书。测试配置设置 `insecure: true`。该配置只验证本地 TLS 与协议链路，不证明生产证书验证已经通过。

## 检查流程

1. 启动真实 Hysteria 2 服务。
2. 用错误的可写配置挂载创建受管客户端。
3. 通过管理 API 导入出口。
4. 确认配置未应用，出口不能绑定槽位。
5. 修正只读挂载，再调用应用接口。
6. 确认配置已应用，出口进入就绪状态。
7. 确认管理响应不包含监听器凭据。
8. 绑定槽位，验证认证探测和 helper 控制 socket。
9. 通过标准路径创建 Hermit，并运行外部 Read 和 MCP。
10. 重启控制平面，确认出口就绪状态和完整对话恢复。
11. 停止 helper，确认流量不能回退直连。
12. 通过标准代理探测修复 helper。
13. 导入错误的 Hysteria 2 密码，验证应用失败和绑定保护。
14. 移除错误配置，再次应用并恢复消息请求。
15. 关闭测试进程，删除测试容器和 daemon。

模拟上游记录连接来源。Hysteria 2 服务的直连出口绑定到 `127.0.0.2`。来源记录确认消息经过该出口。IPv4 与 IPv6 外部地址连接均应被拒绝。

## 复现

使用 [标准创建实验](hermit-factory.md) 的完整参数，并使用以下附加参数：

```sh
--dind-image sha256:08a98015fce594af7c382883bea080ea206de74402a95da9dc52b6428c8cd121 \
--managed-image sha256:3c1ee82d450df9b336b6f63b1d272cf86e3835392d99596ef8c35f206a457999
```

驱动通过 `--managed-image` 选择受管 Hysteria 2 场景。该参数不改变生产配置。使用新的输出目录。保留 `factory-receipt.json`、`summary.json`、`checks.json`、`managed-image-identity.json` 和原始请求。

## 未验收范围

本实验没有通过真实 Compose 部署入口启动整个控制平面。它没有验证真实 OAuth、生产 helper、真实消息上游、生产证书、远端节点、KVM 或执行中工具的故障恢复。完成本实验不等于可以上线生产。
