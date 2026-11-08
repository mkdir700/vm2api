# Hermit 受管 HTTPS 联合验收

## 结论

vm2api 现已生成固定 HTTPS 配置。实际 Compose 控制容器、标准 Hermit 槽位、受管 Hysteria 2 出口和 TLS 模拟上游已完成联合验收。

API Key 场景通过 104 项检查。OAuth 场景通过 80 项检查。两种认证均验证了外部工具执行期间重启控制平面，再交付原工具结果。外部工具没有重复执行。

实验使用合成凭据和合成证书。真实账号、真实 OAuth 服务、真实消息上游和生产部署仍为 NOT RUN。没有推送或上线。生产门禁和 `production: false` 保持不变。

## 固定工件

```text
Hermit source base: 403d201 (dirty: true)
vm2api source base: 5e5aafa9 (uncommitted changes)
package: 0.0.0-dev.https-contract.403d201
archive sha256: fd5cb358c917efb43741d1533d556308f9477928e5184457539803431534d017
manifest sha256: df50828a163b0bf88421910e4ba9513f8cf1489bd58ea72f2f36212ed770b054
Hermit binary sha256: 42dfede2690cce156ea08e7549bbf435c01d232de4972a4c7daf32db9db36467
control image: sha256:26cd4d4d8f986190cc943260f19f77e6596f4e4941a55a24e407f995b110e79c
Claude Code version: 2.1.318
Claude Code sha256: 708c77b204db30086ff6f1ed34577bda03e1be74ced80557cbf7b54249ebf0bd
```

Hermit 包记录 109 项源码摘要。其二进制和四个 hook 与上一原生 TLS 验收包完全相同。新包增加了 `https_upstream: true` 能力声明。控制镜像的 391 项源码和入口核对通过。该镜像叠加当前后端源码，不是完整生产发布构建。

## 链路和凭据

消息和模型查询使用 `https://api.anthropic.com`。OAuth 刷新使用独立的 `https://platform.claude.com/v1/oauth/token`。控制平面把校验后的额外 CA 复制到槽位私有目录。内层 CLI 和 Go helper 均读取 `/run/kin/native-ca.pem`。

模拟服务监听隔离网络内的 `198.18.0.1:443`。实验只修改本次隔离 Docker daemon 的槽位 hosts 源文件。修改前核对槽位角色和文件归属路径。槽位的只读根文件系统保持不变。宿主 DNS 和系统信任库没有改变。

TLS 模拟服务记录 SNI、Host 和来源地址。所有消息及模型查询均使用 API 域名，且来自受管出口 `127.0.0.2`。两次 OAuth 刷新均使用刷新域名，且来自同一受管出口。

实验的 Hysteria 2 服务使用原有自签名测试配置。API 上游独立执行证书校验。模型 helper 经完整受管链路拒绝错误主机名证书。错误证书场景没有产生上游 HTTP 模型请求。

缺失 CA、符号链接、超大 CA 和无效 PEM 均在激活检查中被拒绝。错误使用 `hermit_ca_invalid`。这些失败没有创建原生 owner。旧 HTTP 实验不继承控制平面的额外 CA。

## 工具执行期间重启

实验按以下顺序验证工具续接：

1. 固定内层 CLI 返回外部 MCP 工具调用。
2. 固定外层 CLI 收到工具调用，并启动 MCP 工具。
3. MCP 工具记录调用，再等待受控释放文件。
4. 实验采集外层收到的工具调用 ID。
5. 控制平面停止，并确认旧 owner 的进程组退出。
6. 实际 Compose 入口重启控制平面。
7. vm2api 创建新 owner。
8. 实验释放原 MCP 结果。
9. 外层把完整历史和工具结果发给 vm2api。
10. 新 owner 发起 HTTPS 请求，并完成本轮响应。

恢复请求中的 `tool_result.tool_use_id` 与外层收到的 ID 相同。工具结果保留原标记内容。外部 MCP 的执行记录只有一次。后续用户消息也已完成。

该场景验证外部工具仍存活时的控制平面重启。它不表示宿主掉电、外部工具进程丢失或所有执行中故障都已验收。

OAuth 场景还验证显式刷新和过期刷新。刷新后重建 owner，后续请求使用新 access token。两次 refresh grant 使用预期的轮换 refresh token。refresh token 没有进入 CLI 配置。

## 故障与回归

| 场景 | 结果 | 边界 |
| --- | --- | --- |
| API Key 受管 TLS | 104 项 PASS | 实际控制容器、槽位、出口、内外 CLI |
| OAuth 受管 TLS | 80 项 PASS | 同上，含刷新和执行中工具续接 |
| HTTP 客户端回归 | 43 项 PASS | 固定内外 CLI，模拟 Docker 执行边界 |
| 旧包 helper 兼容 | 26 项 PASS | 完整 HTTP，实际 API kernel，进程替身 |
| 版本包 HTTP | 45 项 PASS | 安装、能力类型、共享 CLI 和激活门禁 |

停止透明出口 helper 后，槽位连接模拟上游失败。实验没有观察到直接连接回退。标准探测修复 helper 后，消息恢复。

两轮最终实际容器收据均满足以下条件：

- `source_unchanged: true`。
- `namespace_gone: true`。
- `daemon_removed: true`。
- `fixture_removed: true`。
- `unexpected_processes` 为空。

宿主生产 vm2api 仍使用原镜像。最终审计没有发现本轮测试 daemon 残留。本切片没有新增或修改单元测试。

## 复现和证据

使用 `test/e2e/hermit-factory.py --tls --oauth` 或 `--tls --slot-api-key`。两种模式都需要完整的固定输入参数。完整命令保存在本地 `oauth-verified-args.json` 和 `apikey-verified-args.json`。

本地工件目录为 `.tmp/hermit-managed-https-20261108/`。目录包含以下工件：

- `primaryserver-evidence.tar.gz`：最终容器实验、HTTP 回归和失败轮次。
- `source-verified.tar.gz`：最终 vm2api 实验源码快照。
- `control-context-v2.tar.gz` 和源码摘要：实际控制镜像的构建输入。
- `hermit-source-snapshot.tar.gz`、清单和 release 收据：Hermit 包身份。
- `verified-summary.json`：下载后重新核对的检查结果。
- `final-audit.json`：生产镜像、宿主文件和测试 daemon 审计。
- `artifact-sha256.json`：工件摘要。

最终远端目录为 `/tmp/hermit-native-linux.GgJ0o4/managed-https-oauth-verified` 和 `/tmp/hermit-native-linux.GgJ0o4/managed-https-apikey-verified`。每轮保留请求、TLS 连接、外部效果、ID 关联、源码及清理收据。

失败轮次也已保留。原控制镜像拒绝 HTTPS 激活，证明旧行为。第一候选暴露了只读 hosts 和 CA 错误包装问题。附加工具实验最初比较了模型侧 ID 与外层 ID。最终断言改为采集外层实际 ID，产品映射代码没有改变。只有最终 verified 轮次作为本页验收依据。

配置说明见 [HTTPS 配置](hermit-https.md)。真实上游验收和生产启用仍需单独完成。
