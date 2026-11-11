# 独立凭据刷新上线回执

状态：通过。已部署到 `primaryserver` 的 `vm-01`。

- vm2api 代码修复：`8ad4afb0e4d69d3ed3feeaf80234445418273651`。
- 最终源码提交：`3c303473a0bca26246903f4e2b661e78a448aeb1`。该提交补全隔离 HTTP 夹具。产品运行时层保持相同。
- 控制镜像：`sha256:d35a5169ea2a98faa505c48485a3504e9e7b12ea871265ef2704b81b9999ddc9`。
- Hermit 源码：`4d1f1eae286bab057f78464e94fb3699d1bf019c`。
- 内核版本：`0.0.0-production.credential-isolation-4d1f1ea`。
- 内核二进制 SHA-256：`49d8e5e15c5f1d72cd32ca974ffb87df36f5baa3303356a8af98c757de077567`。
- 离线升级任务：`3da8600ce28e4ec0afc26d3ae68ce515`，`PASS / active`。
- 内核切换：`kernel-102171a0-4506-4dc7-a227-fce38d57fc1d`，`finalized`。

正式工件的七组验收全部通过。十个回执场景共 325 项检查。完整链路的五个 HTTP 子测试全部通过。已核对镜像内 379 个源码文件，实际运行二进制与正式包哈希一致。

旧池的 5 条等待标记来自已经终止的会话。维护前确认 92 个会话的进程组全部退出后，通过现有恢复入口重建失效运行时。会话文件和凭据保留。准备阶段刷新过期访问令牌后，重新取基线再切换。

生产管理 OAuth 刷新已成功。刷新前后内核 PID 相同。当前内核健康，独立刷新能力为 true，20 个可用会话槽，待回传结果为 0。数据库检查正常。

手动调度设置保持不变。凭据恢复后，`vm-01` 自动恢复可调度。本任务没有遗留维护暂停。镜像和包切换期间的凭据、路由、槽位字段及其他容器均与阶段新基线一致。准备期间另有 `truerouter-app-1` 身份漂移，已单独记录。

生产模型推理和实际回滚未运行。原有未提交修改保留。本次没有推送 Git 分支。

[机器回执](independent-credential-refresh-deployment-20261111.json)。正式工件和私有阶段基线保留在 `/opt/vm2api-releases/credential-isolation-4d1f1ea-8ad4afb`。
