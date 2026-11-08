// 隔离 TLS 上游。仅在无外网的 factory 命名空间内使用。
import fs from 'node:fs'
import path from 'node:path'
import https from 'node:https'
import { execFileSync } from 'node:child_process'
import { once } from 'node:events'

export async function prepareHTTPSFixture({ root, project, out, handler }) {
  const ca = path.join(project, 'share/hermit-e2e-ca.pem')
  const caKey = path.join(root, 'origin-ca.key')
  const run = args => execFileSync('openssl', args, { stdio: 'ignore' })
  run(['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', caKey, '-out', ca,
    '-days', '2', '-subj', '/CN=Hermit Factory Offline Root'])
  const contexts = {}
  for (const [name, hosts] of [
    ['normal', 'DNS:api.anthropic.com,DNS:platform.claude.com'],
    ['wrong-name', 'DNS:wrong.invalid'],
  ]) {
    const key = path.join(root, name+'.key'), csr = path.join(root, name+'.csr')
    const cert = path.join(root, name+'.pem'), ext = path.join(root, name+'.ext')
    run(['req', '-newkey', 'rsa:2048', '-nodes', '-keyout', key, '-out', csr, '-subj', '/CN=Offline Leaf'])
    fs.writeFileSync(ext, `basicConstraints=CA:FALSE\nkeyUsage=digitalSignature,keyEncipherment\nextendedKeyUsage=serverAuth\nsubjectAltName=${hosts}\n`)
    run(['x509', '-req', '-in', csr, '-CA', ca, '-CAkey', caKey, '-CAcreateserial', '-out', cert, '-days', '1', '-extfile', ext])
    contexts[name] = { key: fs.readFileSync(key), cert: fs.readFileSync(cert) }
  }
  fs.copyFileSync(ca, path.join(out, 'origin-ca.pem'))
  const connections = []
  const server = https.createServer(contexts.normal, handler)
  server.on('secureConnection', socket => {
    connections.push({ sni: socket.servername, protocol: socket.getProtocol(), source: socket.remoteAddress })
    fs.writeFileSync(path.join(out, 'tls-connections.json'), JSON.stringify(connections, null, 2)+'\n')
  })
  server.on('tlsClientError', () => {})
  server.listen(443, '198.18.0.1')
  await once(server, 'listening')
  return {
    ca, connections, server,
    certificate(name) { server.setSecureContext(contexts[name]) },
  }
}

export function configureTLSSlot(container) {
  // 槽位保持只读。仅修改本次隔离 daemon 的 hosts 源文件。
  const inspected = JSON.parse(execFileSync('/usr/bin/docker', ['inspect', container], { encoding: 'utf8' }))[0]
  const hosts = inspected.HostsPath
  const owned = path.join(path.dirname(process.env.HERMIT_E2E_FIXTURE_ROOT), 'daemon-data/containers') + path.sep
  if (inspected.Config.Labels?.['kin.vm.role'] !== 'hermit' || !hosts.startsWith(owned) || path.basename(hosts) !== 'hosts' || !fs.lstatSync(hosts).isFile()) throw new Error('拒绝修改非实验槽位的 hosts 文件')
  const lines = fs.readFileSync(hosts, 'utf8').split('\n').filter(line => !line.split(/\s+/).some(word => ['api.anthropic.com', 'platform.claude.com'].includes(word)))
  fs.writeFileSync(hosts, lines.join('\n') + '\n198.18.0.1 api.anthropic.com platform.claude.com\n')
  const addresses = JSON.parse(execFileSync('/usr/bin/docker', ['exec', container, 'python3', '-c', "import socket,json;print(json.dumps({host:socket.gethostbyname(host) for host in ['api.anthropic.com','platform.claude.com']}))"], { encoding: 'utf8' }))
  if (!Object.values(addresses).every(value => value === '198.18.0.1')) throw new Error('实验槽位 DNS 未生效')
  return 'configured'
}
