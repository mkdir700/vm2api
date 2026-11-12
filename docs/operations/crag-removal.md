# Crag 移除契约

## 范围

仅维护默认内核和 Hermit。默认内核保留 `wrap` 与 `cc` 的 CLI 兼容路径。
删除 Crag legacy、Crag v2、授权、包下载、物化、沙箱和控制台入口。
保留历史记录。保留旧数据目录的忽略规则。不得自动删除用户数据。

## 失败清单

- 旧 Crag 选择被静默当作默认内核。
- 槽位继承全局 Crag 选择后仍进入调度。
- 旧别名或 VM 导入包重新引入 Crag。
- 移除授权检查时破坏共享请求、取消或凭据刷新。
- 默认内核下载因发行源不含 Crag 附件而失败。
- Docker 构建、升级或回滚继续要求 Crag 文件。
- Hermit 切换失败后丢失原绑定、凭据或工作数据。
- 未完成的旧切换事务回滚到已移除内核。

## 行为

保留并显示未知内核标识。拒绝其启动、推理和新配置写入。
旧配置不自动切换。管理员必须明确安装默认内核或 Hermit。
成功安装后移除旧版本字段。旧授权和包不再使用，但不自动删除。
旧 Crag HTTP 路由不再提供。API 不返回授权信息。
保持现有 Hermit 放置限制、切换事务和未知结果不重放语义。

## 验收

使用隔离 HTTP 端到端验证内核清单、旧选择拒绝、旧字段拒绝和有效请求。
复用 Hermit 包上传、安装、失败处理、会话和协议端到端用例。
保存源码标识、命令、检查清单与结果。区分模拟和真实运行验收。

## 本次验证记录

基线为 `df92813f035d77f94a3fa9f28a9165c560b4bbc9`。
使用 Node `22.23.4`。
本次未提交代码，未部署。

- macOS 专项端到端：14 项中通过 11 项，3 项因 Linux 条件跳过。
- 隔离 Linux 容器：6 项全部通过，包含上述 3 项 Linux 专用用例。
- 两个环境合计覆盖 14 项不同的专项用例，全部通过。
- Linux 容器禁止外部网络，不挂载 Docker socket。
- Linux 用例验证真实控制面和包存储；槽位 Docker 驱动与内核响应使用模拟实现。
- 前端生产构建通过。
- JavaScript 语法、Python 语法、入口 shell 语法和工作流 YAML 语法检查通过。
- 扩展协议回归：原始 HEAD 独立归档和当前工作树均为 30 项中通过 20 项、失败 10 项。失败项名称一致。
- 未执行浏览器界面验收、真实槽位 Docker/KVM 验收或真实账号验收。

固定 Linux 验收镜像为：

```text
sha256:b93f88524f815539e4ca5e8155c7ae2e0cc58d7c46b26ce0bf37413842589cf3
```

在仓库根目录执行新增端到端用例：

```sh
KERNEL_RETIREMENT_E2E_OUT=.tmp/kernel-retirement \
  node --test test/e2e/kernel-retirement.e2e.test.mjs
```

该用例使用隔离临时配置与本机模拟发行源。
它不访问生产服务或 GitHub。
它验证旧内核选择、历史别名、旧字段、导入包、全局继承、诊断 pin 和无 Crag 附件的默认内核下载。

完整验收记录位于 `.tmp/crag-removal-verification/`。
其中 `summary.json` 为总结果，`source-manifest.json` 固定工作树文件摘要。
`protocol-comparison.json` 和两份 TAP 日志保存原始基线对照。
`linux/reproduce-linux.py` 可重新执行隔离 Linux 验收。
使用复现脚本前，确认本机已有上述固定镜像。

旧 Crag 授权目录、包目录和历史验收文档保持原样。
忽略规则继续隔离旧数据，避免旧二进制进入 Git 或 Docker 构建上下文。
