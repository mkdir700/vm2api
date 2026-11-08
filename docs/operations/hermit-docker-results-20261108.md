# Hermit 真实 Docker 验收：2026-11-08

## 结论

真实 Docker 实验通过。生产激活仍默认拒绝。

实验在 primaryserver 创建独立容器。内外 Claude Code 均使用固定的官方 2.1.318。容器实际运行 Hermit 和内部 Claude Code。外部 Claude Code 在隔离测试目录运行。上游仍为模拟服务。实验没有调用真实订阅。

## 本轮修复

旧 Ubuntu 槽位镜像没有 tmux。Ubuntu 24.04 镜像定义已添加 `tmux=3.4-1build1`。构建时核对 tmux 的固定摘要。实验使用原固定槽位镜像的派生镜像。原槽位镜像和现有容器保持不变。

真实容器的第一轮工具循环通过，但退出清理失败。容器以 `sleep` 为 PID 1，没有回收退出的子进程。Hermit 无法确认进程组已清理。

Hermit 容器创建参数已添加 Docker `--init`。启动前检查强制要求 `HostConfig.Init=true`。没有 init 的容器拒绝激活。启用 init 后，退出清理和控制平面重启均通过。

依赖检查失败返回 `hermit_guest_preflight_failed`。接口不再返回 Python traceback。缺少 init 返回 `hermit_init_required`。

## 最终结果

| 场景 | 结果 | 检查数 |
| --- | --- | --- |
| 真实容器、工具循环、控制平面重启 | PASS | 27 |
| 容器退出后拒绝再次激活，保留内核选择 | PASS | 28 |
| 缺少 tmux，拒绝激活并保留原槽位 | PASS | 7 |
| 缺少 init，拒绝激活并保留原槽位 | PASS | 7 |
| 原 Docker 模拟边界回归 | PASS | 19 |
| HTTP 安装与暂存回归 | PASS | 41 |
| Docker 资源、内核路由、远端 GPT、槽位运行与容器替换回归 | PASS | 106 |

每个真实 Docker 场景均通过源码固定、网络隔离、进程检查、容器删除和临时目录删除检查。最终收据没有遗留命名空间进程。

正常场景覆盖外部 Read、外部 MCP、工具结果续接和后续输入。控制平面重启时，旧会话进程先退出。再次激活后，Hermit 使用新的会话目录。外部 Claude Code 发送完整历史，后续输入成功。

容器退出场景在空闲时执行 `docker stop`。它验证内核不可用时接口拒绝激活，并保留 Hermit 选择。它不证明执行中的工具可以恢复，也不覆盖宿主断电或 `SIGKILL`。

## 环境与工件

```text
host: primaryserver / racknerd-e693f2c
Docker: 29.9.2
base image ID:
sha256:c192a12cbe229957c467ef713a4d618ea7892325f55114fc5b0e37721452585a
candidate image ID:
sha256:05516632dc38371fe17c1bd5592b87bafcb4050dba747557c5d4c8568c183c91
tmux sha256:
88e9b027bbe0dd11b6e7ea39fd9a6489f97addd751e25ed6a54f1607f42ad4df
Hermit archive sha256:
beb9ee92b8193cf9d6ba087602e7da2ef4f9fe30d1429b69ce3a397858ae623d
Claude Code sha256:
708c77b204db30086ff6f1ed34577bda03e1be74ced80557cbf7b54249ebf0bd
```

容器使用普通用户 `10001:987`。版本目录只读。根文件系统只读。容器删除全部 capability，并启用 `no-new-privileges`。`/tmp` 使用 `noexec,nosuid,size=32m`。进程上限为 256。

容器使用 `--network none`。控制平面和模拟上游只加入该容器的网络命名空间。命名空间只有回环接口。IPv4 和 IPv6 外部地址连接均被拒绝。

本地证据目录为 `.tmp/hermit-docker-20261108/`。其中包含各场景的 `summary.json`、`receipt.json`、`checks.json`、`isolation.json` 和退出后的进程清单。`primaryserver-evidence.tar.gz` 保留源码快照、请求、工具结果、失败实验和镜像构建日志。`artifact-sha256.json` 记录本地工件摘要。

测试驱动最初将 init 的直接 `sleep infinity` 子进程误报为泄漏。修正后的驱动只排除容器 PID 1 和该直接子进程。其他残留进程仍导致失败。删除容器后，驱动还应确认整个网络命名空间没有进程。

## 复现

使用 `test/fixtures/hermit-docker.Dockerfile` 补齐固定 tmux。先检查基础镜像 ID。构建后记录候选镜像 ID。测试不自动拉取镜像。

```sh
python3 test/e2e/hermit-runtime.py \
  --out /tmp/fresh-docker-run \
  --node /path/to/node-22.23.4 \
  --archive /path/to/hermit.tar.gz \
  --receipt /path/to/release.json \
  --cli-source /path/to/pinned/claude \
  --api-kernel /path/to/api-kernel \
  --docker-image sha256:FULL_IMAGE_ID
```

每次使用新的输出目录。使用 `--docker-failure no-init`、`missing-tmux` 或 `container-exit` 运行故障场景。缺少 tmux 的场景应指定旧镜像。驱动只删除带有本次随机标签的测试容器。

## 未验收边界

本轮容器由测试驱动创建。实验复用实际 vm2api 安装、选择、启动、传输和停止路径。它没有通过标准槽位创建入口配置受管出口，也没有自动将已有 wrap/crag 容器切换为 Hermit。

以下项目仍为 NOT RUN：标准槽位创建与受管出口、真实 OAuth 与 helper、真实上游、KVM、远端节点、版本切换与回滚、执行中工具的故障恢复。

下一切片先验证标准槽位创建和受管出口。随后再接入真实认证和上游。真实订阅调用需要单独授权。
