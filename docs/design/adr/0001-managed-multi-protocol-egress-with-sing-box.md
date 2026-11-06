# ADR 0001：使用 sing-box 管理多协议出口

- 日期：2026-11-05
- Status: Implementation in progress; full acceptance is incomplete. See the [acceptance audit](../implementation/0001-managed-egress-acceptance.md).
- 范围：Compose 部署、代理管理、槽位绑定和宿主机出口

## 背景

当前代理池支持外部 SOCKS5 代理和本地出口。用户需要在 vm2api 中管理多个 Hysteria 2 节点，并为每个槽位指定出口。后续增加协议时，不应改变槽位绑定模型和请求转发路径。

当前 `docker-compose.yml` 使用宿主机网络运行 vm2api，并挂载 Docker socket。绑定远程 SOCKS5 的槽位通过 `kin-egress` 实现透明转发。继续使用现有代理管理、归属检查、绑定额度和恢复机制。

在当前面板中添加 SOCKS5 地址，不会管理该地址背后的代理进程。因此，受管节点需要同时具备配置持久化和运行生命周期管理能力。

## 决策

在每台受支持的槽位宿主机上，将 sing-box 部署为独立的 Compose 服务。每台宿主机共用一个 sing-box 实例，不为每个槽位创建实例。vm2api 管理配置并检查运行状态。

槽位绑定不依赖具体协议。槽位引用出口 ID。出口解析模块根据宿主机和调用方返回可用地址。受管节点提供带认证的宿主机本地 SOCKS5 入口。外部 SOCKS5 代理保留现有路径。

```text
代理管理界面
        |
        v
vm2api：持久化出口配置和槽位绑定
        |
        v
宿主机运行管理模块：生成 → 检查 → 应用 → 验证
        |
        v
槽位宿主机上的 sing-box
  SOCKS5 端口 A → Hysteria 2 节点 A
  SOCKS5 端口 B → Hysteria 2 节点 B
        ^
        |
kin-egress ← 绑定对应出口 ID 的槽位
```

### 模块边界

| 模块 | 职责 |
| --- | --- |
| 代理池 | 管理节点配置、归属、绑定额度和槽位绑定 |
| 协议配置转换模块 | 检查支持的协议字段，生成 sing-box 出站配置 |
| 宿主机运行管理模块 | 分配端口，生成、检查、应用和恢复配置，报告运行状态 |
| 出口解析模块 | 根据调用方和宿主机，将出口 ID 解析为正确的连接地址 |
| `kin-egress` | 保留现有槽位透明转发路径 |

使用明确的协议类型和协议专用字段。将运行地址与用户填写的节点配置分开保存。不建立通用插件框架，不通过面板开放任意 sing-box 配置。

第一版支持现有外部 SOCKS5、现有本地出口和新增的受管 Hysteria 2。增加协议时，扩展字段检查、配置转换和界面字段，不引入新的槽位绑定模型。

### 部署

- 在主 Compose 文件中添加 sing-box 服务。使用经过验证的官方镜像，并固定版本或摘要。
- 使用 Linux 宿主机网络。受管 SOCKS5 入口只监听回环地址，并使用系统生成的认证凭据。
- 将配置持久化到部署数据目录。vm2api 写入该目录，sing-box 只读挂载该目录。
- 使用目录挂载，确保替换配置文件后，容器仍能读取新配置。
- 不为 sing-box 增加 TUN、特权模式或 Docker socket 访问权限。
- 启动服务前，提供并验证有效的初始配置。没有受管节点时，服务也必须正常启动。
- sing-box 不可用时，管理 API 仍需可用。只将受影响的受管出口标记为不可用。
- 同步更新安装、升级、开发覆盖配置和 ARM64 部署路径。固定镜像前，验证目标架构支持情况。

实现时明确初始配置的生成方和启动顺序。不得让 vm2api 与 sing-box 的就绪条件形成循环依赖。

### 持久化状态与路由

数据库迁移必须保留已有代理 ID 和槽位绑定。保存协议配置、认证凭据和稳定的宿主机端口分配。认证凭据沿用现有保护规则。使用有界端口范围，并检查端口冲突。

使用宿主机和出口 ID 标识运行位置。不得将控制面的回环地址当作远程宿主机地址。每个受管入站必须明确路由到指定出站。不得配置直连回落，也不得自动选择其他出口。

分别记录期望配置版本和已生效配置版本。数据库写入成功不代表运行实例已使用新配置。运行状态与实际出口状态必须分开显示。

### 配置生命周期

同一宿主机上的配置更新按顺序执行：

1. 根据持久化的期望状态生成候选配置。
2. 使用与运行服务相同版本的 sing-box 检查候选配置。
3. 确定应用配置会影响哪些运行中的槽位。
4. 使用经过验证的机制应用配置。
5. 验证进程、监听端口和受影响的出口路径。
6. 验证成功后，记录已生效配置版本。
7. 应用失败时，恢复上一版可用配置。恢复失败时，将受影响出口标记为不可用，并阻止其接收新请求。

不得假设 sing-box 支持任意配置热更新。实现配置应用操作前，必须验证所选版本的实际行为。

如果更新需要重启共享实例，先暂停所有受影响槽位的新请求，再等待在途请求结束。等待超时后，保留原配置，并将更新标记为待应用或失败。不得静默中断在途请求后报告更新成功。

删除节点时，必须检查已有绑定和归属。确认新运行状态后，才能删除旧监听端口并释放端口。日志、API 摘要和验收工件不得包含节点密钥。

### 用户流程

扩展现有代理管理界面，不另建一套节点列表：

1. 选择协议并填写节点参数，或导入支持的 `hy2://`、`hysteria2://` 链接。
2. 保存节点，并显示配置应用状态。
3. 检查连接和实际出口 IP。
4. 创建或编辑槽位时选择出口。
5. 启动槽位前，确认出口在目标宿主机上已就绪。

内部 SOCKS5 端口属于实现细节。用户通过出口标识和名称选择出口。创建槽位不会创建新的 sing-box 实例。

检查所有使用代理的调用方，包括 Claude 推理、凭证换票、刷新、地理信息检查和连接探测。控制面操作必须根据出口所在宿主机，使用同一个指定出口。

### 集群支持

先完成本机最小端到端版本，再通过现有集群部署通道接入配置下发和运行管理。控制面的单个 Compose 服务不会自动将 sing-box 部署到所有集群宿主机。

远程支持实现并验证前，必须明确拒绝将受管节点绑定到不受支持的远程宿主机。不得静默改走控制面宿主机。完整集群支持仍属于本执行计划。

## 备选方案

| 方案 | 决策 |
| --- | --- |
| 每个节点运行一个官方 Hysteria 客户端 | 不作为默认架构。每增加一种协议，都需要增加对应的进程管理逻辑 |
| 每个槽位运行一个 sing-box 实例 | 不采用。实例生命周期会与槽位耦合，还会重复保存节点配置 |
| 手工部署 sing-box，再填写 SOCKS5 地址 | 技术上可行，但不能满足在 vm2api 内管理节点的需求 |
| 每台宿主机共用一个 sing-box 实例 | 采用。必须处理共享实例重启和故障对多个出口的影响 |

## 影响

现有透明转发路径可以保留。协议差异由 sing-box 和配置转换模块处理。Compose 可以统一启动所需服务。

共享实例发生故障或重启时，可能影响该宿主机上的所有受管出口。配置应用流程必须处理这一影响。不同节点记录也不保证具有不同的公网 IP。出口探测必须报告实际观测到的地址。

## 执行计划

1. 检查代理调用方、数据库约定、Docker 管理、安装路径和宿主机标识。实现前记录失败场景。
2. 添加 Compose 服务和初始配置。验证全新安装、无节点启动，以及已有出口的兼容性。
3. 实现本机最小端到端版本：一个 Hysteria 2 节点、持久化端口分配、配置检查、配置应用、出口验证和一个绑定槽位。
4. 实现串行更新、期望配置版本、已生效配置版本、在途请求排空、回滚和重启恢复。扩展到两个节点和两个槽位。
5. 扩展现有代理 API 和界面，加入协议字段、链接导入、状态、编辑、删除和绑定。保留现有权限和脱敏行为。
6. 为所有代理调用方增加按宿主机解析出口的能力，并接入远程宿主机部署。验证完成前，阻止不受支持的部署位置。
7. 完成端到端验收，并更新中文部署文档和运维文档。

## 验收与可重复证据

使用端到端测试作为功能测试机制，不新增单元测试。适用时复用现有端到端测试运行器。配置检查和构建只作为辅助检查，不能证明出口已正常工作。

覆盖以下成功路径和失败场景：

- 全新安装、保留已有绑定的升级，以及没有受管节点时的启动。
- 使用两个受控代理节点和两个槽位，证明每个槽位都经过指定出口。
- 编辑节点、重新绑定槽位、重启服务和重启宿主机后，保留期望的映射关系。
- 无效配置、错误凭据、节点不可用、端口冲突和并发编辑不会破坏已生效状态。
- 停止 sing-box 或节点后，受影响请求失败，且不回落直连。
- 配置应用失败后恢复上一版可用配置；回滚失败后，受影响出口保持不可用。
- 重启共享实例前等待在途请求结束；等待超时后保留当前配置。
- 现有 SOCKS5 和本地出口继续正常工作。
- 继续执行归属检查、密钥脱敏、已绑定出口的删除限制，以及不受支持的远程部署限制。
- 受支持的远程部署使用远程宿主机出口，包括控制面发起的凭证操作。

生成精简且脱敏的验收记录。记录源代码版本、镜像摘要、测试环境标识、复现命令、配置版本或摘要、预期出口、实际出口，以及故障和恢复结果。不得保存凭据和原始请求体。使用受控端到端测试环境，确保不依赖生产账号也能重复验收。

分别记录受控网络验收、真实 Claude 请求验收和用户执行的可视化验收。三类证据不能互相替代。未经单独授权，不得为可视化验收启动浏览器、应用或虚拟机。部署成功或构建成功不能证明真实 Claude 请求经过了指定出口。

## 参考资料

- [当前 Compose 部署](../../../docker-compose.yml)
- [代理池](../../../src/lib/vm/proxy-pool.mjs)
- [出口路由](../../../src/lib/vm/egress.mjs)
- [代理解析](../../../src/lib/vm/proxy-resolve.mjs)
- [代理管理界面](../../../web/src/features/proxies/proxy-manage-panel.tsx)
- [sing-box Docker 部署](https://sing-box.sagernet.org/installation/docker/)
- [sing-box Hysteria 2 出站配置](https://sing-box.sagernet.org/configuration/outbound/hysteria2/)
- [sing-box 路由规则](https://sing-box.sagernet.org/configuration/route/rule/)


## Import readiness update (2026-11-06)

The panel import endpoint saves a Hysteria 2 node and then applies the selected
host configuration before responding. It uses the existing serialized apply,
drain, validation, and rollback path. A successful application returns fresh node
state with `application_status: applied`; the node can then be assigned to a slot
on that host without a separate apply action. Inline slot assignment uses the
managed binding path to initialize the slot helper.

If application fails, the endpoint retains the saved node and returns
`application_status: pending` with `application_error`. The panel reports this
as a partial failure and offers application retry. It does not ask the user to
import the same node again. Pending nodes remain unavailable for assignment.
Existing explicit apply and recovery actions remain available for maintenance.

Validation: the panel API E2E records failure retention and secret redaction. The
Linux E2E imports a controlled exit and assigns it to a slot without a separate
apply request, then verifies real traffic through that exit. Both produce
sanitized receipts under `.tmp/managed-egress-e2e/`.

## Probe helper identity correction (2026-11-06)

The manual probe repair callback must resolve the canonical authenticated proxy
before creating a local helper. Persisted pool rows carry `managed_config`, while
helper creation requires the explicit `managed` flag. Passing the persisted row
created a helper without its drain control socket. Periodic inspection then
rejected that helper and blocked otherwise healthy exit and geolocation traffic.
Unbound helpers can be reconciled through the existing maintenance path. Bound
helpers still require a verified drain path before replacement.

The Linux E2E now probes an imported node before assignment, checks its drain
control interface, waits for periodic inspection, and requests geolocation through
the same panel API. The node must remain ready and report the controlled exit IP.
