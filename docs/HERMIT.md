# Hermit 集成部署

此入口适用于当前两个 fork 的源码工作区。它不依赖尚未发布的镜像标签。

## 安装

准备 Linux amd64 Docker 宿主机。安装 Docker Engine、Docker Compose 和 Python 3。将 `vm2api/` 与 `hermit/` 放在同一目录。

在两个仓库的共同父目录运行：

```sh
python3 vm2api/deploy/hermit.py
```

命令自动完成以下工作：

1. 构建当前 vm2api 控制面。
2. 构建 Hermit，并下载、校验固定版本的官方 Claude Code。
3. 合并集成镜像，移除旧内核的 glibc shim。
4. 生成随机密码、API 密钥和数据库密钥。
5. 生成 Compose 文件，并使用构建出的镜像 ID。
6. 启动控制面，核对该部署实例的健康响应。

默认部署目录为共同父目录下的 `.deploy/vm2api-hermit`。控制台使用端口 `8787`。
命令只输出私有配置文件路径。管理员用户名、密码和密钥保存在部署目录的 `.env`，文件权限为 `0600`。

打开服务器该端口的 `/console/`。登录后，在控制台完成账号配置、出口绑定和槽位创建。Hermit 由槽位启动流程自动运行。用户不必复制二进制，也不必在 guest 内手工安装 systemd 服务。

真正的 KVM 槽位仍要求宿主机提供可用的 `/dev/kvm`。控制面启动成功不代表该设备可用。

## 指定目录或端口

```sh
python3 vm2api/deploy/hermit.py --directory /opt/clearcc --port 8787
```

Hermit 仓库不在相邻目录时，增加 `--hermit-source /ABSOLUTE/PATH/hermit`。

## 更新

更新源码后，重新运行同一条命令，并使用原部署目录。

命令保留 `.env` 中的凭据、`vms/`、`data/` 和运行配置。构建失败时，命令不启动新镜像。

集成镜像阻止控制台的上游一键升级。上游镜像不包含本 fork 的 Hermit。当前版本应通过本部署入口更新。

此入口不自动接管已有上游实例。非空目录没有本入口的安装标记时，命令拒绝覆盖。宿主机已有其他 vm2api 控制面时，启动也会拒绝，以避免槽位名称冲突。

## 仅构建

```sh
python3 vm2api/deploy/hermit.py --directory /NEW/DIRECTORY --build-only
```

此模式构建镜像并生成部署文件，不启动控制面。`deployment.json` 记录镜像 ID、源码摘要和构建状态。该文件不包含凭据。

## 查看与停止

进入部署目录后执行：

```sh
docker compose --env-file .env -f compose.yaml logs -f vm2api
docker compose --env-file .env -f compose.yaml stop
```

命令生成的容器名称与部署目录绑定。不要删除 `vms/` 或 `data/` 来重试安装。

## 出口与验收边界

集成镜像沿用 vm2api 的出口管理。为槽位绑定 SOCKS5 后，QEMU runner 加入该出口的透明转发网络。Hermit、官方 CLI 与 helper 的上游流量使用同一槽位出口。

镜像构建和控制面启动验收不证明 KVM、9p、真实账号或代理断开后的行为。这些检查仍需在实际槽位上执行。

部署端到端程序为 `test/e2e/hermit-deploy.py`。它检查真实构建、入口分发、私有配置保留、镜像摘要、控制台文件、升级保护和容器清理。验收使用独立容器，不发布端口，不挂载生产账号或 Docker socket。

本轮验收结果见[集成部署验收工件](../../hermit/docs/evidence/vm2api-integrated-deploy-2026-11-05.json)。
