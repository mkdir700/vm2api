# Hermit 内核接入验收：2026-11-08

## 身份与边界

vm2api 基线为 `63ae218c1207d4f050e74f61caefc3d52dedc77e`。验收对象包含未提交变更。Linux 验收主机为 `primaryserver`。验收期间没有部署生产服务，没有调用真实订阅，没有更改现有账号。

新增测试均为端到端实验。现有单元测试没有修改。编码前的失败方式记录在 `.planning/2026-11-08-hermit-kernel/task_plan.md`。

## 结果

| 检查 | 结果 | 证据 |
| --- | --- | --- |
| 精简包离线构建与验证 | PASS，35 项 | Hermit 的 `experiment/evidence/vm2api-thin-package-20261108/final-build/` |
| 控制平面 HTTP 安装与选择 | PASS，41 项 | `.tmp/hermit-integration-20261108/http-summary.json` |
| Linux 真实内外 CLI 流程 | PASS，19 项 | `.tmp/hermit-integration-20261108/runtime-summary.json` |
| Linux 外网隔离 | PASS | `runtime-isolation.json` |
| Linux 源码固定与退出清理 | PASS | `runtime-receipt.json` |
| 槽位摘要修复后的既有回归 | PASS，31 项 | `projection-regression.log` |
| 既有全量回归 | 312/327 文件通过；15 文件失败与干净基线一致 | `full-regression-summary.json`、`baseline-comparison.json` |
| 前端 TypeScript 编译 | PASS | `tsc -b web`，Node 22.23.4 |
| 页面交互 | NOT RUN | 没有浏览器验收 |
| 真实 Docker、KVM、远端槽位 | NOT RUN | Docker 执行边界使用测试适配器 |
| 真实上游、OAuth、helper | NOT RUN | 使用模拟上游与合成凭据 |

实际 Linux 流程验证了 HTTP 上传、共享 CLI 缓存命中和槽位启动。
它验证了重复并发选择和单会话容量。
它还验证了外部 Read、外部 MCP、工具结果续接、后续输入和父进程退出清理。请求经过完整 vm2api 服务及真实 API kernel。真实内外 Claude Code 均为固定的 2.1.318。

测试曾发现槽位摘要丢失 `dataplane`。该缺陷导致页面将已选择的 Hermit 显示为 wrap，并继承 wrap 的会话容量。修复保留内核选择及版本绑定。最终实验确认容量为 1。

## 工件身份

精简归档为 30,666,087 字节。旧归档为 199,331,262 字节。Claude Code 改由共享缓存提供。

```text
archive sha256:
beb9ee92b8193cf9d6ba087602e7da2ef4f9fe30d1429b69ce3a397858ae623d
manifest sha256:
cc6b4670d61ce8cf54e0c37108ee21c5ee1f5ee6256ad5641e0d44a2e17e05c9
Claude Code sha256:
708c77b204db30086ff6f1ed34577bda03e1be74ced80557cbf7b54249ebf0bd
API kernel sha256:
5bfc33cac3f68b425648675e31880d7e6a1a69e622fce3de385f8f87f8c19223
```

本地证据压缩包为 `.tmp/hermit-integration-20261108/primaryserver-runtime.tar.gz`。压缩包包含源码快照、逐文件摘要、请求记录、工具结果、隔离记录和清理收据。工件使用合成凭据。现有账号凭据未进入工件。

primaryserver 原始证据目录为 `/tmp/hermit-native-linux.GgJ0o4/vm2api-runtime-final-2`。这不是部署目录。

## 后续验收

参见 [接入说明](hermit-kernel.md)。生产激活仍默认拒绝。完成真实容器、认证、真实上游和故障恢复验收后，才能单独评估生产激活。
