# primaryserver 正式升级与 Hermit 交接

## 结果

primaryserver 已通过统一离线执行器升级。任务 `cbfde40110bd4f12a3cc01fa8edbf6ff` 返回 `PASS`，阶段为 `active`。
独立复核于 `2026-11-09T11:58:13+08:00` 通过，共 20 项。
Hermit 正式包已安装。没有槽位切换到 Hermit。
真实账号验证由管理员执行。

## 发布身份

| 项目 | 固定身份 |
| --- | --- |
| vm2api 源码 | `b48e7468099d0f46b2555bf4578ccdb778fe4493` |
| 活动镜像 | `sha256:cd9ae04223b3de44da55595362d3e25f9e26ba9ba38f46e64d6c5b79482adff3` |
| 活动容器 | `fceed44c6d2d5a96946e0dcddb5b3618bc5d87e791100f42c4e4e4fe58de0bea` |
| Hermit 源码 | `7204d42790c02675cacda5dcf101a62c2da08f20` |
| Hermit 版本 | `0.0.0-production.7204d42` |
| Hermit 归档 SHA-256 | `08e7e25752607d56d094f24e84fda2284cc3b9dcaf0cdda2c478f37b96c6bd8a` |
| 官方 Claude Code | `2.1.318` |
| CLI SHA-256 | `708c77b204db30086ff6f1ed34577bda03e1be74ced80557cbf7b54249ebf0bd` |

镜像从干净 Git 归档构建。Hermit 包从干净提交构建。
生产发布目录为 `/opt/vm2api-releases/20261109-b48e7468`。
该目录保留离线对象、固定执行器、操作入口和 `qualification/` 收据。
`qualification/vm2api-source.tar` 保存构建源码归档。

## 验收

| 场景 | 结果 |
| --- | --- |
| 固定完整镜像与生产模式 OAuth 模拟流程 | PASS，114 项 |
| 固定完整镜像与生产模式 API Key 模拟流程 | PASS，138 项 |
| 真实旧镜像升级、迁移、故障回滚和中断恢复 | PASS，30 项 |
| 三项最终验收的源码固定和环境清理 | PASS |
| primaryserver 统一升级 | PASS |
| primaryserver 独立复核 | PASS，20 项 |
| 真实账号模型推理 | NOT RUN |
| 管理员浏览器交互 | NOT RUN |
| 生产槽位切换 Hermit | NOT RUN，由管理员执行 |

认证模拟流程使用合成凭据和隔离 TLS 上游。
认证模拟流程没有调用真实订阅。
新会话和恢复会话均等待官方 `SessionStart` 的 MCP 就绪屏障。
实际请求仍逐次验证工具目录。工具目录不匹配时，Hermit 阻止出站。
两个认证流程均保存 `initial-mcp-ready-barrier.json`。

生产复核确认活动镜像、源码身份、管理页资源和健康接口正确。
原槽位选择、槽位容器身份、凭据、活动指针、聊天旁路文件及用户配置保持不变。
执行器已恢复原调度状态。生产环境没有启用 Hermit 实验开关。
启动生成的 `gateway-v2.public.json` 只新增 `me_quota` 和 `me_usage` 端点。
该文件是公开快照，不是用户配置。

执行器各阶段合计约 30 秒。
备份阶段为 2.6 秒。服务切换阶段为 4.9 秒。
本次没有单独测量外部不可用窗口。

## 部署前发现并修复的问题

首次生产任务在预检阶段遇到 `KeyError: id`。
升级器把 `active.json` 当作槽位记录。
该任务没有进入排空或停服阶段。原服务保留。
修复后，升级器按管理 API 的槽位身份读取文件。
端到端流程新增活动指针和聊天旁路文件保持检查。

复验还发现新会话的 MCP 启动竞态。
内部 Claude Code 的首个请求可能包含空工具目录。
原工具目录检查已阻止该请求。
Hermit 现在对新会话和恢复会话使用同一个官方就绪等待。
最终两个认证流程均通过首轮等待和实际目录检查。
失败工件保留在服务器验收目录，不用于发布资格。

## 管理员操作

当前全局设置尚未满足 Hermit 协议要求。
`official_cc_passthrough` 未启用。`eager_tool_streaming` 为 `true`。
本次部署保留了这两个设置。

警告：以下两项是全局设置。先核对其他槽位的协议要求。

1. 在后台设置中打开“官方 Claude Code 家族透传”。
2. 在连接池设置中关闭“工具参数流式下发”。
3. 保存两项设置。

警告：切换前，先完成所选槽位的工具调用。
切换会重建该槽容器。系统会拒绝仍等待外部工具结果的内核。

1. 打开后台“内核”页面，或打开槽位详情的“推理内核”区域。
2. 选择 `0.0.0-production.7204d42`。该版本已经安装，无需重新上传。
3. 选择一个 Claude 槽位。
4. 单击“切换并应用”，并确认所选槽位。
5. 等待切换结果，再执行真实账号请求和工具调用验证。
6. 验证通过后，单击“确认保留当前内核”。
7. 需要恢复原内核时，单击“回滚上次切换”。

确认保留当前内核前，系统保留旧容器用于回滚。
不要手动启动或清理该旧容器。
详细规则见[现有槽位的 Hermit 切换与回滚](hermit-kernel-switch.md)。

## 数据库与升级恢复

生产数据库从 `050` 升级到 `054`，现有 51 条迁移记录。
仓库没有 `051` 至 `053` 文件。
迁移 `054` 为 API Key 增加默认值为 `[]` 的模型白名单列。
迁移文件摘要和 SQLite 完整性检查均通过。

失败回滚保留新增列和业务写入。执行器不覆盖当前数据库或凭据。
非空模型白名单会阻止降级到不支持该限制的旧版本。
详细规则见[本机发布与线上离线升级](offline-upgrade.md)。

生产备份和私有基线保留在 `/opt/vm2api/.upgrades/`。
这些文件没有下载到本机，也没有写入仓库。
成功任务不需要执行 `recover`。

## 可重复工件

服务器验收目录为 `/tmp/vm2api-release-20261109`。
最终目录为 `acceptance3-oauth/`、`acceptance3-apikey/` 和 `offline-final3/`。
`args3-oauth.json`、`args3-apikey.json` 和 `args-offline-final3.json` 保存重放参数。
`exit3-*.json` 保存最终退出码。三个退出码均为零。
冻结源码位于 `final3-source/`。独立复核收据为 `deployment-verification.json`。
正式发布目录的 `qualification/` 也保存最终收据和构建源码归档。

本机脱敏收据位于 `.tmp/hermit-production-20261109/`。
该目录不包含生产数据库、环境文件或凭据。

本次源码和文档已提交到本机 Git。未推送 `origin`。
