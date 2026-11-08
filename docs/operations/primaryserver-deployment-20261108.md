# primaryserver 正式部署记录

## 部署结果

2026-11-08，已按用户授权替换 primaryserver 线上 vm2api。
部署目录为 `/opt/vm2api`，Compose 项目为 `vm2api`。
本次只重建 `vm2api` 服务。
现有槽位、受管出口和其他容器保持原容器身份。

| 项目 | 固定身份 |
| --- | --- |
| vm2api 版本 | `1.4.042` |
| vm2api 源码 | `305246a0b0ba8086341ffec8c7548fc160dfc30e` |
| Hermit 源码 | `26c3921ba14b417b69c1765034b9ce779dda078f` |
| 部署镜像引用 | `ghcr.io/dofastted/vm2api:commit-305246a0` |
| 部署镜像 ID | `sha256:955a027a0cc718875299fe63ecd53d475b1f4000b4d540b5c7579446ee6a0e30` |
| 当前容器 ID | `30ea6ba478b42439a0187605b8a6d742682979ac7d8b00144a71652ad773b529` |
| 原镜像引用 | `ghcr.io/dofastted/vm2api:commit-94df6a23` |
| 原镜像 ID | `sha256:a601451f8dc0d9434ca32ec7fc80ba4886acc8c35bd7d5a0f3566fc04ffe34d1` |

镜像由已提交源码通过完整标准 Dockerfile 构建。
构建包含前端和当前 Go helper。
镜像中的 389 个源码文件与发布源码一致。
部署镜像引用仅在 primaryserver 本地创建。
本次没有推送源码或镜像。

## 部署前验收

验收使用本次完整镜像和本次 Hermit 包。
验收使用隔离 Docker daemon、真实内外 CLI 和模拟 TLS 上游。

| 场景 | 结果 |
| --- | --- |
| OAuth 完整流程 | PASS，80 项检查 |
| API Key 完整流程 | PASS，104 项检查 |
| 工具执行等待期间重启控制平面 | PASS，原工具结果按外层工具 ID 续接 |
| 外部工具执行次数 | PASS，工具只执行一次 |
| TLS 错误证书拒绝和受管出口恢复 | PASS |
| 源码固定、命名空间和测试进程清理 | PASS |
| 独立容器管理页检查 | PASS，`/cc` 及 5 个资源与镜像一致 |

上述验收没有调用真实上游，也没有消费真实订阅。

## 线上验收

1. 通过现有调度接口暂停槽位调度。
2. 等待在途请求降至零。
3. 停止 vm2api，并备份配置、数据库、凭据和持久化文件。
4. 只修改 `.env` 中的 `VM2API_IMAGE` 和 `VM2API_IMAGE_TAG`。
5. 用新镜像重建 vm2api。
6. 核对 `/health` 返回 `ok`。
7. 核对管理页 `/cc` 返回 HTML。
8. 核对页面引用的 5 个资源与构建镜像逐字节一致。
9. 核对 `vm-01` 保持运行，内核健康检查返回 200。
10. 核对凭据摘要和现有槽位内核选择保持不变。
11. 恢复调度，并确认 `schedule_off=false`。
12. 核对其他容器身份保持不变。

最终部署收据为 `PASS`，阶段为 `active`。
生产环境没有启用 `KIN_KERNEL_TEST_ENDPOINTS`。
本次没有主动发起真实模型请求。

首次切换已通过 API、内核和凭据检查。
首次页面检查误用了返回健康 JSON 的 `/`，导致检查失败。
自动回滚恢复了原镜像和调度。
修正检查路径为 `/cc` 后，独立容器检查通过。
第二次切换使用同一镜像，并通过全部部署检查。
首次失败收据保存在发布目录的 `attempt-1/` 中。

## Hermit 安装状态

已安装独立包 `0.0.0-candidate.26c3921`。
归档 SHA-256 为 `f6b9c0ff06cfe685363044400f1fb0ce1e9583648d50f8100b6238caea44859f`。
共享官方 CLI 版本为 `2.1.318`。
CLI SHA-256 为 `708c77b204db30086ff6f1ed34577bda03e1be74ced80557cbf7b54249ebf0bd`。

安装没有激活 Hermit。
现有 `vm-01` 继续使用原内核。
Hermit 包仍声明 `production:false`。
正式替换 vm2api 不代表 Hermit 已通过真实账号验收。

## 证据和回滚

primaryserver 发布目录：

```text
/opt/vm2api-releases/20261108-305246a0
```

该目录保存源码归档、镜像身份、完整验收工件和部署收据。
`deployment.json` 保存最终切换结果。
`frontend-verification.json` 保存管理页资源摘要。
`final-verification.json` 保存恢复调度后的检查结果。

警告：`backup/` 和 `previous-container.json` 含生产配置或凭据。
不要把这些文件下载到源码目录，也不要提交这些文件。

`backup/.env` 保存原镜像选择。
`backup/state.tar.gz` 保存停机后的持久化文件。
`backup/kin.db` 保存通过一致性检查的数据库副本。
`rollback-image.tar` 保存原镜像。

需要回滚时，先暂停调度并等待在途请求结束。
再恢复原 `.env`，并只重建 `vm2api` 服务。
最后核对健康、槽位和凭据，再恢复调度。
不要直接覆盖部署后已变化的数据库或凭据。

本地脱敏收据目录为 `.tmp/primaryserver-production-305246a0/`。
本记录在部署后添加，不属于已部署源码提交。
