# Hermit 多会话池与席位对接验收

日期：2026-11-09。

本次完成代码实现和隔离验收。本次没有部署到生产环境。

## 行为

1. vm2api 从已安装包读取 `native_session_pool` 能力。
2. vm2api 将可信能力写入 VM 的 `kernel_package` 绑定。
3. 新版 Hermit 使用现有 VM 席位设置。默认容量为 20。
4. vm2api 将容量和空闲 TTL 写入 Hermit 配置。
5. Hermit 按会话 ID 和 agent ID 分配独立的内层实例。
6. 同一 agent 的请求在同一实例中串行执行。
7. 返回工具调用后，vm2api 保留该 agent 的席位。
8. 工具结果续接仍使用该实例。
9. 续接完成后，vm2api 释放席位。Hermit 可以保留空闲实例。
10. 新会话需要容量时，Hermit 可以替换最久未使用的空闲实例。
11. Hermit 先确认旧实例的进程组已停止，再复用物理容量。

父 agent 等待工具结果时占用一个席位。三个运行或等待工具结果的子 agent 另外占用三个席位。此时共占用四个席位。已经完成的 agent 释放席位。

等待工具结果的实例不受空闲 TTL 回收。放弃该工具等待后，需要发送续接或执行明确的运行时恢复。

## 变更范围

| 部分 | 变更 |
| --- | --- |
| 席位容量 | 新包继承现有 VM 容量；旧包保持单席位 |
| 启动配置 | 下发 `session_capacity` 和 `session_idle_ttl_seconds` |
| 席位释放 | 工具等待期间保留席位和粘性槽位编号 |
| 子 agent | 复用现有 agent 身份派生逻辑 |
| 内核切换 | 从目标包清单记录或清除会话池能力 |
| 容器资源 | Hermit 按席位数量分配 PID 预算；每个席位沿用 256 的预算 |
| 安装校验 | 校验会话池能力字段的布尔类型 |

容量为 20 的新版 Hermit 使用 PID 上限 5120。旧版 Hermit 使用上限 256。其他内核沿用原上限。VM 的内存和 CPU 设置仍由现有机器规格管理。

本次 Hermit 实现复用了现有 CLI 和 hook。官方 CLI 可执行文件和 hook 源码保持原样。

## 验收

所有请求均使用模拟凭据和回环上游。Linux 测试容器使用 `--network none`。

| 场景 | 结果 | 检查数 | 边界 |
| --- | --- | ---: | --- |
| 原生会话池 | PASS | 25 | 真实固定版本 CLI、tmux 和内核；容量为 2 |
| 原生会话池 helper | PASS | 53 | 真实内核、凭据存储和 helper；模拟 OAuth 上游 |
| 20 席位与 Workflow | PASS | 27 | 真实 HTTP 网关、身份改写和调度；模拟内核 |
| 安装与回滚 | PASS | 40 | 真实包校验和切换流程；模拟 Docker 和 guest |
| helper 路由回归 | PASS | 26 | 真实 HTTP 网关；进程调用记录夹具 |
| 单包生命周期回归 | PASS | 1 个端到端场景 | 替换唯一安装包，保留活动 VM 使用的文件 |

20 席位场景打开一个父 agent 和 19 个子 agent。20 个 agent 分别等待工具结果。第 21 个 agent 无法进入。父 agent 在容量已满时仍能续接。父 agent 完成后，只释放一个席位。新 agent 随后获得该席位。流式响应和非流式响应均已覆盖。

原生会话池场景同时发送八个请求。容量为 2 的会话池只允许两个请求进入上游。该场景还验证独立会话、子 agent、原实例续接、同一 agent 串行处理、空闲替换、TTL、helper 互斥、取消请求和进程组清理。

安装场景验证旧包单席位、新包能力记录、20 席位展示、失败回滚，以及新旧包的 PID 预算。

复验命令：

```sh
node --test \
  test/e2e/hermit-seats.e2e.test.mjs \
  test/e2e/kernel-install-hermit.e2e.test.mjs \
  test/e2e/hermit-single-package.e2e.test.mjs \
  test/e2e/hermit-helper.e2e.test.mjs
```

使用 Linux 隔离容器执行。安装测试自带 Docker 记录夹具。helper 测试使用固定的 `kin-api-kernel` 测试二进制，并通过 `PATH` 提供仅返回“容器不存在”的 Docker 启动检查夹具。

## 工件

- Hermit 代码基线：`dac6b8b159c32eaffe93924c9548ab26bae43042`，另加本次工作区变更。
- vm2api 代码基线：`020b28f11d0bdd7611724eb1f5f8fb8cf569bfa2`，另加本次工作区变更。
- Hermit 测试二进制 SHA-256：`25e8212d107b1b14a010fc0928fe8b85fb77785d025e90077d864595ef1ab981`。
- 开发包：`0.0.0-dev.nativepool20261109.2`。
- 包归档 SHA-256：`ac32b3dfe651e916fd64fc2b487c09528bd87038e8f6b0ebc1ca79b77664dedf`。
- 服务器工件：`primaryserver:/tmp/hermit-native-pool-20261109/evidence/`。
- 本机工件：`../hermit/experiment/evidence/native-session-pool-20261109/`。
- 原生验收说明：`../hermit/experiment/NATIVE_SESSION_POOL_RESULTS.md`。

开发包的二进制与验收二进制摘要一致。包记录了工作区未提交状态。正式发布时，从提交后的源码重建安装包。

## 未执行与既存失败

真实账号请求、20 个真实 CLI 同时满载、停止结果不明的故障注入，以及生产部署均为 NOT RUN。真实 CLI 容量测试使用两个实例。20 席位测试模拟了内核边界。

扩展账户池回归中，`account-pool-failover.e2e.test.mjs:66` 有一项既存断言失败。未修改的 vm2api HEAD 同样失败。另两项账户池场景通过。本次保留基线收据，不修改该断言。

生效需要同时使用本次 vm2api 和声明会话池能力的 Hermit 包，再通过现有安装流程重装应用目标槽位。本次没有执行该上线步骤。
