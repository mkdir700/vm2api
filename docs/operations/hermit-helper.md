# Hermit 原生 helper 拒绝契约

## 当前行为

Hermit 原生槽位尚未接入 helper。vm2api 根据活动槽位的 `dataplane` 选择 helper 行为。活动值为 `hermit` 时，统一 helper 入口直接返回不支持。

该入口覆盖 `refresh`、`usage`、`profile`、`models`、`count-tokens`、`reset-status` 和 `reset-redeem`。Hermit 不应回退到 `/usr/local/bin/kin-worker oauth`，也不应读取旧 `/run/kin/worker.json` 来执行这些操作。

统一返回值如下：

```json
{
  "ok": false,
  "status": 501,
  "body": { "error": { "code": "native_operation_unsupported" } },
  "via": "hermit",
  "transportError": false
}
```

这是能力拒绝。它不是网络传输失败。调用方不应据此声明 OAuth 令牌失效。

原内核继续调用原 helper。仅存在 `pending_kernel_package` 不会启用 Hermit 的拒绝分支。

## HTTP 接口

| 接口 | 当前 Hermit 行为 |
| --- | --- |
| POST /api/panel/model-policy/sync-worker | 只有 Hermit 可选时返回 501 和不支持代码 |
| POST /admin/vm/oauth/refresh | 实际需要调用 helper 的刷新返回 501 |
| POST /api/panel/vms/:id/oauth/refresh | OAuth helper 刷新返回 501 |
| GET /admin/vm/oauth | 不声明 OAuth 刷新者，`refresh_owner` 为 null |
| GET /api/panel/oauth | 不声明 OAuth 刷新者，`refresh_owner` 为 null |

不支持的刷新使用 `refresh_class: unsupported`。控制平面不把这种结果写为账号刷新错误。

该切片不开放新的公共接口。公共计数接口仍返回 404。面板仍拒绝刷新 Console API Key，并返回 `credential_mode_unsupported`。已有缓存读取和多账号模型目录的选择规则保持原行为。

包清单中的 `helper_integration` 保持 `false`。`hermit oauth` 的存在不表示原生槽位已经接入该命令。

## 验证

本地入口使用完整 HTTP 控制平面、实际 API kernel 和记录调用的进程替身。测试替身代替 Docker 命令边界。它不运行生产 Docker，也不请求真实上游。

```sh
node --test test/e2e/hermit-helper.e2e.test.mjs
```

未指定 `KIN_API_KERNEL_BIN` 时，测试从当前 `api-kernel` 源码构建本机二进制。指定该变量时，测试使用固定的真实二进制。

Linux 隔离入口如下：

```sh
python3 test/e2e/hermit-helper.py \
  --out /tmp/fresh-helper-run \
  --node /path/to/node \
  --api-kernel /path/to/kin-api-kernel
```

该入口需要网络命名空间权限。它验证 IPv4、IPv6 外网拒绝、源码固定和进程清理。保留 `receipt.json`、`checks.json`、`responses.json`、`helper-calls.json`、源码快照和隔离记录。

真实控制容器回归还检查活动 Hermit 槽位的模型同步拒绝。该回归继续验证消息、Read、外部 MCP、换 Key、控制平面重启和出口故障恢复。

## 2026-11-08 验收

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

## 后续范围

本切片没有接入 OAuth 刷新。后续应先确定唯一刷新写入者，再接入原生 helper 配置和凭据存储。不要把原生 CLI 和旧 worker 同时配置为 refresh token 写入者。

真实 OAuth、真实消息上游和生产部署仍为 NOT RUN。Go 代码和 hook 没有改变。
