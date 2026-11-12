# vm2api 的 PostHog 全链路观测契约

日期：2026-11-12。状态：核心接入已实现。已完成隔离验收和 TrueRouter 项目回读；生产部署与完整指标、告警尚未完成。

## 目的与职责

本端负责 `sub2api → vm2api → Hermit` 的父上下文接续、调度、分类调用、各次尝试、槽位传输和日志导出。日志和追踪经宿主 Collector 进入同一个 PostHog 项目。

总决策位于 clearcc 根目录的 `POSTHOG_OBSERVABILITY_DECISION.md`。本文保存本端可以独立实施的契约。共享语义变更需同步总决策与相邻仓库。

## 输入与输出

只接续经过鉴权且来源确认为受控 sub2api 的父上下文。普通客户即使通过 API 鉴权，也不能成为可信内部传播者。直接对客户开放的入口新建受控 trace。

使用官方 OpenTelemetry Node.js SDK 管理异步上下文。每次调度、分类子请求和实际下发分别创建子 span。不得用全局可变对象保存活动请求。

向 Hermit 发送的 W3C 字段放在现有 `envelope.headers` 中。只发送 `traceparent` 和按需保留的 `tracestate`。初期不传播 `baggage`，不新增顶层 envelope 字段。

| 现有字段或操作 | 保留规则 |
|---|---|
| vm2api `request_id` | 保留入口生成和接收语义，作为本地查询标识 |
| `x-hermit-gateway-request-id` | 继续映射 vm2api 入口请求 |
| envelope `request_id` | 每次实际调用独立生成，继续用于取消 |
| 日志 `attempt_id` | 槽位边界复用 envelope request_id，不生成重复 ID |
| `trace_id` | 与父请求和各次尝试共享，作为全链路关联依据 |

## 当前能力与修改位置

核对时 HEAD 为 `ac49f288e219e76179c58fd7a077c7dc01cf0d03`。核对对象是工作区，包含并行内核计时工作；该 HEAD 不代表全部计时代码。内核计时源码和验收文件属于其他工作，不纳入本次修改。实施前重新确认构建来源。

| 位置 | 已有能力 | 本次实施要求 |
|---|---|---|
| [handle-protocol.mjs](../src/lib/protocol/handle-protocol.mjs) | 请求日志上下文、调度、尝试、网关请求 ID 传递 | 建立入口与子 span，覆盖真实下发和最终结果 |
| [go-worker-client.mjs](../src/lib/transport/go-worker-client.mjs) | 槽位 envelope、独立请求 ID、取消和响应解析 | 注入当前尝试上下文，关联槽位 ID 与取消 ID |
| [request-log.mjs](../src/lib/admin/request-log.mjs) | SQLite 摘要、可选 JSONL 镜像 | 补齐 trace/span 与阶段事件，过滤上传字段 |
| [kernel-timing.mjs](../src/lib/protocol/kernel-timing.mjs) | 校验当前请求的内核计时回执 | 复用有效阶段数据，不伪造 span 时间，不改变回执协议 |
| [hermit-kernel-supervisor.mjs](../src/lib/transport/hermit-kernel-supervisor.mjs) | 启动 Hermit，写入宿主 hermit-stderr.log | 核对日志出口、实例与槽位身份、轮转及采集权限 |
| [hermit-runtime.mjs](../src/lib/vm/hermit-runtime.mjs) | 原生槽位配置和环境 | 提供明确的内部遥测配置，不向 CLI 泄露 PostHog 凭据 |
| [package.json](../package.json)及服务启动入口 | 当前未接入所需 OTel Node.js SDK | 增加必要依赖，初始化 provider、异步上下文和有界关闭刷新 |

现有内核计时已有 `pool_wait`、`context_check`、`managed_prepare`、`runtime_ready`、`delivery`、`history_confirm` 等字段。回执需要匹配当前槽位 request_id。缺失或错误回执不能导致业务失败，也不能填成零耗时。

## 日志、计时与结果

资源使用 `service.namespace=truerouter`、`service.name=vm2api`，补充版本、实例和环境。调度和尝试日志补充不透明的节点、VM、槽位、账号标识及内核包摘要。

日志携带 `trace_id` 和 `span_id`。Collector 将它们解析为 OTLP 专用 TraceId、SpanId 字段。普通 JSON 字段存在不等于 PostHog 已完成关联。

阶段日志要覆盖尚未完成的长请求。不能只等待最终 JSONL 摘要。分类子请求、重试和换槽位分别关联本次 span，并保留入口最终结果。

首个字节、首个协议事件和首个内容输出分开，保留各自起点和单位。内核相对计时不能直接当作客户入口耗时，无法观测的值缺省。

同一原生进程可处理多个请求。活动上下文必须按操作绑定。同会话并发不得串 trace。独立后台工作不能继承已结束请求的活动 span。

HTTP 200 与流完成分别记录。响应已开始、客户端取消和执行结果未知要有明确字段。观测结果不触发请求重放或额外账号切换。

## 采集与现有遥测边界

保留 SQLite 用量记录。`KIN_REQUEST_LOG_JSONL=1` 可作为现有摘要采集入口，但不是完整接入方案。摘要含 `api_key_presented` 等字段，必须按白名单输出到 PostHog。禁止直接上传整个摘要、调试记录、请求体和错误原文。

本观测方案与 [VM-native telemetry](TELEMETRY.md) 分开。不得复用官方上游发送器、OAuth 账号凭据或 seed policy 启停规则。现有 telemetry_ready 等状态不代表 PostHog 接入状态。

应用只发送到内部 Collector。宿主负责采集文件、解析 trace/span、管理读取位置及资源身份。容器内 127.0.0.1 不代表宿主 Collector，需按真实放置验证可达性。

## 兼容与端到端验收

缺省追踪头不影响现有调用。旧内核忽略额外 Header 时，只能报告关联未贯通，不能声称完整通过。Hermit 严格 envelope 解析、取消和请求预算必须保持有效。

实施前固定以下失败场景，再使用端到端测试验证：

1. sub2api 父上下文接续，调度与 Hermit 子 span 正确。
2. 分类、重试和换槽位：各尝试可查，槽位取消 ID 正确。
3. 同会话并发、owner 复用和后台工作：上下文不串请求。
4. 流中断、客户端取消与结果未知：最终结果明确，不自动重放。
5. 计时回执缺失、错误和错配：不污染当前请求数据。
6. 新旧内核和缺省追踪头：业务兼容，缺失关联明确报告。
7. Collector 不可用、日志轮转和重启：业务继续，采集进度与丢弃可查。
8. 从目标 PostHog 项目回读三端 trace 和日志，定位网关请求、各次尝试及内核版本。

每次验收保留命令、summary.json、源码与构建及内核包摘要、脱敏配置、平台回读查询与结果、trace/log 样本和清理回执。分别报告隔离上游、平台、真实槽位和真实上游结果。

核心接入和隔离平台验收结果见下节。生产部署、真实上游和完整协议路由验收仍未执行。

## 本次已实现的接入与验收边界

总验收回执位于 clearcc 的 `artifacts/posthog-observability-acceptance-20261112/README.md`。回执记录平台查询、构建摘要、清理结果和未验收范围。

应用向内部 Collector 发送标准 OTLP，保留现有请求与取消标识。PostHog 目标为 US 区 TrueRouter，ProjectID 730627。上传凭据只由宿主 Collector 管理。

请求阶段使用专用结构化事件，资源身份与 span 一致。Collector 只上传批准事件，过滤敏感字段，并按服务、实例和环境分组。宿主配置、模板、复现命令和总验收记录位于 clearcc 的 observability/README.md。

隔离链路使用真实三端中间件、传输与槽位入口。普通响应和流式响应经过真实 Hermit 原生运行时与固定 CLI，上游仅为本机模拟服务。sub2api 数据库、计费和账号路由不在该夹具范围内。故障、取消和并发使用受控原生运行时夹具，不能称为真实 CLI 故障验收。

已单独验证 Collector 的服务分组、trace/span 关联、字段过滤、重启读取位置、后端失败后的持久化队列恢复和日志轮转。目标 PostHog 项目已回读三端完整追踪与关联日志。生产放置、真实账号、真实上游、全量协议、指标总览和告警仍需部署验收。

本端使用独立 TRUEROUTER_TRACE_TOKEN 验证内部追踪来源。Node.js 要求 >=22.15.0。只对已确认是 Hermit 的运行时注入槽位上下文。KIN_HERMIT_OTLP_ENDPOINT 用于将可达的内部 Collector 地址传入 Hermit 进程，不传入 PostHog token。可信调用的结果元数据通过响应头或流尾部字段传给 sub2api。

旧 request-log E2E 的三个 503 失败已在本次工作开始前的 HEAD 独立归档中复现。本次未修改其断言；内核计时 E2E 已通过。新增 trace/span 字段进入专用事件和 JSONL 摘要，未新增 SQLite 列或改写原用量数据库结构。
