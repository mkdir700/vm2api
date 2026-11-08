// 使用实际 Compose 文件启动控制平面；宿主与容器项目路径保持不同。
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { spawn, spawnSync, execFileSync } from 'node:child_process'
import { pickFreePort } from '../harness.mjs'

export async function prepareControlFixture({ project, repo, root, out, apiKey, originPort, apiKernel, tls = false }) {
  const control = 'hermit-managed-control'
  const port = await pickFreePort()
  const composeFile = path.join(project, 'docker-compose.yml')
  const override = path.join(project, 'compose.test.json')
  const environment = path.join(project, '.env')
  fs.copyFileSync(path.join(repo, 'docker-compose.yml'), composeFile)
  fs.mkdirSync(path.join(project, 'deploy'), { recursive: true })
  fs.copyFileSync(path.join(repo, 'deploy/init-managed-egress.sh'), path.join(project, 'deploy/init-managed-egress.sh'))
  for (const name of ['bin', 'share', 'src/config']) fs.mkdirSync(path.join(project, name), { recursive: true })
  fs.copyFileSync(path.join(project, 'config/routing.json'), path.join(project, 'src/config/routing.json'))
  const values = {
    VM2API_IMAGE: 'clearcc/hermit-control-e2e', VM2API_IMAGE_TAG: 'fixture', VM2API_CONTAINER_NAME: control,
    PORT: String(port), KIN_ADMIN_USER: 'admin', KIN_ADMIN_PASSWORD: 'testpass', VM2API_ADMIN_USER: 'admin', VM2API_ADMIN_PASSWORD: 'testpass',
    KIN_API_KEY: apiKey, VM2API_API_KEY: apiKey, KIN_DB_SECRET: '12'.repeat(32),
    KIN_KERNEL_TEST_ENDPOINTS: '1', KIN_HERMIT_API_KEY: apiKey, KIN_HERMIT_UPSTREAM_URL: tls ? 'https://api.anthropic.com' : 'http://127.0.0.1:19081/inner',
    ...(tls ? { NODE_EXTRA_CA_CERTS: '/opt/vm2api/share/hermit-e2e-ca.pem' } : {}),
    KIN_CRS_MOCK: '0', KIN_AUTO_SYNC_WRAP: '0', KIN_OS_REGISTRY: '127.0.0.1:1/hermit-fixture',
    KIN_PROXY_GEO_URL: `http://198.18.0.1:${originPort}/geo`,
    KIN_ROUTING_FILE: '/opt/vm2api/src/config/routing.json', NODE_NO_WARNINGS: '1',
  }
  fs.writeFileSync(environment, Object.entries(values).map(([key, value]) => `${key}=${value}`).join('\n')+'\n', { mode: 0o600 })
  // 套接字属于隔离 daemon。其余挂载继续使用仓库 Compose 定义。
  fs.writeFileSync(override, JSON.stringify({ services: { vm2api: { pull_policy: 'never', volumes: [`${process.env.DOCKER_HOST.slice(7)}:/var/run/docker.sock`] } } }))
  const args = ['compose', '-p', 'hermit-managed', '--env-file', environment, '-f', composeFile, '-f', override]
  const commandEnv = { PATH: process.env.PATH, HOME: process.env.HOME, DOCKER_HOST: process.env.DOCKER_HOST }
  const docker = argv => execFileSync('/usr/bin/docker', argv, { env: commandEnv, encoding: 'utf8', maxBuffer: 4 * 1024 * 1024 })
  const logs = () => { const result = spawnSync('/usr/bin/docker', ['logs', control], { env: commandEnv, encoding: 'utf8', maxBuffer: 4 * 1024 * 1024 }); return result.stdout + result.stderr }
  const config = JSON.parse(docker([...args, 'config', '--format', 'json']))
  fs.writeFileSync(path.join(out, 'compose-resolved.json'), JSON.stringify(config, null, 2)+'\n')
  if (config.services.vm2api.environment.VM2API_HOST_ROOT) throw new Error('实验不允许显式覆盖宿主路径')
  if (config.services.vm2api.volumes.find(m => m.target === '/opt/vm2api/share')?.source !== path.join(project, 'share')) throw new Error('Compose 宿主目录不匹配')
  const source = '/opt/vm2api/src/lib/vm/egress.mjs'
  function running() { try { return JSON.parse(docker(['inspect', control]))[0].State.Running } catch { return false } }
  function egress(method, id) {
    if (!running()) return method === 'stopEgressProcess' ? { ok: true } : []
    return JSON.parse(docker(['exec', control, 'node', '--input-type=module', '-e', `import {${method}} from ${JSON.stringify(source)};console.log(JSON.stringify(${method}('/opt/vm2api',${JSON.stringify(id)})))`]))
  }
  async function launch() {
    docker([...args, 'up', '-d', '--pull', 'never'])
    const start = Date.now()
    while (Date.now()-start < 30000) {
      try { if ((await fetch(`http://127.0.0.1:${port}/health`)).ok) break } catch {}
      await new Promise(resolve => setTimeout(resolve, 100))
    }
    if (!(await fetch(`http://127.0.0.1:${port}/health`)).ok) throw new Error('控制平面未就绪')
    const helperPins = {}
    for (const [name, expected] of [['kin-api-kernel', apiKernel], ['kin-egress', process.env.KIN_EGRESS_BIN], ['kin-computer', process.env.KIN_COMPUTER_BIN]]) {
      const digest = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')
      helperPins[name] = digest(path.join(project, 'bin', name))
      if (helperPins[name] !== digest(expected)) throw new Error('入口改变了固定 helper：'+name)
    }
    fs.writeFileSync(path.join(out, 'control-helper-pins.json'), JSON.stringify(helperPins, null, 2)+'\n')
    const inspected = JSON.parse(docker(['inspect', control]))[0]
    fs.writeFileSync(path.join(out, 'control-container.json'), JSON.stringify(inspected, null, 2)+'\n')
    const guest = JSON.parse(docker(['exec', control, 'node', '-e', "console.log(JSON.stringify({node:process.version,pid:process.pid,root:process.env.KIN_PROJECT_ROOT,hostRoot:process.env.VM2API_HOST_ROOT||'',cwd:process.cwd()}))"]))
    fs.writeFileSync(path.join(out, 'control-runtime.json'), JSON.stringify(guest, null, 2)+'\n')
    if (guest.root !== '/opt/vm2api' || guest.hostRoot || project === guest.root) throw new Error('内外项目目录没有分离')
    let exitCode = null, stopping = false
    const child = {
      get exitCode() { return exitCode },
      kill(signal) {
        if (stopping && signal !== 'SIGKILL') return
        stopping = true
        const command = signal === 'SIGKILL' ? ['kill', control] : [...args, 'stop', '-t', '30', 'vm2api']
        const stop = spawn('/usr/bin/docker', command, { env: commandEnv, stdio: 'ignore' })
        stop.on('close', () => { try { exitCode = JSON.parse(docker(['inspect', control]))[0].State.ExitCode } catch { exitCode = 1 } })
      },
    }
    return { baseUrl: `http://127.0.0.1:${port}`, apiKey, child, stdout: logs, stderr: () => '' }
  }
  return {
    control, launch,
    stopHelper: id => egress('stopEgressProcess', id), helperPids: id => egress('egressPidsForProxyConfig', id),
    stop() { docker([...args, 'down', '--remove-orphans']) },
  }
}
