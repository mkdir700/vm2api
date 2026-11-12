# 内核请求耗时明细

## 行为

请求日志的「性能」页可以展示内核阶段耗时和内核上游时间点。
只有内核明确声明支持并提供有效的本次请求凭据时，vm2api 才保存并展示明细。
旧内核和历史日志不展示该区域。网关重启或内核清空近期诊断不会删除已保存明细。

## 能力与传输契约

Hermit 新包声明 `capabilities.request_timing: true`。
健康响应声明 `request_timing: true`。
每次响应通过 `X-Kernel-Request-Timing: 1` 声明本次使用的协议版本。
响应在写入正文前声明 `Trailer: X-Kernel-Timing`。
响应完成后将 JSON 凭据写入 `X-Kernel-Timing` 尾部字段。

```json
{
  "schema_version": 1,
  "request_id": "本次内核 envelope 的 request_id",
  "selection": "owner_reused",
  "timings_ms": { "pool_wait": 0, "context_check": 2.5, "delivery": 30 },
  "upstream_timing": { "dispatch_ms": 0.1, "first_protocol_ms": 12, "complete_ms": 20 }
}
```

vm2api 以响应声明为运行时能力依据。
仅有包能力或健康声明不能触发展示。
仅有尾部字段而没有响应声明也不能触发展示。
其他内核可以实现同一版本协议。

接收方校验协议版本、本次内核请求 ID、8 KiB 大小限制和有限非负数。
接收方只保存约定字段。
接收方移除内核请求 ID、内部会话标识和交换标识。
非法凭据不影响正常推理响应。
HTTP 传输本身损坏或超出 HTTP 解析器限制时，按原有传输错误处理。

## 指标口径

| 字段 | 展示 | 口径 |
| --- | --- | --- |
| `pool_wait` | 内核会话获取 | 获取会话的耗时，可能包含创建工作 |
| `context_check` | 上下文检查 | 检查或恢复会话上下文 |
| `managed_prepare` | 受管环境准备 | 本次启动所记录的环境准备耗时 |
| `runtime_ready` | 运行时就绪 | 本次启动所记录的运行时就绪耗时 |
| `delivery` | 请求执行与交付 | 内核将本次请求交给会话后的处理窗口 |
| `history_confirm` | 历史确认 | 完整响应后的原生历史确认 |

这些阶段可能重叠。不能将阶段相加作为总耗时。
预热准备可能发生在请求到达之前。相关耗时不是请求额外等待时间。
复用会话时不复制之前请求的启动耗时。

上游时间点包含发起请求、收到响应头、首字节、首个协议事件、首个内容和响应完成。
所有时间点使用同一内核上游单调时钟起点。
它们是累计时间点，不能相加。
未取得的字段保持缺失或 `null`，页面不展示该字段。
零值表示实际记录为零，页面保留零值。

## 存储

迁移 `055_usage_logs_kernel_timing.sql` 添加可空列 `usage_logs.kernel_timing`。
面板 API 将有效快照映射为 `kernelTiming`。
快照对应最终返回的内核尝试，不代表每次失败重试的全部明细。
不需要查询内核的近期会话诊断接口。

## 验收失败方式

- 内核没有声明支持，页面仍显示明细。
- 凭据版本、请求身份、数据大小或数值不合法。
- 非流式、实时流式或 verified 流式丢失尾部字段。
- 会话复用时读取了旧请求耗时，或异步 owner 状态导致新耗时丢失。
- 零值被隐藏，或缺失字段被填为零。
- 网关重启后日志快照丢失。
- 内部身份随响应公开，或实验退出后留下进程。

## 可重复验收

在 vm2api 根目录执行：

```sh
(cd api-kernel && go build -o /tmp/clearcc-kernel-timing-api ./cmd/kin-api-kernel)
KIN_API_KERNEL_BIN=/tmp/clearcc-kernel-timing-api node --test test/e2e/kernel-timing.e2e.test.mjs
```

使用支持 `node:sqlite` 的 Node.js。
设置 `KERNEL_TIMING_OUT` 可以固定验收工件目录。
工件包含 `summary.json` 和面板日志响应。

前端验收先执行 `pnpm -C web build`，再给上述测试设置 `KERNEL_TIMING_BROWSER=1`。
前端验收使用 `ego-browser`，生成页面截图、页面快照和 `browser-summary.json`。

真实内核验收在工作区根目录执行：

```sh
(cd hermit && go build -o /tmp/clearcc-kernel-timing-hermit ./cmd/hermit)
python3 hermit/experiment/request_timing_e2e.py \
  --hermit /tmp/clearcc-kernel-timing-hermit \
  --node /Users/mark/.nvm/versions/node/v22.23.4/bin/node \
  --out artifacts/kernel-timing-native-20261112
```

该实验使用 macOS 隔离规则、固定 CLI 和本机模拟上游。
输出目录必须不存在。
验收覆盖非流式、实时流式、verified 流式、会话复用和进程回收。
真实账号和真实提供方请求不属于该实验。
