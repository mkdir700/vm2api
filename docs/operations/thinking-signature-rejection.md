# 思考块转发与上游验签

## 行为

vm2api 在原生 Claude Messages 入口检查思考块的协议结构。
本地不具备独立验证不透明签名的能力，不用来源记录代替上游验签。

- 思考块只能出现在 assistant 消息中。
- thinking 块必须有字符串 thinking 和非空字符串 signature；thinking 允许为空。
- redacted_thinking 块必须有非空字符串 data。
- 字段缺失或类型错误返回 HTTP 400，错误码为 invalid_field，param 指向具体字段。
- 不按签名长度、固定前缀、来源指纹或账号归属判断签名有效性。
- 未知来源、旧版记录、账号不同或来源数据库故障均不阻断请求。
- 进入出站处理后原样保留思考块及顺序，不补造签名，不降级为文本。
- 上游签名错误直接返回，不自动修复、重试或切换账号。
- 旧 routing.failover.signature_repair 不再影响思考块保留或触发签名修复。
- API 后端继续由上游校验，不使用原生槽位的本地来源记录。

本地仍尽力记录响应中思考块的来源，用于诊断。
已有数据库表和旧记录不删除，不需要数据迁移。
同一思考块在不同模型、账号或对话上下文中是否可用，由上游决定。
本修改不保证每个来源未知的思考块都能通过上游校验。

## 可重复验证

使用支持 node:sqlite 的 Node 版本，在仓库根目录执行：

```sh
KIN_THINKING_EVIDENCE_DIR=/tmp/thinking-signature-evidence \
  node --test test/e2e/thinking-signature-rejection.e2e.test.mjs
```

结果工件为指定目录下的 receipt.json。
用例启动真实 HTTP 网关，使用模拟上游。
验收覆盖未知来源、空思考文本、不透明短签名、加密思考、已有记录、修改过的内容、
账号不同、旧版记录、数据库故障、格式错误与上游签名错误。
用例比较完整出站思考块，并检查上游调用次数。
收据仅保留状态、次数及合成思考块指纹，不保存真实对话或完整签名。
该验收不证明真实 Anthropic 或 Hermit 已完成验签，也不代表生产部署完成。
