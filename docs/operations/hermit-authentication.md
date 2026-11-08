# Hermit 槽位认证

## 当前范围

vm2api 为 Hermit 读取槽位自己的 Console API Key。凭据源是 `vms/<id>/cli-home/.claude/credentials.json`。控制平面复用统一凭据读取器。该路径保留 API Key 认证。完整 helper 包现也支持 OAuth；见下文。hook 和固定官方 CLI 没有改变。

该切片只验收合成 Key 和本地模拟上游。生产激活限制保持不变。受控实验支持 HTTP 回环或固定 HTTPS 上游。实验仍须显式设置 `KIN_KERNEL_TEST_ENDPOINTS=1`。参见 [HTTPS 说明](hermit-https.md)。官方 CLI 支持 `ANTHROPIC_API_KEY`。参见 [官方认证说明](https://code.claude.com/docs/en/authentication)。

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

## OAuth 认证

完整 helper 包读取同一 canonical 凭据文件。vm2api 将 access token 写入私有配置的 `CLAUDE_CODE_OAUTH_TOKEN`。vm2api 不把 refresh token 写入该配置。Hermit helper 通过挂载的 canonical 文件保存轮换结果。

Hermit helper 是唯一刷新写入者。刷新改变 access token 后，vm2api 确认旧 owner 退出，再启动新 owner。固定版本 Claude Code 2.1.318 已在合成 OAuth 端到端场景验证。旧的 models-only 包不启用该认证路径。参见 [helper 契约](hermit-helper.md)。

`helper_integration` 现为 `true`。该标志表示原生 helper 协议已接入，不表示生产上游已验收。

## 未验收范围

真实 OAuth、真实上游和真实账号均为 NOT RUN。生产激活限制保持不变。

本轮证据与检查结果见 [认证验收记录](hermit-authentication-results-20261108.md)。

原生 helper 的能力选择、刷新和失败处理见 [helper 契约](hermit-helper.md)。
