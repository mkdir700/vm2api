# Hermit 原生 HTTPS 验收

## 当前结果

Hermit 原生传输现支持固定 HTTPS 地址。消息和账号接口使用 `https://api.anthropic.com`。刷新接口使用 `https://platform.claude.com/v1/oauth/token`。原有 HTTP 回环实验仍可运行。

固定官方 CLI 2.1.318 已在隔离 TLS 实验中完成 OAuth 消息和 API Key 消息。两条消息均返回 200。七个 helper 也已通过 TLS 实验。实验使用合成凭据、合成证书和本地模拟上游。

这不是生产部署。vm2api 的生产激活门禁保持不变。vm2api 现已接入固定 HTTPS 配置生成。真实账号、真实 OAuth 和真实上游仍为 NOT RUN。受管出口的 TLS 联合结果见后续验收记录。

## 实现范围

Hermit 只接受精确的固定 HTTPS API 地址和刷新地址。它拒绝其他域名、端口、路径、查询、片段和 URL 用户信息。HTTP 回环配置保留原有路径规则。

Go helper 使用标准 TLS。证书链、主机名和有效期校验保持启用。helper 不读取 HTTP 代理环境变量，并拒绝重定向。消息仍由原版 CLI 发出。

内层 CLI 和 Go helper 可通过标准 `NODE_EXTRA_CA_CERTS` 使用额外 CA。Hermit 校验 CA 文件。它拒绝符号链接、无效 PEM 和超过 1 MiB 的文件。该能力没有提供跳过 TLS 验证的开关。

现有 hook 只扩展启动地址校验。它没有增加私有接口。官方 CLI 二进制没有改变。

## 原生层固定工件与结果

本节记录上一阶段的原生验收包。当前 vm2api 联合验收包及其能力声明见 [受管 HTTPS 验收](hermit-managed-https-results-20261108.md)。

```text
Hermit source base: 403d201 (dirty: true)
package: 0.0.0-dev.https.403d201
archive sha256: 8d38c6df825114d2160cf65936512e79215b94405ab978979d1bab99dce14c43
manifest sha256: 15ae06ad4d6be3fd3aaaa02843241d074fd4209fd9e0df5735ffe0275dc24f42
binary sha256: 42dfede2690cce156ea08e7549bbf435c01d232de4972a4c7daf32db9db36467
```

- 最终包的 TLS 端到端检查：83 项 PASS。
- 同一包的 HTTP helper 回归：53 项 PASS。
- 同一包的 models-only 回归：33 项 PASS。
- 最终包的 109 项源码摘要与本地源码一致。

TLS 实验记录请求目标、SNI 和认证。错误主机名、未知 CA 和过期证书均在发送 HTTP 请求前被拒绝。实验还拒绝了固定地址绕过和非法 CA 配置。

父命名空间收据确认实验进程退出。网络命名空间和挂载命名空间均已清理。没有残留实验进程。宿主机的 `/etc/hosts` 和系统 CA 文件摘要没有改变。实验不会改写宿主信任库。

最终工件位于 Hermit 的 `experiment/evidence/native-https-build-20261108/`。目录包含精简包、源码快照、请求、证书、检查记录和父命名空间收据。失败的实验配置记录也已保留。完整复现入口见 Hermit 的 `docs/native-https.md`。

本切片没有新增或修改单元测试。新 TLS 变更尚未提交。此前全部 helper 的实现已分别提交为 Hermit `403d201` 和 vm2api `5e5aafa9`。没有推送或部署。

## vm2api 配置生成

消息地址固定为 `https://api.anthropic.com`。刷新地址固定为 `https://platform.claude.com/v1/oauth/token`。vm2api 不再用 API 地址拼接 HTTPS 刷新地址。原 HTTP 回环实验保留原路径规则。

HTTPS 激活要求包声明 `https_upstream: true`。旧包仍可运行原有 HTTP 实验。安装器拒绝类型错误的能力字段。Hermit 的新精简包只增加能力声明，其二进制和四个 hook 与原生 TLS 验收包完全相同。

配置生成沿用标准 `NODE_EXTRA_CA_CERTS`。控制平面先校验 CA 文件，再将内容复制到私有 run 目录。内层 CLI 和 Go helper 使用 `/run/kin/native-ca.pem`。控制平面内的 CA 绝对路径不会进入槽位配置。

CA 文件应是绝对路径的普通文件。它不应是符号链接。大小不应超过 1 MiB。CA 文件应包含可解析的 PEM 证书。失败返回 `hermit_ca_invalid`。HTTP 实验不继承控制平面的额外 CA。

正常启动、OAuth 重建和控制平面重启均通过同一配置生成路径读取 CA。已启动的 owner 使用自己的 CA 副本。更换 CA 后，应停止 owner 再启动。

生产激活仍要求后续验收。当前仍应显式设置 `KIN_KERNEL_TEST_ENDPOINTS=1` 和实验上游地址。不要把这个开关用于生产部署。

联合验收入口为 `hermit-factory.py --tls --oauth` 或 `--tls --slot-api-key`。两种模式均要求实际控制镜像和受管出口镜像。完整结果见 [受管 HTTPS 验收](hermit-managed-https-results-20261108.md)。
