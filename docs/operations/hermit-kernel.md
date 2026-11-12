# Hermit 内核接入

## 当前范围

Hermit 是现有 Claude 槽位的内核选项。它与 默认内核 并列。它复用槽位记录、调度、认证入口和内部 HTTP 传输。它不创建另一种槽位。

本版本完成模拟上游验收，并已在 primaryserver 运行真实 Docker 容器实验。生产激活默认拒绝。标准槽位创建、带认证 SOCKS5 和受管 Hysteria 2 已完成隔离验收。真实控制平面容器、Compose 入口和路径换算已完成模拟上游验收。KVM、远端节点、真实上游尚未验收。OAuth helper 已完成合成凭据的隔离验收。不要将隔离实验通过视为生产可用。

## 安装与依赖

在内核管理页上传精简归档和对应的 `release.json`。归档使用 schema 2。归档只包含清单、Hermit 可执行文件和四个 hook。归档不包含 Claude Code。

后端通过 `POST /api/panel/kernel-packages` 接收归档。调用者应是管理员。请求应带下列标头：

- `X-Kernel-Sha256`：归档 SHA-256。
- `X-Kernel-Bytes`：归档字节数。
- `X-Kernel-Manifest-Sha256`：清单 SHA-256。

安装器限制归档大小为 64 MiB。它拒绝链接、特殊文件、路径逃逸、重复条目、重复 JSON 键、错误权限和错误摘要。相同版本与相同清单可以重复安装。相同版本与不同清单返回冲突。

安装器从清单指定的官方 HTTPS 地址下载固定 Claude Code。它核对大小与 SHA-256。当前包与已部署 VM 共用按摘要校验的 CLI。缓存损坏时安装器拒绝使用该缓存。它不覆盖损坏缓存。

```text
share/kernel-packages/
  current.json
  cli/<cli-sha256>/claude
  versions/hermit/<target>/<version>/
    receipt.json
    payload/
      manifest.json
      bin/hermit
      hooks/
```

`GET /api/panel/kernel-packages` 返回 `{ "item": null }` 或唯一当前包的版本、目标、摘要、CLI 版本和能力。接口不再返回版本列表。接口不返回宿主绝对路径。安装器使用 Python 3 标准库。控制平面使用 Node 22.23.4 验证。

## 槽位选择

上传只替换唯一安装包，不改变现有 VM 的内核、凭据或运行状态。
旧 VM 在统一安装流程完成后才使用新包。
页面不提供历史列表或 Hermit 版本 select。
版本号只用于来源核对。

1. 打开“内核”页面。
2. 上传内核包和对应的 `release.json`。
3. 在“VM 安装”区域选择目标 VM。
4. 在“安装内核”select 中选择 Hermit。
5. 单击“安装”，核对当前包，再确认“重装并停用”。
6. 等待成功，然后按正常 VM 流程启动并启用调度。

统一接口为 `POST /api/panel/kernels/install`。

```json
{
  "targets": [
    { "id": "slot-id", "kernel": "hermit", "manifest_sha256": "current-manifest-sha256" }
  ]
}
```

服务器使用当前包。确认摘要已变化时，服务器拒绝请求。
接口不接受版本选择字段。
警告：安装成功后系统清理旧容器，并保持 VM 停用。
需要恢复原内核时，重新安装该内核。

`current.json` 是唯一安装包指针。
`versions/` 只保存当前包及已有 VM、暂存记录、未结束回滚实际引用的部署文件。
这些引用不构成历史包选择目录。
上传或重装完成时，系统清理无引用目录。
读取槽位记录失败时，系统保留文件并报告待清理状态。
旧存储没有当前指针时，系统不猜测版本。
升级时重新上传已验收的正式包，或使用正式升级器中的包安装步骤建立指针。

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

后续生产接入还需验证：真实 OAuth 与上游、真实计量结果、跨槽位恢复、版本切换和故障回滚。当前版本不承诺服务端无法识别桥接行为。

真实 Docker 模式还支持 `--docker-failure missing-tmux`、`--docker-failure no-init` 和 `--docker-failure container-exit`。前两项应拒绝激活，且保留原槽位策略。缺少 tmux 的实验应使用未包含 tmux 的固定镜像。正常模式验证控制平面重启，并使用完整外部历史恢复后续输入。容器退出实验不承诺执行中的工具可以恢复。

受管出口联合验收见 [Hysteria 2 说明](hermit-managed-egress.md)。该实验验证了应用失败拒绑、错误认证回滚、就绪恢复和消息续接。

真实控制平面容器验收见 [Compose 与路径说明](hermit-control.md)。该实验不设置宿主路径覆盖，并验证了实际入口、helper 摘要和重启后的工具续接。

槽位 API Key 接入与实验边界见 [认证说明](hermit-authentication.md)。该切片保留生产激活限制。

全部七项原生 helper 的协议、凭据所有权和失败处理见 [helper 契约](hermit-helper.md)。

原生 HTTPS 的隔离结果与生产接入边界见 [HTTPS 验收](hermit-https.md)。


## 现有槽位切换与回滚

后台的现有槽位应用流程见[现有槽位的 Hermit 切换与回滚](hermit-kernel-switch.md)。
该流程保留旧容器，提供自动回滚、显式回滚和确认入口。
模拟验收包仍不能激活生产槽位。
