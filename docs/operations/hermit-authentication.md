# Hermit 槽位认证

## 当前范围

vm2api 为 Hermit 读取槽位自己的 Console API Key。凭据源是 `vms/<id>/cli-home/.claude/credentials.json`。控制平面复用统一凭据读取器。Hermit 的 Go 代码和 hook 没有改变。

该切片只验收合成 Key 和本地模拟上游。生产激活限制保持不变。消息上游仍应为 `http://127.0.0.1`，且应显式设置 `KIN_KERNEL_TEST_ENDPOINTS=1`。官方 CLI 支持 `ANTHROPIC_API_KEY`。参见 [官方认证说明](https://code.claude.com/docs/en/authentication)。

## 凭据选择

1. 槽位声明 `apikey`，或统一凭据文件包含 API Key 时，选择槽位 Key。
2. 校验凭据文件和认证格式。校验失败时返回 `hermit_authentication_invalid`。
3. 将 Key 写入私有 `native-slot.json` 的 `ANTHROPIC_API_KEY`。配置文件权限为 `0600`。
4. 内层 CLI 读取配置，并向模拟上游发送 `x-api-key`。

校验要求如下：

- 凭据应为不超过 64 KiB 的普通文件。文件不应为符号链接。
- 凭据文件应使用统一存储的 `0444` 封存模式，或使用 `0400`、`0600`。该切片不改变统一凭据目录的既有访问策略。
- Key 应具有 Console API Key 前缀。Key 不应包含空白或控制字符。
- 认证方式应为 `x_api_key`。当前不接受 Bearer API Key。
- 凭据不应同时包含 OAuth 或 refresh token。
- 凭据的 `baseUrl` 应为 `https://api.anthropic.com`，或省略该字段。实验上游地址单独由实验变量指定。当前不接入自定义服务商端点。

槽位凭据无效时，控制平面不回退到全局实验 Key。原隔离实验可以继续显式使用 `KIN_HERMIT_API_KEY`。此兼容分支只用于没有选择槽位 API Key 的模拟场景。该分支不转发 OAuth 令牌。

## 凭据改变

控制平面在启动和显式激活内核时重新校验凭据。活动内核的凭据摘要改变时，返回 `hermit_authentication_changed`。控制平面不静默替换活动 CLI 的环境。

更换 Key 时，先停止槽位，再写入新 Key，最后启动槽位。已启动的 CLI 固定使用启动时的 Key。消息请求不会热加载凭据。修改文件不会自动取消活动请求。该切片不提供热轮换。

控制平面重启会释放原 stdin 租约。下次激活会读取槽位凭据，并建立新会话目录。完整外部历史恢复沿用现有路径。

## 端到端验证

先按 [控制容器实验](hermit-control.md) 准备固定输入和候选镜像。使用当前源码重新构建候选镜像。给原 `hermit-factory.py` 命令增加 `--slot-api-key`。每次使用新的输出目录。

也可给 `hermit-runtime.py` 增加 `--slot-api-key`。该入口验证真实内外 CLI，但默认模拟 Docker 执行边界。两种模式的结论应分开记录。

实验使用统一凭据写入器生成合成槽位 Key。槽位 Key 与全局实验 Key 不同。实验不验证面板凭据导入接口。保留以下工件：

- `checks.json` 和最终收据。
- `auth-rejected-*.json` 和 `auth-changed.json`。
- `native-requests.json`。认证头只包含合成 Key。
- 源码摘要、隔离记录、工具结果和清理记录。

## 未验收范围

OAuth 刷新、生产 helper 认证、真实上游和真实账号均为 NOT RUN。`helper_integration` 保持 `false`。当前 `hermit oauth` 仍使用旧 worker 配置，不能直接消费 `native-slot.json`。后续应先确定唯一的刷新写入者，再接入 OAuth。

本轮证据与检查结果见 [认证验收记录](hermit-authentication-results-20261108.md)。

原生 helper 的拒绝行为与后续接入边界见 [helper 契约](hermit-helper.md)。
