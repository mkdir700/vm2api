# Hermit 内核接入

## 当前范围

Hermit 是现有 Claude 槽位的内核选项。它与 `wrap`、`cc`、`crag` 并列。它复用槽位记录、调度、认证入口和内部 HTTP 传输。它不创建另一种槽位。

本版本完成模拟上游验收，并已在 primaryserver 运行真实 Docker 容器实验。生产激活默认拒绝。标准槽位创建、带认证 SOCKS5 和受管 Hysteria 2 已完成隔离验收。真实控制平面容器、Compose 入口和路径换算已完成模拟上游验收。KVM、远端节点、真实上游和 OAuth helper 尚未验收。不要将隔离实验通过视为生产可用。

## 安装与依赖

在内核管理页上传精简归档和对应的 `release.json`。归档使用 schema 2。归档只包含清单、Hermit 可执行文件和四个 hook。归档不包含 Claude Code。

后端通过 `POST /api/panel/kernel-packages` 接收归档。调用者应是管理员。请求应带下列标头：

- `X-Kernel-Sha256`：归档 SHA-256。
- `X-Kernel-Bytes`：归档字节数。
- `X-Kernel-Manifest-Sha256`：清单 SHA-256。

安装器限制归档大小为 64 MiB。它拒绝链接、特殊文件、路径逃逸、重复条目、重复 JSON 键、错误权限和错误摘要。相同版本与相同清单可以重复安装。相同版本与不同清单返回冲突。

安装器从清单指定的官方 HTTPS 地址下载固定 Claude Code。它核对大小与 SHA-256。多个版本共用同一摘要的 CLI。缓存损坏时安装器拒绝使用该缓存。它不覆盖损坏缓存。

```text
share/kernel-packages/
  cli/<cli-sha256>/claude
  versions/hermit/<target>/<version>/
    receipt.json
    payload/
      manifest.json
      bin/hermit
      hooks/
```

`GET /api/panel/kernel-packages` 返回版本、目标、摘要、CLI 版本和能力。接口不返回宿主绝对路径。安装器使用 Python 3 标准库。控制平面使用 Node 22.23.4 验证。

## 槽位选择

安装不会改变槽位策略或凭据。在内核管理页选择 Claude 槽位，再点击“暂存到所选槽位”。页面调用现有接口：

```json
{
  "dataplane": "hermit",
  "ids": ["slot-id"],
  "target": "linux-amd64",
  "version": "package-version",
  "restart": false
}
```

将请求发给 `POST /api/panel/dataplane`。接口校验安装内容，并将清单摘要绑定到 `pending_kernel_package`。暂存不改变运行内核。普通重启不会自动应用暂存版本。当前页面不提供生产激活按钮。接口拒绝全局选择和 Codex 槽位。

`restart: true` 只供隔离实验。实验需要 `KIN_KERNEL_TEST_ENDPOINTS=1`、模拟密钥和回环上游地址。实验还要求 `official_cc_passthrough=true` 和 `eager_tool_streaming=false`。这些设置不证明生产认证或上游兼容。

同一槽位的策略变更串行执行。同一版本重复启动复用已有进程。运行中的槽位不能直接切换到另一版本。多个槽位先全部启动成功，再写入策略。文件系统在策略写入期间发生故障时，不能保证跨文件回滚。

Hermit 每个内核只接收一个外部会话。调度容量固定为 1。原有 wrap 容量设置保持不变。

## 启动与停止

实验启动适配使用附着的 `docker exec -i`。旧槽位镜像没有 tmux。重建镜像并核对 tmux 摘要后再运行实验。Ubuntu 24.04 镜像定义已补齐固定 tmux 依赖。槽位容器应运行 `sleep infinity`，并启用 Docker `--init`。版本目录应以只读方式挂载到 `/opt/kin-kernel-packages`。启动前应核对发行版、glibc、架构和 tmux 摘要。

控制平面写入私有配置，并运行 `hermit --mode vm2api-slot`。配置指定共享 CLI、版本内的 hook、内部令牌和 Unix socket。每次实际启动使用新的会话目录。

控制平面通过 stdin 保持进程租约。停止槽位或关闭控制平面时，控制平面关闭 stdin 并等待退出。停止超时返回未确认状态。它不终止未知进程组。

## 验证与限制

HTTP 端到端实验使用完整控制平面和模拟下载服务。它验证安装、缓存、输入拒绝、权限、暂存和生产激活拒绝。

Linux 端到端实验在 `primaryserver` 的独立网络命名空间中运行。它禁止外网。实验使用真实 Hermit、固定内外 Claude Code、模拟上游和外部 MCP。默认模式使用独立测试程序模拟 Docker 执行边界。传入 `--docker-image sha256:<完整摘要>` 后，实验创建真实 Docker 容器。容器使用 `--network none`、普通用户、只读根文件系统、只读版本目录和 `--init`。控制平面只进入该容器的网络命名空间。该模式不使用 Docker 测试适配器。

复现入口：

```sh
node --test test/e2e/hermit-packages.e2e.test.mjs
python3 test/e2e/hermit-runtime.py \
  --out /tmp/fresh-run \
  --node /path/to/node \
  --archive /path/to/hermit.tar.gz \
  --receipt /path/to/release.json \
  --cli-source /path/to/pinned/claude \
  --api-kernel /path/to/api-kernel
```

Linux 入口需要网络命名空间权限。每次使用新的输出目录。保留 `summary.json`、`receipt.json`、`isolation.json`、源码快照、请求记录和工具结果。前端类型检查不替代页面交互验收。

`hermit-runtime.py --docker-image` 由测试驱动创建容器。新增 `hermit-factory.py` 则在独立 Docker daemon 中通过实际 HTTP 激活接口调用标准槽位创建路径。标准创建和带认证 SOCKS5 的联合实验已通过。受管 Hysteria 2 的隔离联合实验也已通过。已有槽位切换仍需单独验收。参见 [标准创建与出口](hermit-factory.md)。

后续生产接入还需验证：OAuth 与 helper、真实上游、模型与计量接口、跨槽位恢复、版本切换和故障回滚。当前版本不承诺服务端无法识别桥接行为。

真实 Docker 模式还支持 `--docker-failure missing-tmux`、`--docker-failure no-init` 和 `--docker-failure container-exit`。前两项应拒绝激活，且保留原槽位策略。缺少 tmux 的实验应使用未包含 tmux 的固定镜像。正常模式验证控制平面重启，并使用完整外部历史恢复后续输入。容器退出实验不承诺执行中的工具可以恢复。

受管出口联合验收见 [Hysteria 2 说明](hermit-managed-egress.md)。该实验验证了应用失败拒绑、错误认证回滚、就绪恢复和消息续接。

真实控制平面容器验收见 [Compose 与路径说明](hermit-control.md)。该实验不设置宿主路径覆盖，并验证了实际入口、helper 摘要和重启后的工具续接。

槽位 API Key 接入与实验边界见 [认证说明](hermit-authentication.md)。该切片保留生产激活限制。
