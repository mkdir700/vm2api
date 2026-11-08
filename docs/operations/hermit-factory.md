# Hermit 标准槽位创建与透明出口

## 行为

Hermit 激活继续使用 `POST /api/panel/dataplane`。请求应指定槽位、包版本和 `restart: true`。生产激活限制保持不变。

接口先验证包和目标环境，再检查现有容器。只有 Docker 明确返回容器不存在时，接口才调用标准 `startSlotReady` 创建容器。Docker 不可用、依赖错误和已有容器不匹配，不触发自动创建或替换。

创建流程复用现有槽位目录、计算机服务、出口网络、镜像选择和运行参数。它不创建第二套槽位管理器。Hermit 容器使用标准出口网络、`sleep infinity`、`--init` 和只读版本目录。

接口从代理池读取完整出口绑定。它不使用展示字段代替认证凭据。缺少绑定时返回错误。已有受管出口仍应通过现有就绪检查。

所有目标槽位启动成功后，接口才发布 Hermit 版本绑定、运行状态和运行元数据。如果启动失败，接口停止本次启动的内核，并停止本次创建的容器。停止不会删除槽位目录。跨文件策略写入仍不保证文件系统故障下的整体回滚。

当前流程不自动将已有 wrap/crag 容器替换为 Hermit 容器。已有容器未满足 Hermit 条件时，接口返回错误。

## 实验隔离

`test/e2e/hermit-factory.py` 在 primaryserver 创建独立 Docker-in-Docker daemon。外层容器使用 `--network none`。内层网络、镜像标签、槽位容器和 iptables 都属于该实验。

控制平面运行实际源码。它通过内层 Docker socket 调用标准创建路径。实验不使用 Docker 执行替身。现有宿主容器和宿主出口规则不参与实验。

实验导入固定槽位镜像。Docker 29 的镜像引用摘要与 Docker 27 的配置摘要可能不同。驱动从导出清单读取配置，并校验配置摘要和全部根文件系统层。校验成功后，驱动才创建私有测试标签。标准镜像拉取指向隔离环境中没有监听器的回环端口，因此使用已校验的本地镜像。

## 出口验证

实验使用真实 `kin-egress` 和 sing-box。SOCKS5 监听器要求用户名与密码。sing-box 将模拟服务连接绑定到 `127.0.0.2`。模拟上游据此确认流量经过了出口。

Hermit 的实验上游仍限制为回环地址。测试容器内的 Python 转发器把该地址转发到隔离的测试目标。流量随后经过标准透明出口。这个转发器只属于测试，不属于生产启动配置。

代理探测的目标地址在隔离网络中由本地监听器接管。实验不证明公网可达。外部地址连接应被拒绝。

此实验先覆盖标准 SOCKS5 出口。它不证明受管 Hysteria 2 的导入、应用和就绪控制路径已经与 Hermit 联合验收。

## 依赖与复现

使用固定的 Node 22.23.4、Hermit 精简包、官方 Claude Code、API kernel、sing-box 和 `kin-computer`。`kin-computer` 的大小与摘要应匹配 `deploy/payload.json`。从当前 worker 源码交叉编译 Linux `kin-egress`。本阶段没有修改 Go 源码。

```sh
python3 test/e2e/hermit-factory.py \
  --out /tmp/fresh-factory-run \
  --node /path/to/node-22.23.4 \
  --archive /path/to/hermit.tar.gz \
  --receipt /path/to/release.json \
  --cli-source /path/to/official-claude \
  --api-kernel /path/to/api-kernel \
  --egress /path/to/kin-egress \
  --sing-box /path/to/sing-box \
  --computer /path/to/kin-computer \
  --image sha256:FULL_SLOT_IMAGE_ID \
  --dind-image sha256:FULL_DIND_IMAGE_ID
```

驱动需要 Linux root、Docker 和网络命名空间权限。每次使用新的输出目录。驱动记录源码摘要、可执行文件摘要、镜像身份、请求、工具结果和清理状态。保留 `factory-receipt.json`、`summary.json` 和源码快照。

## 后续范围

真实 OAuth、helper、真实上游、受管 Hysteria 2 联合验收、已有槽位内核切换、执行中工具恢复和故障回滚仍需独立验收。完成隔离实验不等于可以上线生产。
