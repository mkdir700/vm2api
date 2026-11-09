# 现有槽位内核切换验收：2026-11-09

## 结果

现有槽位的 Hermit 切换和回滚流程已完成。
后台内核包页面和槽位详情页面均已接入。
管理员可执行“切换并应用”“回滚上次切换”和“确认保留当前内核”。

正式模式验收已关闭全部 Hermit 实验标记。
Linux 新构建包声明生产部署能力。
Darwin 包保持模拟声明。
旧模拟包不能直接激活生产槽位。

本次没有部署线上服务，没有调用真实账号或真实模型上游。
生产部署能力不代表真实账号验收。

## 实现范围

vm2api 使用同一个槽位事务完成切换。
事务持有槽位生命周期锁，并等待 watchdog 中已开始的恢复任务结束。
事务暂停单槽调度，等待在途请求结束，然后检查工具结果。
事务停止并保留旧容器。
目标内核通过健康和身份检查后，事务原子写入目标选择并恢复原有调度状态。

目标启动失败时，事务自动恢复旧容器及原内核选择。
显式回滚会验证旧容器的完整 ID。
回滚不会覆盖当前凭据文件。
旧容器缺失或身份不符时，事务保留当前容器并维持调度暂停。
控制平面重启后，事务记录仍可用于回滚。

Hermit 通过健康接口报告 `switch_ready` 和 `pending_tool_results`。
协调器要求当前交换完成，并确认每个工具结果已经提交。
该接口不暂停原生工具循环。
存在外部工具等待时，后台会拒绝切换。

回滚现在会先正常停止目标容器。
系统仅清理无监听且 inode 未变化的残留 Unix socket。
系统拒绝清理活动 socket、符号链接和普通文件。
Hermit 的启动检查仍要求 socket 路径为空。

Linux 发布声明由 `deploy/native-kernel-inputs.json` 决定。
包构建器按目标生成 `capabilities.production`。
旧模拟包仍可校验，但不能在正式模式下激活。
生产包和本次模拟包的 `bin/hermit` 摘要相同。
生产模式验证的是部署契约，不依赖测试 API Key 或上游地址覆盖。

## 验收结果

| 验收边界 | 结果 |
| --- | --- |
| 正式模式 OAuth，真实 Docker、真实 CLI、模拟 TLS 上游 | PASS，112 项 |
| 正式模式 API Key，真实 Docker、真实 CLI、模拟 TLS 上游 | PASS，136 项 |
| 同一服务端的实验模式 OAuth 回归 | PASS，110 项 |
| 同一服务端的实验模式 API Key 回归 | PASS，134 项 |
| 发布 CLI 的构建、摘要、不可变解包和拒绝路径 | PASS，35 项 |
| 包管理、helper 和面板权限的公开 HTTP 端到端 | PASS，11 项 |
| 前端构建、类型检查和目标文件 Prettier | PASS |
| 服务端目标文件 Biome 与差异检查 | PASS |
| Hermit `nativebridge` Go vet | PASS |
| 浏览器交互验收 | NOT RUN |
| 真实账号及真实模型上游 | NOT RUN |
| 生产部署 | NOT RUN |

发布 CLI 的 35 项验证以 `build-only` 模式执行。
该组不单独证明 Linux 运行时行为。
Linux 运行时由上述两组正式模式工厂端到端验证。
本次没有编写单元测试。

正式模式直接读取控制容器环境，并确认以下条件：

- 没有 `KIN_KERNEL_TEST_ENDPOINTS`。
- 没有 `KIN_HERMIT_UPSTREAM_URL`。
- 没有 `KIN_HERMIT_API_KEY` 回退值。
- 包的 `acceptance` 为 `production`。
- 包同时声明生产能力及切换就绪能力。

关键用例包含以下场景：

- 已有普通槽位切换到 Hermit。
- 控制平面重启后，显式回滚恢复原容器 ID。
- 暂时移走备份容器后，回滚失败并保留当前容器。
- 恢复备份容器后，重试回滚成功。
- 回滚未完成时，同版本应用也不能绕过暂停。
- tmux 摘要错误的候选包启动失败，并自动恢复原容器。
- 停止槽位切换后仍保持停止。
- 停止槽位重复应用同一版本后仍保持停止。
- 停止槽位回滚后保留原容器 ID 和停止状态。
- 手动关闭的调度状态在切换后保持关闭。
- Hermit 切回原生内核后，再次回滚到 Hermit。
- 主动强制停止原生容器并留下 socket 后，仍能回滚到 Hermit。
- 外部工具未返回时，系统拒绝切换。
- 控制平面重启后，外部工具结果仍返回原工具 ID，工具不重复执行。

所有通过的工厂验收均确认源码未变。
验收结束后，临时网络命名空间、Docker daemon 和 fixture 目录均已清理。
验收没有遗留意外进程。

## 来源和工件

vm2api 来源基线为 `ac067f0e6ed50f2452047d0a0b0f6dec0780d072`。
Hermit 来源基线为 `26c3921ba14b417b69c1765034b9ce779dda078f`。
本次代码尚未提交。
测试包清单记录了工作树状态及逐文件源码摘要。

服务端验收镜像为：

```text
sha256:30f5de80f65f4506ca49aa20136f19448d922e5febfa4f77b4d9137e05be09df
```

镜像内 406 个服务端文件及入口与当前服务端工作树逐字节一致。
前端单独通过构建和类型检查。
最终前端还区分了“切换完成”和“同版本保持不变”的结果提示。
浏览器交互不在上述服务端验收结论内。

本地证据目录为 `.tmp/hermit-transition-20261109/`。

- `summary.json`：汇总结果、镜像和包身份。
- `acceptance-evidence.tar.gz`：完整工厂收据、请求捕获、来源快照及早期失败记录。
- `linux/acceptance-production-oauth/`：正式模式 OAuth 收据。
- `linux/acceptance-production-apikey/`：正式模式 API Key 收据。
- `linux/image-verification-final.json`：镜像源码及线上容器身份核对。
- `packaging/`：35 项发布 CLI 验证。
- `package/`：本次验收使用的 Linux 包、清单及发布收据。
- `web-build-final.log`：最终前端构建记录。

早期失败记录保留了脚本调用错误、重启后未接管 owner、调度字段断言错误和原生 socket 残留问题。
`v7` 因后续修正替代而中断，已确认清理，不计为 PASS。

## 复现

primaryserver 保留冻结源码、固定输入和命令参数。
目录为 `/tmp/hermit-transition-20261109`。
复现只使用隔离模拟上游。

在 primaryserver 上运行：

```python
import json
import subprocess
import uuid
from pathlib import Path

root = Path('/tmp/hermit-transition-20261109')
for mode in ('oauth', 'apikey'):
    command = json.loads((root / f'args-production-{mode}.json').read_text())
    command[command.index('--out') + 1] = str(
        root / f'replay-{mode}-{uuid.uuid4().hex}'
    )
    subprocess.run(command, check=True)
```

## 部署边界

线上控制容器仍为 `30ea6ba478b42439a0187605b8a6d742682979ac7d8b00144a71652ad773b529`。
线上镜像仍为 `sha256:955a027a0cc718875299fe63ecd53d475b1f4000b4d540b5c7579446ee6a0e30`。
本次没有切换任何线上槽位。

正式使用前，按[操作说明](hermit-kernel-switch.md)准备协议设置和新的 Linux 包。
本次验收包来自未提交的工作树，不能视为已发布版本。
