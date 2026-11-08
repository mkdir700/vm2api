# 离线升级验收记录

## 范围

本轮完成无项目 Release 的第一条离线升级路径。
本机打包和上传，独立执行器完成服务器上的升级任务。
面板读取同一份任务状态。
本轮没有替换 primaryserver 线上服务，也没有激活生产 Hermit 槽位。

测试基于完整控制平面镜像 `sha256:955a027a0cc718875299fe63ecd53d475b1f4000b4d540b5c7579446ee6a0e30`。
测试派生镜像加入当前入口、面板路由、前端资源和 Compose 插件。
测试使用合成账号和独立 Docker daemon。
测试没有调用真实模型或真实 OAuth。

## 结果

| 检查 | 结果 |
| --- | --- |
| 实际镜像、Compose、离线归档导入、升级和回滚 | PASS，20 项检查 |
| 真实 SSH/SCP、跨发布对象复用和重复暂存 | PASS，4 项检查 |
| 新前端类型检查和构建 | PASS |
| 代码与验收源码快照一致 | PASS |
| 实际前端资源与本机构建摘要一致 | PASS |
| 测试 daemon、临时目录、网络命名空间和进程清理 | PASS |
| primaryserver 线上容器和健康状态保持 | PASS |
| 新流程在生产安装上实际切换 | NOT RUN |
| 浏览器点击验收、真实账号推理、长请求排空实验 | NOT RUN |
| ARM64、KVM、集群、数据库迁移和协调升级 | NOT RUN；首版拒绝不支持的安装或变更 |

20 项检查覆盖以下行为：

- 删除目标镜像后，从离线发布包重新导入。
- 损坏对象在停止原服务前被拒绝。
- 完整升级通过，实际镜像与清单一致。
- 面板 API 读取同一任务。
- 离线安装拒绝本版本的旧面板和旧脚本 Release 升级入口。
- Hermit 安装后保持未激活。
- 原人工暂停保持不变。
- 同一目标重复执行不重建容器。
- 独立任务提交、未完成任务互斥和执行器中断恢复。
- 切换后的页面故障触发回滚，并恢复原镜像和健康状态。
- 停机备份摘要匹配，备份数据库通过一致性检查。
- 非空合成凭据在升级及回滚后保持原字节内容。
- 独立容器保持原身份。

## 修正记录

最初几轮测试修正了测试 daemon 启动、Docker 镜像身份和测试 socket 挂载。
随后业务测试发现完整控制面镜像缺少 Compose 插件。
Dockerfile 现从同一 Docker CLI 阶段复制 Compose 插件。
最终使用的插件摘要为 `6395dbb256db6ea28d5c6695bc9bc33866c07ad1c93792f8d85857f1c21c34ee`。

补强备份检查时，中断了一轮存在待修正断言的实验。
修正测试返回值的换行处理后，完整 20 项实验通过。
失败和中断收据均保留，没有改写为成功。

macOS 上传前端 tar 时生成了 296 个 `._` 元数据文件。
这些文件不属于页面资源。
归档校验分别记录这些文件，并逐一核对其余实际资源。
实际资源的名称和摘要与本机构建一致。
正式构建从 Git 归档生成，不使用该测试前端 tar。

## 工件和复现

本地证据目录：

```text
.tmp/offline-upgrade-20261108/
  acceptance-complete.tar.gz
  complete-verified/receipt.json
  complete-verified/backup-verification.json
  complete-verified/tasks/
  complete-verified/sources/
  verified-complete-summary.json
  reproduction.json
  transfer-final/receipt.json
  production-unchanged.json
```

`acceptance-complete.tar.gz` 的 SHA-256：

```text
1d09ac44cdfccc893e2e7c1108fba8ccca54607817c0aad2cd0eae6641d7791b
```

`reproduction.json` 保存镜像、CLI、Compose、前端输入和复现参数。
复现时指定新的输出目录。
源码快照保存实际执行的升级代码和测试驱动。
前端额外源码保存在 `source-extra/`。

升级实验驱动为 `test/e2e/offline-upgrade.py`。
传输实验驱动为 `test/e2e/offline-transfer.py`。
后者只在目标主机的本次 `/tmp` 目录暂存工件，不切换服务。

本轮不包含最终业务发布包，也不代表新流程已经在生产切换。
后续先提交代码并构建固定发布，再按操作文档完成发布验收和正式升级。
