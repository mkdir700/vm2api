# 审查服务与审查记录

## 使用入口

- 设置：`/console#/settings/moderation`。选择当前服务，填写地址、密钥和模型，然后保存。
- 记录：`/console#/moderation-reviews`。侧栏“审查记录”提供服务、模型和结果筛选。
- 风险审计页保留规则、关卡计数和拦截流水，并链接到上述两个页面。

服务切换立即影响后续审查。进行中的审查使用调用开始时读取的配置。未保存的草稿存在时，先保存或放弃草稿，再切换服务。

每种服务保存独立的连接、密钥、模型、题库、阈值和失败策略。审查总开关、账号范围和硬规则继续使用全局配置。旧配置自动成为当前服务的配置，不需要手工迁移。

## 模块职责

`src/lib/moderation/providers.mjs` 集中定义服务注册、地址规则、请求适配、密钥失效规则和公开价格。当前支持 Jev、Perplexity、Laya 和 ModernBERT。两种协议都支持 `state`、命名问题和 `noul` 概率，因此共享问题构造和评分策略。

`jev-intercept.mjs` 保留已有外部接口和四层拦截流程。统一审查流程负责文本准备、缓存、轮询、故障切换和审查结果。新增服务不需要在各业务入口添加分支。

`jev-usage.mjs` 规范化调用用量。`JevUsageRepo` 保存上游调用及其单价快照。`ModerationReviewsRepo` 保存逐次审查，并通过 `review_id` 关联零到多次调用。

设置组件位于 `web/src/features/settings/moderation-pane.tsx`。独立记录页面位于 `web/src/features/moderation-reviews/index.tsx`。

## 配置兼容

继续使用 `settings.jev_intercept` 和 `GET/PUT /api/panel/jev-intercept`。`service_profiles` 保存按服务区分的配置，当前启用配置仍保留在原字段中。接口只返回当前配置和脱敏密钥标识，不返回 `service_profiles` 或完整密钥。

使用 `PUT {"provider":"perplexity"}` 切换服务。后续 PUT 更新该服务的配置。切回旧服务时恢复旧配置。

Perplexity 默认使用 `pplx-decider-v1.3`，默认超时为 30 秒。后台支持 200–60000 毫秒的超时。模型选择列表来自官方文档，不请求未约定的模型目录接口。审查不启用联网检索。Perplexity 的 429 不会永久停用密钥。模型返回缺失、非数字或越界分数时，按不可用策略处理。

## 审查记录

`GET /api/panel/moderation-reviews` 支持以下查询：

- `provider`：服务标识。
- `model`：请求模型，精确匹配。
- `result`：`pass`、`block`、`unavailable` 或 `skipped`。
- `limit`：每页最多 100 条。
- `cursor_created_at` 与 `cursor_id`：稳定游标。

`GET /api/panel/moderation-reviews/:id` 返回审查与实际调用明细。两个接口仅允许管理员访问。

每条审查保存业务请求 ID、服务、配置标识、配置版本、请求模型、返回模型、阈值、拦截方向、结果、实际动作、分类、耗时、缓存来源和费用。配置版本是调用配置的摘要，不包含可恢复的密钥。普通推理可能在转换前后分别执行审查，同一请求 ID 可以对应多条记录。

缓存命中保留原模型和来源审查 ID，本次调用次数与新增费用为零。缓存身份包含服务、模型、连接、题库、阈值和文本。后台基准测试只进入调用用量，不伪造业务审查记录。

调用明细保存上游请求 ID、HTTP 状态、请求模型、返回模型、密钥指纹、Token、单价和计价版本。超时或网络中断后，上游可能已处理请求；没有用量时费用保持未知。

## 费用

金额采用整数纳美元存储，页面以 USD 显示。Perplexity 官方标准模型每个输入 Token 为 20 纳美元；Flash 为 10 纳美元。输出免费。按返回的 `usage.input_tokens` 计算，不按字符数推算或额外乘问题数量。

已知模型但没有用量、未知模型、未确认价格的中转地址都显示费用未知。一次审查包含未知费用的尝试时，总费用保持未知，同时保留已知部分。每次调用保存当时的单价和计价版本，后续服务切换或价格更新不重算旧记录。金额为公开价格估算，不能视为官方账单。

审查记录和调用明细沿用 30 天保留策略。独立页面的分模型汇总使用当前保留记录和筛选范围。原调用用量累计汇总继续保留。旧版调用记录通过“调用用量与旧版记录”查看，不补造旧审查结果。

迁移 `057_moderation_reviews.sql` 新增审查表，并为原调用表新增关联、请求模型、返回模型和上游请求 ID 字段。

## 验证

运行：

```sh
MODERATION_E2E_ARTIFACT=docs/evidence/moderation-services-e2e.json node --test test/e2e/moderation-services.e2e.test.mjs
```

使用支持 `node:sqlite` 的 Node 22.13 或更新版本。本次固定使用 Node 22.23.4。

验收通过本地真实 HTTP 网关和模拟审查上游验证服务切换、地址适配、模型和阈值恢复、缓存归属、标准及 Flash 价格、未知费用、失败策略、调用明细、筛选、分页、重启持久化和权限。测试子进程通过专用导入模块把 Perplexity 官方地址转发到本地模拟上游，不向真实付费服务发请求。

本次没有执行真实 Perplexity 付费调用或浏览器视觉验收。

官方依据：

- [Decisions API](https://docs.perplexity.ai/docs/decisions/quickstart)
- [Decisions API 价格](https://docs.perplexity.ai/docs/getting-started/pricing#decisions-api-pricing)

### 多问题补充验收

标准 v1.3 与 Flash v1.3 各运行五组场景，共十组。每组配置三道启用题和一道停用题。检查一次上游请求完整携带三道启用题及其指令，不携带停用题。分别验证全部通过、三道题各自单独低分、漏答最后一道题。

每组只产生一条审查记录和一次调用明细。三题均使用上游返回的 600 输入 Token 计价，标准模型为 12000 纳美元，Flash 为 6000 纳美元，不额外乘问题数。全通过场景还检查问题组缓存来源与零新增费用。

测试捕获真实 HTTP 请求并通过管理员记录接口验证结果和费用，不依赖函数级模拟。为支持连续检查，测试子进程单独提高网关令牌桶容量与补充速率，生产默认值不变。
