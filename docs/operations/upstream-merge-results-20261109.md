# 上游合并验收记录：2026-11-09

## 来源

本次将 `upstream/main` 的 `ba0778fac6b83a367d1920c056fe5c8e23964b62` 合并到自己的 `main`。
上游版本为 `1.4.054`。合并前自己的 `main` 为 `10c5e0e43bd81672067be1421b1af069600632d3`。
合并提交为 `4b48ef004f898f5ffe836638a79391a1e5d01d83`。该提交保留两个父提交。
后续提交只调整端到端测试并添加本记录，不改变镜像中的应用代码。

## 合并结果

- 保留 Hermit 独立包、槽位绑定、helper 路径和安装门禁。
- 保留离线发布包、独立升级执行器、回滚和凭据保护。
- 接入上游 Crag 版本安装页面、许可检查和槽位锁。
- 接入上游请求排空。排空完成后才停止 Hermit 内核。
- 接入上游代理管理权限。普通用户和超级用户访问管理接口时返回 `403`。
- 同时构建 `kin-redact`、`kin-egress` 和 `kin-api-kernel`。
- 保留迁移 `054`。升级执行器仍会在排空前拒绝未执行的数据库迁移。

Hermit 包仍需显式选择槽位并激活。合并不会自动切换内核。

## 验收结果

| 验收边界 | 结果 |
| --- | --- |
| Linux 完整镜像 OAuth 模拟端到端 | PASS，81 项 |
| Linux 完整镜像 API Key 模拟端到端 | PASS，105 项 |
| Linux 离线升级模拟端到端 | PASS，21 项 |
| Linux 脱敏重放 | PASS，9 项 |
| Hermit、代理及面板权限聚焦端到端 | PASS，14 项 |
| 前端既有测试 | PASS，76 个文件、596 项 |
| 前端构建、类型检查、Prettier | PASS |
| Biome | PASS，738 个文件 |
| worker Go 检查和既有测试 | PASS，12 个包、70 项 |
| api-kernel Go 检查和既有测试 | PASS，3 个包、4 项 |
| 真实模型服务及真实账号请求 | NOT RUN |
| 生产部署 | NOT RUN |

Linux 验收使用真实 Docker 和官方 Claude Code 可执行文件。
模型响应、认证材料及出口目标均由隔离测试环境提供。
验收覆盖外部工具等待期间重启控制平面后的结果续接。
验收确认工具结果保留原外部工具 ID，并且工具只执行一次。
离线升级验收覆盖迁移拒绝、镜像离线导入、损坏包拒绝、回滚和凭据保持。
所有验收收据均确认临时进程、网络命名空间和 Docker daemon 已清理。

macOS 完整端到端测试仍有 67 个失败项。合并前自己的 `main` 也有相同的 67 个失败项。
macOS 既有 Node 测试仍有 100 个失败项。其中 88 项也出现在上游基线，另 12 项也出现在合并前自己的 `main`。
两次比较均未发现合并后新增的失败项。完整测试集不标记为 PASS。
macOS 脱敏重放为 8/9。上游基线也为 8/9。Linux 相同重放为 9/9。
本次没有新增或修改单元测试。

初次 Linux OAuth 和 API Key 验收在代理探测处失败。
上游探测需要收到应用层响应。旧测试监听器只接受连接后关闭。
测试监听器现返回有效的 DNS 响应，并检查实际响应次数。
应用中的探测规则未放宽。修正后的两次验收全部通过。初次失败收据保留。

## 镜像及证据

完整镜像 ID：

```text
sha256:a7546cabb1df44d7dbd09337fde85736808881dc8f7d8d09018eddca9b55a8c4
```

镜像来源为合并提交 `4b48ef004f898f5ffe836638a79391a1e5d01d83`。
验收逐文件比较了镜像中的应用源码、脚本及入口与该来源。

本地证据目录为 `.tmp/merge-upstream-20261109/`。
汇总为 `summary.json`。Linux 收据归档为 `linux-acceptance.tar.gz`。
`linux/acceptance-oauth-v2/`、`linux/acceptance-apikey-v2/` 和 `linux/offline-acceptance/` 保存通过收据。
`e2e-baseline-comparison.json` 和 `unit-final-comparison.json` 保存基线比较。
`linux/oauth-v2-args.json` 和 `linux/apikey-v2-args.json` 保存原始重放参数。

primaryserver 的可重复验收目录为 `/tmp/vm2api-merge.t5TjJ0`。
该目录保存冻结源码、构建日志、输入哈希和验收参数。
本次未下载生产凭据或生产数据库。

## 部署边界

生产容器仍为 `30ea6ba478b42439a0187605b8a6d742682979ac7d8b00144a71652ad773b529`。
生产镜像仍为 `sha256:955a027a0cc718875299fe63ecd53d475b1f4000b4d540b5c7579446ee6a0e30`。
本次只合并源码并推送到自己的 `origin/main`。

警告：从迁移 `053` 升级到 `054` 前，应单独制定数据库迁移和回滚方案。
当前离线升级执行器会拒绝该迁移，不会自动绕过检查。
