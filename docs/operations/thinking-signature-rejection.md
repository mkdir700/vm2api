# 思考签名拒绝策略

## 行为

vm2api 在原生 Claude Messages 入口检查调用方提交的思考历史。
检查发生在内容清理、角色转换和探针响应之前。

- 缺失、未知或修改过的思考签名返回 HTTP 400，错误码为 `invalid_thinking_signature`。
- `redacted_thinking` 使用相同的来源检查。
- 已记录的思考块必须匹配当前请求选中的账号。
- 系统不将不匹配的思考块转换为文本，也不丢弃后继续生成。
- 来源记录不可用时返回 HTTP 503，错误码为 `thinking_signature_store_unavailable`。
- 上游返回签名错误后立即停止。旧的 `signature_repair` 配置不能恢复该请求。
- API 后端保留上游验签，不使用原生槽位的本地来源记录。

## 来源记录的边界

本地来源记录不是密码学验签。
系统仅接受本服务已返回、内容完整且未修改的思考块。
外部产生的有效签名也可能因没有本地来源记录而被拒绝。

新版指纹使用完整思考文本及完整签名计算 SHA-256。
原来的长度与首尾字符指纹不能证明完整内容未被修改。
新版不会将旧指纹作为放行依据。
部署前产生、仅有旧指纹记录的思考历史会被拒绝。
调用方需要新建会话，获取新版记录的思考块。
已有数据库表和旧记录不会被删除。

## 可重复验证

在支持 `node:sqlite` 的 Node 版本中执行：

```sh
KIN_THINKING_EVIDENCE_DIR=/tmp/thinking-signature-evidence \
  node --test test/e2e/thinking-signature-rejection.e2e.test.mjs
```

结果工件为指定目录下的 `receipt.json`。
用例通过真实 HTTP 入口调用本地网关，使用模拟上游。
用例检查拒绝状态、出站调用、日志分类、合法续接、完整内容指纹及旧修复开关。
用例替代旧的签名转换与签名修复单元用例。
该验证不证明正规 Claude 上游已完成验签，也不证明生产部署完成。
