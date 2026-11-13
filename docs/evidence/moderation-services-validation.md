# 审查服务验收回执

## 源码范围

- 仓库：`/Users/mark/.herdr-projects/clearcc/vm2api`。
- 分支：`main`。
- 原始提交：`88df510e660cc8447218476eb00c972b6a49c5ba`。
- 本回执记录本地实现与验收结果，未部署。
- 原有工作流、package.json 和 Hermit 预热测试改动未纳入本次范围。

## 已完成

- 设置 → 审查服务：支持 Jev、Perplexity、Laya 和 ModernBERT。每个服务保留独立配置。
- 独立审查记录页面：支持服务、模型、结果筛选，游标分页，按模型汇总，审查详情与上游调用明细。
- 审查记录保存模型、配置版本、阈值、结果、缓存来源和费用。调用明细保存用量和当时单价。
- 缓存命中新增费用为零。未知费用不显示为免费。
- Perplexity 默认明确版本，默认超时 30 秒，不启用联网检索。

## 验证结果

- Node：`v22.23.4`。
- 本功能 HTTP 端到端验收通过。
- 本功能、API 通道和面板用户权限端到端测试合计 11 项通过。
- TypeScript、Vite 生产构建、修改范围 ESLint、Prettier、Biome 和 `git diff --check` 通过。
- 端到端工件：[moderation-services-e2e.json](./moderation-services-e2e.json)。工件包含检查项和源码 SHA-256，可用相同命令重建。

扩展回归运行了 39 项，29 项通过，10 项失败。失败项为：

- `messages.e2e.test.mjs`：8 项。缺少 Rust 内核，返回 503，并导致后续模拟调用追踪断言失败。
- `panel-api.e2e.test.mjs` 中两个 `OpenAI scheduling HTTP` 场景：缺少 `kin-computer`，返回 `computer_service_missing`。

已通过 `git archive HEAD` 创建独立原始提交目录，并在相同 Node 和依赖下复现以上全部 10 项失败。未修改这些测试或相关实现。复现后删除本次创建的独立目录。

复现本功能验收：

```sh
MODERATION_E2E_ARTIFACT=docs/evidence/moderation-services-e2e.json /Users/mark/.nvm/versions/node/v22.23.4/bin/node --test test/e2e/moderation-services.e2e.test.mjs
```

## 未执行

- 真实 Perplexity 付费调用。
- 浏览器视觉与交互验收。
- 生产部署。

## 手工检查

1. 打开 `/console#/settings/moderation`。
2. 选择 Perplexity，保存密钥和模型。切回 Jev，确认原配置恢复。
3. 打开 `/console#/moderation-reviews`，按服务、模型和结果筛选。
4. 查看审查详情，确认模型、单价、用量和缓存来源。

## 多问题补充验收

- 标准 v1.3 与 Flash v1.3 共十组多问题场景通过。
- 每次 HTTP 请求携带三道启用题，排除一道停用题。题目指令完整保留。
- 验证全部通过、每道题分别命中、漏答一道题按不可用策略拦截。
- 三题只记录一次调用，按返回的 600 输入 Token 计价。标准模型为 0.000012 USD，Flash 为 0.000006 USD。
- 相同问题组命中缓存，不新增调用费用，并关联原审查。
- 工件新增 `multi_question_cases`，逐组保存模型、问题数量、结果、调用次数、输入用量与费用。
- 本次仅修改端到端测试和验收文档，未修改业务代码。
