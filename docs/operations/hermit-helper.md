# Hermit 原生 helper 契约

## 当前行为

Hermit 原生槽位现已接入全部七个 helper。新包通过内部 HTTP 接口执行操作。vm2api 不调用旧 `kin-worker oauth`，也不加载旧 `worker.json`。

| 操作 | OAuth | Console API Key |
| --- | --- | --- |
| refresh | 支持 | 400 credential_mode_unsupported |
| usage | 支持 | 400 credential_mode_unsupported |
| profile | 支持 | 400 credential_mode_unsupported |
| models | 支持 | 支持 |
| count-tokens | 支持 | 支持 |
| reset-status | 支持 | 400 credential_mode_unsupported |
| reset-redeem | 支持 | 400 credential_mode_unsupported |

这些能力已接入模拟上游验收。真实账号和真实上游仍为 NOT RUN。包的 `production` 保持 `false`。消息和 helper 上游仍限于 HTTP 回环地址。公共计数接口仍返回 404。

## 能力选择

1. 读取活动槽位的健康响应。
2. 核对 `runtime_flavor: hermit` 和 `healthy: true`。
3. 核对 `helper_operations` 包含目标操作。
4. 新协议要求 `helper_protocol: hermit-helper-1`。
5. 通过内部 socket 调用 `POST /internal/v1/helper`。

新包的 helper 入口为 `internal-http`。入口路径为 `/internal/v1/helper`。协议名为 `hermit-helper-1`。安装器拒绝声称支持全部 helper、却仍声明旧 CLI helper 入口的包。

旧 models 包继续使用只读 models 接口。旧包没有声明的操作返回 `501 native_operation_unsupported`。缺少能力不表示凭据失效。原内核继续执行原 helper。仅有 `pending_kernel_package` 不会改变活动内核行为。

## 刷新和重建

Hermit 复用统一凭据存储和 OAuth 刷新器。Hermit helper 是该原生槽位的唯一 refresh token 写入者。内层 Claude Code 只接收 access token。内层 CLI 不接收 refresh token。

刷新改变 access token 后，helper 返回 `credential_changed: true`。旧 owner 随即拒绝新消息。vm2api 关闭旧 stdin 租约，并确认 owner 已停止。随后，vm2api 读取新凭据并启动新 owner。下次消息携带完整外部历史。

消息发现令牌过期时，Hermit 在发送上游请求前返回 `needs_refresh`。vm2api 调用同一 helper，再重建 owner 并重试。只有 refresh token 的凭据可先刷新，再启动 CLI。

OAuth 状态中的 `refresh_owner` 为 `hermit-native-slot`。API Key 不声明刷新者。刷新后的凭据已经保存，但 owner 重建失败时，调用方收到 `hermit_refresh_restart_failed`。

同一个原生槽位不并发执行消息和 helper。发生重叠时，helper 返回 `409 native_helper_busy`。该状态可重试。该锁只覆盖原生请求，不表示控制平面掌握外部工具的执行状态。

## 失败处理

helper 拒绝认证头和 Cookie 覆盖。helper 拒绝重定向、非 JSON 响应和超大响应。错误结果不复制上游错误正文。响应只保留重试和额度头。结果包含访问令牌、刷新令牌或内部令牌时，helper 返回脱敏错误。

`reset-redeem` 校验组织、grant 和 request 标识。传输失败可能导致执行结果未知。此时结果含 `outcome_unknown: true`。helper 不自动重试兑换。先查询 `reset-status`，再决定恢复操作。

## 验证入口

原生七项操作和异常路径由 Hermit 的 `experiment/native_helpers_e2e.py` 验证。实验使用实际 Go 进程、内部 Unix socket、合成凭据和模拟上游。实验保留检查结果、请求、二进制摘要和进程清理收据。

旧包兼容和能力拒绝验证使用以下命令：

```sh
node --test test/e2e/hermit-helper.e2e.test.mjs
```

实际控制容器验证使用 `test/e2e/hermit-factory.py`。API Key 场景增加 `--slot-api-key`。OAuth 场景增加 `--oauth`。每次使用新的输出目录。OAuth 场景验证显式刷新、过期刷新、owner 重建和消息续接。

完整验收工件见 [全部 helper 验收记录](hermit-helpers-results-20261108.md)。模型切片的旧结果见 [models 记录](hermit-models.md)。以下内容保留原拒绝切片的历史结果。

## 2026-11-08 拒绝契约验收（模型接入之前）

primaryserver 的独立网络命名空间实验通过 17 项检查。实际 Compose 控制容器回归通过 81 项检查。两轮源码固定检查通过。helper 实验无残留进程；控制容器回归的进程、网络命名空间、daemon 和临时目录清理均通过。

最终 5 个消息请求均使用更换后的槽位 Key。请求来源均为受管出口 `127.0.0.2`。原内核的 3 项凭据接口回归通过。版本包 HTTP 实验通过 41 项检查。

既有凭据套件的 reset 测试因本机缺少 `kin-computer` 失败。干净提交 `99c716e` 复现相同错误。该用例不计为本轮 PASS。

候选控制镜像如下。镜像中的 390 个源码文件和实际入口与构建记录一致。该镜像不是完整生产发布构建。

```text
sha256:5580ae9845944f986a8148964e30ca250619d72ba1075ee04952001fdaa54f8f
```

本地工件目录为 `.tmp/hermit-helper-20261108/`。`primaryserver-evidence.tar.gz` 保存隔离实验、实际容器回归、源码快照、调用记录和清理收据。`artifact-sha256.json` 记录工件摘要。`reproduction.json` 记录固定输入和执行参数。

最终 primaryserver 目录为 `/tmp/hermit-native-linux.GgJ0o4/helper-isolated-verified` 和 `/tmp/hermit-native-linux.GgJ0o4/helper-control-verified`。

第一轮 `helper-control-final` 的 81 项业务检查通过，但源码固定检查失败。当时更新了宽范围快照内的独立 helper 测试文件。该轮不作为最终验收。最终轮次在全部源码固定后重新运行，并通过检查。
