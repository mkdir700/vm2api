// 实际 Hysteria 2 服务及受管 Docker 身份。仅用于隔离端到端实验。
import fs from 'node:fs'
import path from 'node:path'
import dgram from 'node:dgram'
import { execFileSync, spawn } from 'node:child_process'
import { once } from 'node:events'
import { managedEgressConfig } from '../../src/lib/vm/managed-egress-config.mjs'
import { MANAGED_EGRESS_IMAGE } from '../../src/lib/vm/managed-egress-docker.mjs'

export async function prepareManagedFixture({ root, project, out, processes, controlMode = false }) {
  const socket = dgram.createSocket('udp4')
  socket.bind(0, '127.0.0.1'); await once(socket, 'listening')
  const port = socket.address().port
  await new Promise(resolve => socket.close(resolve))
  const certificate = path.join(root, 'h2-cert.pem'), key = path.join(root, 'h2-key.pem')
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', key, '-out', certificate, '-days', '1', '-subj', '/CN=localhost'], { stdio: 'ignore' })
  const password = 'isolated-hysteria-password'
  const file = path.join(root, 'h2-server.json')
  fs.writeFileSync(file, JSON.stringify({
    log: { level: 'debug' },
    inbounds: [{ type: 'hysteria2', listen: '127.0.0.1', listen_port: port, users: [{ password }], tls: { enabled: true, certificate_path: certificate, key_path: key } }],
    outbounds: [{ type: 'direct', inet4_bind_address: '127.0.0.2' }],
  }), { mode: 0o600 })
  const fd = fs.openSync(path.join(out, 'h2-server.log'), 'w')
  const server = spawn(process.env.HERMIT_E2E_SING_BOX, ['run', '-c', file], { stdio: ['ignore', fd, fd] })
  fs.closeSync(fd); processes.push(server)
  await new Promise(resolve => setTimeout(resolve, 300))
  if (server.exitCode !== null) throw new Error('Hysteria 2 服务启动失败')
  const configDir = path.join(project, 'data/managed-egress')
  fs.mkdirSync(configDir, { recursive: true, mode: 0o700 })
  fs.writeFileSync(path.join(configDir, 'config.json'), JSON.stringify(managedEgressConfig([])), { mode: 0o600 })
  const control = 'hermit-managed-control', service = 'hermit-managed-service'
  const docker = args => execFileSync('/usr/bin/docker', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
  if (!controlMode) docker(['create', '--name', control, '--label', 'com.docker.compose.project=hermit-managed', '--network', 'host', '--volume', `${project}:${project}:rw`, MANAGED_EGRESS_IMAGE, 'check', '-c', path.join(configDir, 'config.json')])
  function createService(readOnly) {
    docker(['run', '-d', '--name', service, '--label', 'com.docker.compose.project=hermit-managed', '--label', 'com.docker.compose.service=sing-box', '--network', 'host', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges', '--read-only', '--volume', `${configDir}:/var/lib/vm2api-egress:${readOnly ? 'ro' : 'rw'}`, MANAGED_EGRESS_IMAGE, 'run', '-c', '/var/lib/vm2api-egress/config.json'])
  }
  if (!controlMode) createService(false)
  return {
    control,
    importBody: { protocol: 'hysteria2', config: { server: '127.0.0.1', server_port: port, password, insecure: true } },
    repairMount() { docker(['rm', '-f', service]); createService(true) },
    credentials() { return JSON.parse(fs.readFileSync(path.join(configDir, 'config.json'))).inbounds[0] },
    stop() { if (!controlMode) docker(['rm', '-f', service, control]) },
  }
}
