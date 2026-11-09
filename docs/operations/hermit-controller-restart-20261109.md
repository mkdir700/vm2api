# 控制平面重启后恢复 Hermit

日期：2026-11-09。

首次会话池部署在内核健康检查阶段失败。任务为 `9fcc4d3359e042eaa4d5945e85edbdb3`。
执行器恢复了旧控制镜像，但旧控制平面也没有立即恢复 Hermit。任务进入 `RECOVERY_REQUIRED`。

Hermit 的进程租约由控制平面持有。控制平面退出时，Hermit 按设计停止。
原启动流程在打开 HTTP 服务前没有重建该租约。
开机恢复流程跳过已经运行的槽位容器。watchdog 使用故障退避，并且传入的调用上下文缺少 `projectRoot`。
因此，容器仍运行，`kernel.sock` 却不存在。

通过现有同版本 `kernel-transition apply` 入口重新拉起原 Hermit 后，健康检查恢复。
该调用返回 `unchanged: true`，没有重建槽位容器。
核对原控制镜像、原内核健康、凭据和槽位记录后，恢复原任务的调度暂停。
原任务记录为 `ROLLED_BACK`，并保留最初错误、自动恢复失败状态和人工恢复事件。

修复将原生内核的租约恢复放在 HTTP 监听之前。
恢复范围为本机、记录为运行中、没有待处理迁移或内核切换的 Hermit 槽位。
调度暂停不阻止恢复进程租约。
停止的 VM 保持停止。
调用上下文通过已有 `homeDir` 推导缺失的 `projectRoot`，使 watchdog 和其他入口使用同一所有者标识。

端到端测试为 `test/e2e/hermit-restart.e2e.test.mjs`。
旧镜像确定失败于 `boot_0_kernel_ready_before_first_request`。
修复后验证控制平面连续两次启动、首请求前内核健康、新所有者目录、原容器身份、暂停调度、凭据和租约清理。
Docker 和 guest 内核使用独立进程夹具。测试运行真实 HTTP 控制平面和进程租约管理。
该测试不发送模型请求。

原失败收据保存在 `primaryserver:/tmp/hermit-native-pool-production-82f5e3d-0d4eccef/qualification/restart-red/`。
修复复验收据保存在同目录下的 `restart-green2/`。
