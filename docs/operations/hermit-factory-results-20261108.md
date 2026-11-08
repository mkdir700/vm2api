# Hermit 标准创建与 SOCKS5 验收：2026-11-08

## 结论

标准创建与带认证 SOCKS5 的隔离端到端实验通过 40 项检查。生产激活仍默认拒绝。

本轮修复首次激活的缺口。原接口直接启动 Hermit，却没有创建缺失的槽位容器。现在，接口只在 Docker 明确报告容器不存在时调用标准创建路径。它从代理池读取完整认证绑定。所有目标启动成功后，它才发布版本绑定和运行元数据。失败时，它停止本次启动的内核和本次创建的运行容器。

## 结果

| 检查 | 结果 |
| --- | --- |
| 标准创建与透明出口完整流程 | PASS，40 项 |
| 原 Docker 模拟边界回归 | PASS，19 项 |
| HTTP 包安装与暂存回归 | PASS，41 项 |
| Docker 资源、内核路由、远端 GPT、槽位运行与容器替换回归 | PASS，106 项 |
| 源码在验收期间保持不变 | PASS |
| IPv4 与 IPv6 外网隔离 | PASS |
| 进程、容器、daemon 与临时目录清理 | PASS |
| 真实订阅与真实上游 | NOT RUN |
| 受管 Hysteria 2 导入、应用、就绪与 Hermit 联合流程 | NOT RUN |

完整流程覆盖以下行为：

1. 导入带认证的 SOCKS5，并通过标准接口绑定槽位。
2. 验证正确密码可用，错误密码被拒绝。
3. 上传 Hermit 精简包，并命中共享官方 CLI 缓存。
4. 通过激活接口调用标准创建路径，创建真实 Hermit 容器。
5. 通过标准槽位启动接口。
6. 运行真实内外 Claude Code，完成 Read、外部 MCP 和工具结果续接。
7. 重启控制平面，使用新会话目录和完整外部历史继续输入。
8. 停止透明出口 helper，确认容器不能回退直连。
9. 通过标准代理探测修复 helper。
10. 确认内核进程组和透明出口 helper 均已退出。

四个模拟上游请求的来源均为 `127.0.0.2`。该地址由带认证的 sing-box 出口绑定。这个记录确认请求经过了代理。模拟上游不代表公网服务。

## 隔离与身份

主机为 `primaryserver`。外层 Docker 为 29.9.2。隔离 daemon 为 Docker 27.5.1。隔离 daemon 使用官方镜像启动入口和私有 cgroup 命名空间。外层容器没有外部网络。

```text
slot image:
sha256:05516632dc38371fe17c1bd5592b87bafcb4050dba747557c5d4c8568c183c91
Docker-in-Docker image:
sha256:aa3df78ecf320f5fafdce71c659f1629e96e9de0968305fe1de670e0ca9176ce
imported slot image configuration:
sha256:893a006339b55426ebb6c5aa72ef8fc369271f9f4b1242ba52f00c57a2c36b52
kin-egress:
b1e570a67d3e625262e4733cbdaf5550449b2c93bc5c5912b6f903b72dd41ff9
kin-computer:
a64970838469da0e3b86831212e8f6b0806e3433a65dd062f6556252403c2bb9
```

导入镜像的配置摘要和全部根文件系统层均已核对。不同 Docker 版本显示的引用 ID 不作为单独的身份依据。

`kin-computer` 从当前安装只读复制。它的大小和摘要与 `deploy/payload.json` 一致。`kin-egress` 从当前 worker 源码交叉编译。本轮没有修改 Go 源码、官方 Claude Code 或 Hermit hook。

## 工件与复现

本地证据目录为 `.tmp/hermit-factory-20261108/`。`primaryserver-evidence.tar.gz` 包含最终实验、红灯实验、源码快照、请求、工具结果、镜像身份和清理记录。

最终原始目录为 `/tmp/hermit-native-linux.GgJ0o4/factory-final`。关键工件为 `factory-receipt.json`、`summary.json`、`checks.json`、`isolation.json` 和 `image-identity.json`。`traffic-receipt.json` 记录本地对全部四个请求的复核结果。

复现命令见 [标准创建与出口说明](hermit-factory.md)。每次使用新的输出目录。

首轮业务检查通过后，测试驱动在关闭探测 TCP 监听器时等待未结束。代理进程仍持有连接。该轮整体记为 FAIL。修复驱动的清理顺序并显式关闭测试 socket 后，最终实验通过。失败收据仍保留在证据包中。

## 后续范围

下一切片验证受管 Hysteria 2 的导入、应用、就绪和 Hermit 联合流程。随后再验证真实认证、helper 和真实上游。已有 wrap/crag 容器切换、版本回滚和执行中工具恢复仍未验收。本轮未提交代码，未部署生产。
