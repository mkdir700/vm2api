# Hermit 控制平面容器与路径验收

## 范围

本实验通过仓库的 `docker-compose.yml` 和实际 `vm2api-entrypoint` 启动控制平面。它继续使用独立 Docker daemon、真实受管 Hysteria 2 和模拟消息上游。生产激活限制保持不变。

控制平面使用 `/opt/vm2api`。宿主安装目录使用随机的 `/tmp/hmf-*/fixture/p`。实验不设置 `VM2API_HOST_ROOT` 或 `KIN_HOST_ROOT`。控制平面应通过 Docker socket 自省实际挂载，再为兄弟槽位换算宿主路径。

## 镜像与入口

测试候选镜像基于固定控制镜像。构建时复制当前受控后端源码、脚本、仓库 Compose 文件、实际入口和固定 API/egress helper。依赖锁与固定基础镜像一致。构建上下文只包含 Git 跟踪的源码和明确的实验输入。

候选镜像不代表完整生产发布构建。本阶段没有重新构建前端或重新下载整套发布 payload。它验证当前后端在实际控制容器中的行为。

实际入口应把 helper 写入挂载的 `bin/`。实验核对 API kernel、kin-egress 和 kin-computer 的摘要。每次重启后再次核对。

## Compose 与挂载

实验复制仓库 Compose 文件到独立安装目录。测试覆盖文件只替换 Docker socket 的源路径，并禁止拉取控制镜像。其余目录挂载、权限、网络和入口继续使用仓库定义。测试参数通过私有 `.env` 提供。

| 内容 | 控制平面路径 | 宿主路径 |
| --- | --- | --- |
| 版本包与共享 CLI | `/opt/vm2api/share/kernel-packages` | 随机安装目录的 `share/kernel-packages` |
| 槽位运行目录 | `/opt/vm2api/vms/vm-hermit/run` | 随机安装目录的 `vms/vm-hermit/run` |
| 受管出口配置 | `/opt/vm2api/data/managed-egress` | 随机安装目录的 `data/managed-egress` |

槽位内继续使用 `/opt/kin-kernel-packages` 和 `/run/kin`。实验检查实际槽位的 Docker 挂载源。它还检查槽位记录保留控制平面内部路径。

helper 的 PID 和控制 socket 属于控制容器。停止与检查 helper 时，测试通过真实 `docker exec` 在该 PID 命名空间执行操作。测试不把容器 PID 当作宿主 PID。

## 验证流程

实验沿用受管 Hysteria 2 流程，验证包安装、共享 CLI 缓存命中、标准槽位创建、外部 Read/MCP、工具结果续接和完整历史恢复。它还验证 helper 停止时禁止直连，以及错误 Hysteria 2 密码的应用失败和恢复。

控制平面重启通过实际 Compose 停止和启动完成。旧 Hermit 进程组应退出。新内核应使用新的会话目录。共享缓存与版本绑定应保留。

## 复现

使用 `test/fixtures/hermit-control.Dockerfile` 构建固定候选镜像。保留构建上下文摘要、基础镜像 ID、候选镜像 ID 和构建日志。

在 [受管出口实验](hermit-managed-egress.md) 的命令中添加：

```sh
--control-image sha256:FULL_CONTROL_IMAGE_ID
```

该参数要求同时指定 `--managed-image`。每次使用新的输出目录。驱动不修改宿主现有 Compose 项目。

保留 `compose-resolved.json`、`control-container.json`、`control-runtime.json`、`control-helper-pins.json`、槽位挂载检查和最终清理收据。

## 未验收范围

真实 OAuth、生产 helper 认证、真实消息上游、生产 TLS 证书、已有槽位内核切换和执行中工具恢复仍需独立验收。本阶段没有调用真实订阅，也没有上线生产。
