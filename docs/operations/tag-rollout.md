# tag 发布操作说明

状态：代码与隔离验收阶段。生产未启用。发布默认关闭。首版使用单台 Linux 宿主机、Docker Compose、OpenResty 与本地 SQLite WAL。不引入 Kubernetes。

## 组件与限制

网关运行 `node src/session-gateway.mjs`。业务组运行既有 vm2api 服务。两个网关共享同机权威库。两个业务组独立持有账号、槽位和可变目录。每次发布使用镜像 digest 与固定 Hermit 包，禁止使用 latest。

新网关仅接入 `POST /v1/messages`、`POST /v1/messages/count_tokens` 和 `GET /v1/models`。其他业务协议明确拒绝。现有非部署组运行模式不启用这个限制。首版发布器只安装本机 Docker Claude 槽位。远端槽位、KVM 与 Codex 不在首版范围内。

没有稳定会话身份的调用按内部 API Key 保守绑定。此类绑定会阻止自动退役。完整历史恢复要求客户端发送完整的 Anthropic 历史。不能将原生进程内状态当作可迁移状态。未知执行状态保留准入，不自动重放，不按 TTL 清空。运维需要核对持久回执。

## 初次接入

警告：初次拆分权威身份库需要停止原控制面的写入。必须另行安排切换窗口。此操作不属于日常 tag 发布，也没有在本轮执行。

1. 先将三个仓库的配套变更合并到默认分支。发布包含部署组证明的 Hermit 固定包。保存镜像 digest、源码 SHA 和包清单摘要。
2. 准备两个独立账号组。准备两个独立业务目录。两个组不得共享账号刷新所有权、socket 或 VM 目录。预先创建两个组的 Docker 槽位及网络。不得复制活动账号目录。
3. 安装本目录 `deploy` 工件到 `/opt/truerouter-rollout/vm2api`。安装 Node 22.23.4 或兼容版本、Python 3、Docker Compose。发布器以 root 运行。固定执行器目录不得由发布通知修改。
4. 复制 `deploy/examples/agent.example.json` 和 `publisher.example.json` 到 `/etc/truerouter-rollout`。替换全部 `REPLACE_` 字段。填入实际仓库、镜像前缀、容器、挂载路径和账号 UUID。业务组 `resources.containers` 的第一项必须是控制面，后续项必须列出该组的全部槽位容器。发布器按该清单核对身份并停止旧版本。将配置及 env 文件设为 0600。将父目录设为 0700。
5. 生成两个不同的随机令牌。每个令牌至少 32 字节。`control-token` 用于网关、业务组和应用排空。`notification-token` 用于 CI 通知。不要将令牌写入仓库、命令行参数或验收工件。
6. 先运行 `node deploy/rollout-authority.mjs --source /实际目录/data/kin.db --target /opt/truerouter/authority` 查看计划。安排窗口后停止原控制面。使用相同参数加 `--apply --stopped-container 实际容器 --receipt /私有路径/import.json` 执行。工具核对停止状态与挂载。只导入用户、组、池和 API Key 元数据，不复制供应商凭据或设置。目标目录必须不存在。
7. 按 `rollout-gateway-compose.yml` 启动初始网关。两个版本从初次启动起均使用 `KIN_ROLLOUT_REUSE_PORT=1`。公网业务端口共用 8790。管理端口分别为 8792、8793。管理端口只监听回环地址。`gateway.env` 保持既有内部主密钥。SQLite 目录必须是本地文件系统。
8. 按 `rollout-compose.yml` 启动初始业务组。注册真实组身份与资源。读取 `/_rollout/snapshot`。使用返回的策略代次调用 `/_rollout/policy`。接口要求 Bearer 控制令牌。业务组声明的账号必须与实际槽位账号一致。保留业务组 Compose 的 host PID 命名空间，避免持久 PID 所有权文件在容器重启后误认同号进程。初始化不是自动猜测过程。网关的受保护 API Key 接口目前提供创建与列表；业务组拒绝身份写入。初次启用前必须核对现有身份管理流程与此限制。
9. 部署启用了排空接口的初始 sub2api。应用 env 保持既有 PostgreSQL、Redis 与加密配置。两个应用共用数据库，应用可变目录独立。原镜像缺少排空证明时不能直接执行自动退役。
10. 按 `openresty.conf.example` 一次性修改现有入口。将专用 upstream 文件同时挂载到宿主机与 OpenResty。发布器配置必须指向同一个文件。首次加载前执行 `nginx -t`。日常 sub2api 发布只替换该文件并平滑 reload。
11. 核对 `initial_components` 与初始网关、应用、业务组的实例、digest 和版本。`gateway_active` 与 `application_active` 必须指向实际活动实例。备用配置不能指向活动组资源。
12. 安装 `deploy/systemd` 中的 receiver、worker 和 timer。核对固定路径后再启用。receiver 仅监听 127.0.0.1:8791。worker 每次取持久队列，所有仓库共用 `production.lock`。不得删锁文件、任务文件或未知请求记录来强行推进。

## GitHub 配置

三个仓库均设置受保护的 `production` environment。添加变量 `ROLLOUT_ENDPOINT=https://实际域名/internal/rollout/events`。添加 secret `ROLLOUT_NOTIFICATION_SECRET`，其值必须与通知令牌相同。先保持 `ROLLOUT_ENABLED` 未设置。完成初次接入和真实备用容量验收后再设为 `true`。

工作流等待现有发布工作流成功。只接受同仓库 push 产生的稳定 `vX.Y.Z` tag。工作流验证确切工件，生成摘要，再发送 HMAC 通知。接收器校验来源、固定摘要和 tag 身份。相同 tag 不允许换 commit。生产端固定 Compose 模板决定动作，通知不能提供 shell。

sub2api 额外要求运维预先审查完整 SQL 迁移集合，并在服务器配置中填写 `approved_migrations_sha256`。迁移摘要变化时自动拒绝。需要确认新旧版本可同时访问共享库。破坏性迁移不得自动蓝绿发布。

## 日常流程与恢复

发布器持久化候选与容器身份，拉取固定工件，检查就绪，再修改新会话策略。旧会话继续访问原组。后端请求、工具、helper、恢复任务、归属与准入全部满足证明后，才允许退役并停止旧组。sub2api 必须同时满足 HTTP 为零与异步计费队列为零。

vm2api tag 同时升级网关。Linux 使用同端口 SO_REUSEPORT。候选网关与旧网关共享准入事务。旧网关停止接收新连接，保留既有上传与输出，排空后退出。每个网关使用独立管理端口和实例身份。

排空超时返回 2，任务进入 waiting，保留旧实例。worker 后续继续同一任务。失败任务保留证据并需要人工核对。CI 先记录 SUBMITTED，再查询服务器；只有 completed 才记录 DEPLOYED。查询超时不能证明发布失败，也不能证明发布完成。不要重新打同名 tag。

使用 `python3 deploy/rollout.py status --config /该任务/publisher.json --release /该任务/release.json` 查询。需要回滚时，将 `status` 改为 `rollback`。必须使用队列中冻结的配置与清单。回滚只改变新会话策略。已绑定会话继续原组。回滚同样需要排空证明，不能强制停止正在执行的实例。

状态文件包括 queue、task.json、active-components.json、gateway-active.json 和 application-active.json。备份时保留其一致性。不要把回滚当作数据库回滚。

## 隔离复现

使用 Node 22.23.4，在仓库根目录运行：

```sh
node --test test/e2e/session-rollout.e2e.test.mjs test/e2e/rollout-group.e2e.test.mjs test/e2e/rollout-publisher.e2e.test.mjs test/e2e/rollout-application.e2e.test.mjs test/e2e/rollout-agent.e2e.test.mjs test/e2e/rollout-gateway-handoff.e2e.test.mjs test/e2e/rollout-notification.e2e.test.mjs test/e2e/rollout-authority.e2e.test.mjs test/e2e/rollout-package.e2e.test.mjs
```

使用各测试中的 `ROLLOUT_*_OUT` 指定工件目录。macOS 的双网关验收使用不同端口。Linux 使用同端口 SO_REUSEPORT。发布器验收中的 Docker 操作为夹具，不能证明真实 Compose 或 OpenResty 已验收。真实原生链路使用 `test/e2e/rollout-native.py --help` 的参数，连接本机受控上游，不调用真实账号。

验收工件只保存安全元数据。不要保存真实提示词、账号文件或令牌。托管 CI、真实 Linux 宿主机交接和生产首轮发布需要分别验收。
