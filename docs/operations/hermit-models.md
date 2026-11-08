# Hermit 只读 models helper

## 接入方式

vm2api 先读取活动内核的健康响应。只有 `runtime_flavor` 为 `hermit`、`healthy` 为 `true`，且 `helper_operations` 数组包含 `models` 时，vm2api 才向该内核的 `/internal/v1/models` 发起请求。请求使用槽位内部令牌。

该路径不运行旧 worker 或 `hermit oauth`。旧包没有模型能力，因此继续返回 `native_operation_unsupported`。未知能力、错误的能力类型、错误的运行时身份和不健康的内核均不能启用模型查询。待生效的包不会改变当前内核行为。

Hermit 使用当前 owner 启动时的 Console API Key。它不读取共享凭据文件，不写凭据，也不刷新 OAuth。查询不会启动内层 CLI、占用会话或改变消息历史。换 Key 仍应先停槽，再写 Key，最后启动槽位。

## 范围和限制

模型上游仍只接受 HTTP 回环地址。实验流量通过现有槽位转发进程和受管出口。生产激活限制保持不变。该切片不表示真实上游或真实 TLS 已验收。

Hermit 在成功响应前收集并验证全部分页。它限制总耗时、页数、单页大小和条目数。它拒绝重定向、重复 ID、无效分页、重复 JSON 字段、超大响应和凭据反射。错误响应不会复制上游正文。

内部模型接口保留上游 401、403 和 429。模型目录同步接口继续使用既有错误封装，因此内部认证失败不会变成模型同步成功。

只有 `models` 已接入。OAuth 刷新、usage、profile、reset、公共计数和遥测没有开放。包清单中的 `helper_integration` 仍为 `false`，因为完整 helper 契约尚未实现。

## 固定工件

```text
Hermit package: 0.0.0-dev.models.7db468d
archive sha256: 1ece5ce6db7e908b1ca63acf4d9f62aeb29f778ce73e558c30ac14ed7ca91f62
manifest sha256: c5e3307e6ae594ffd519dbb2c44ff3b45cd51b5301f2812ebc8e5071e9426d84
Hermit binary sha256: 572c76ee91779d2df882cdc5da9cea6c063dd09ac25751c197fd197a2fb86ae3
control image: sha256:aafdfb8a74c225c8a397fd2f46da52b5e6c0c031af8b8123abec0843323cf2c4
```

候选包使用当前未提交源码构建，清单明确记录 `dirty: true`。包记录 107 个源码文件摘要。共享 Claude Code 仍固定为 2.1.318。候选控制镜像不是完整生产发布构建。

## 验证和复现

原生 helper 实验使用实际 Go 进程、内部 Unix socket 和回环模型上游。完整命令见 Hermit 仓库的 `docs/native-models.md`。

vm2api 的 HTTP 能力门禁实验：

```sh
node --test test/e2e/hermit-helper.e2e.test.mjs
```

使用 `test/e2e/hermit-helper.py` 可在 Linux 网络命名空间内复验。该实验使用完整控制平面、真实 API kernel、原生内核 HTTP 测试替身和进程调用记录。它不替代真实 Hermit 验收。

实际 Compose 回归继续使用 `hermit-factory.py --slot-api-key`。为 `--archive` 和 `--receipt` 指定新包；为 `--control-image` 指定本页镜像。它验证真实原生模型查询使用槽位 Key 和受管出口，并继续验证消息、Read、外部 MCP、换 Key、重启和出口故障恢复。

## 2026-11-08 验收结果

- 实际包二进制的原生 helper 实验：33 项 PASS。
- 完整 HTTP 能力门禁隔离实验：26 项 PASS。
- 实际 Compose 控制容器回归：83 项 PASS。
- 版本包 HTTP 回归：41 项 PASS。
- 原内核凭据接口回归：3 项 PASS。

实际容器记录 1 个模型查询和 5 个消息请求。模型查询使用更换后的槽位 Key，不含 Bearer 认证头。模型查询和消息请求均来自受管出口 `127.0.0.2`。模型查询没有提前启动 CLI。

两轮 vm2api 隔离实验的源码固定检查通过。实际容器回归的进程、网络命名空间、daemon 和临时目录清理检查通过。原生 helper 实验验证 IPv4/IPv6 外网拒绝及 owner 进程组停止。

本地证据目录为 `.tmp/hermit-models-20261108/`。`primaryserver-evidence.tar.gz` 包含 Go 源码快照、33 项原生实验、26 项能力门禁实验、83 项实际容器回归、请求记录、镜像摘要及清理收据。`reproduction.json` 记录固定参数。`artifact-sha256.json` 记录工件摘要。

Hermit 候选包保存在该仓库的 `experiment/evidence/native-models-build-20261108/package/`。候选包不包含官方 CLI 二进制。共享 CLI 仍由固定摘要缓存提供。

真实 OAuth、真实账号、真实上游和生产部署仍为 NOT RUN。本轮没有新增或修改单元测试。hook 和官方 CLI 没有改变。
