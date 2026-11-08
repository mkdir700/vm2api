# Hermit 控制平面容器验收：2026-11-08

## 结论

真实控制平面容器实验通过 53 项检查。原非容器控制平面的 Hysteria 2 流程复验通过 55 项检查。两轮均通过源码固定、外网隔离、进程清理、容器删除和临时目录删除检查。

本轮没有修改生产逻辑。它复用已提交的 vm2api 后端和现有路径换算模块。新增变更为端到端实验、候选镜像定义和文档。生产激活仍默认拒绝。

## 已验证行为

- 仓库 Compose 文件启动实际控制容器、受管客户端和初始化服务。
- 实际入口脚本启动控制平面，并写入固定 helper。
- 控制容器内项目路径为 `/opt/vm2api`。
- 宿主安装目录为随机测试目录。两个路径不同。
- `VM2API_HOST_ROOT` 和 `KIN_HOST_ROOT` 均为空。
- 控制平面通过 Docker 自省换算包目录和槽位运行目录。
- 槽位实际挂载源为宿主目录，版本包挂载保持只读。
- 槽位记录保留控制平面内部路径。
- 控制容器重启后，helper 摘要、共享 CLI 缓存和版本绑定保持有效。
- Read、外部 MCP、工具结果续接和完整历史恢复成功。
- helper 停止时禁止直连回退，代理探测可以修复 helper。
- 错误的 Hysteria 2 密码不能替换原绑定。移除错误配置后消息恢复。

最终五个消息上游请求均来自受管出口 `127.0.0.2`。消息上游仍为模拟服务。

## 镜像与源码

```text
host: primaryserver
control Node: 22.23.2
experiment driver Node: 22.23.4
base control image:
sha256:a601451f8dc0d9434ca32ec7fc80ba4886acc8c35bd7d5a0f3566fc04ffe34d1
candidate control image:
sha256:88251158b203e413e1881da95574c4e8280d48b3b71859e8bb2f2c2ae29f5b1e
```

基础镜像的依赖锁摘要与当前仓库一致。候选镜像叠加当前受控后端源码、实际入口和固定 API/egress helper。镜像中的 389 个源码文件及入口脚本均与记录的源码摘要一致。

该候选镜像不是完整生产发布构建。本轮没有重新构建前端或重新下载全部发布 payload。测试使用实际 Compose 文件、实际服务进程和实际容器挂载。

测试参数通过独立 `.env` 提供。Compose 测试覆盖文件只替换 Docker socket 源路径，并禁止拉取控制镜像。控制容器没有设置显式宿主项目根目录。

## 工件与复现

复现方法见 [控制平面容器说明](hermit-control.md)。每次使用新的输出目录。

本地证据目录为 `.tmp/hermit-control-20261108/`。`primaryserver-evidence.tar.gz` 包含两轮原始输出、源码快照、Compose 解析结果、容器信息、实际挂载、消息请求、helper 摘要、镜像源码核对结果和构建日志。`artifact-sha256.json` 记录工件摘要。

primaryserver 主实验目录为 `/tmp/hermit-native-linux.GgJ0o4/control-red`。该轮收据和完整检查结果均为 PASS。回归目录为 `/tmp/hermit-native-linux.GgJ0o4/control-managed-regression`。

## 剩余范围

真实 OAuth、生产 helper 认证、真实消息上游、生产 TLS 证书、已有槽位内核切换和执行中工具恢复仍为 NOT RUN。本轮没有调用真实订阅，未部署生产。

下一切片先统一真实认证和 helper 契约，并准备隔离验收。真实订阅请求仍应单独授权。
