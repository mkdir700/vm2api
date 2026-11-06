import test from 'node:test'
import assert from 'node:assert/strict'
import { execFile, execFileSync } from 'node:child_process'
import { promisify } from 'node:util'
import { createHash, randomBytes } from 'node:crypto'
import { mkdtemp, mkdir, readFile, writeFile, stat, rm } from 'node:fs/promises'
import path from 'node:path'
import { tmpdir } from 'node:os'
import http from 'node:http'
import net from 'node:net'
import { MANAGED_EGRESS_IMAGE } from '../../src/lib/vm/managed-egress-docker.mjs'
import { containerName } from '../../src/lib/vm/vm-runtime.mjs'

const execute = promisify(execFile)
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const artifact = path.resolve('.tmp/managed-egress-e2e/installer-receipt.json')
async function receipt(value) {
  await mkdir(path.dirname(artifact), { recursive: true })
  await writeFile(
    value.status === 'NOT RUN' ? artifact.replace('-receipt', '-not-run-receipt') : artifact,
    JSON.stringify(value, null, 2),
  )
}
async function freePort() {
  const server = net.createServer()
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const port = server.address().port
  await new Promise((resolve) => server.close(resolve))
  return port
}
const cleanError = (value) =>
  String(value || '')
    .replace(/socks5h?:\/\/[^\s]+/g, '[redacted-proxy]')
    .replace(/[a-fA-F0-9]{32,}/g, '[redacted-token]')
    .slice(-500)

test('full CLI installation and alignment serve a real managed slot on native AMD64', {
  timeout: 900000,
}, async (t) => {
  if (process.env.MANAGED_EGRESS_INSTALLER_E2E !== '1' || process.platform !== 'linux' || process.arch !== 'x64') {
    await receipt({
      status: 'NOT RUN',
      reason: 'explicit isolated native Linux AMD64 installer acceptance is required',
    })
    t.skip('explicit isolated native Linux AMD64 installer acceptance is required')
    return
  }
  const nonce = randomBytes(5).toString('hex')
  const root = await mkdtemp(path.join(tmpdir(), 'me-installer-'))
  const deployment = path.join(root, 'install')
  const project = `me-installer-${nonce}`
  const registry = `${project}-registry`
  const upstream = `${project}-upstream`
  const vmId = `vm-installer-${nonce}`
  const candidate = process.env.MANAGED_EGRESS_CANDIDATE_IMAGE || 'vm2api-managed-egress-control:candidate-amd64'
  const source = process.env.MANAGED_EGRESS_SOURCE_REVISION
  assert.match(source || '', /^[a-f0-9]{40}$/)
  const version = (await readFile('VERSION', 'utf8')).trim()
  const tag = `v${version}`
  const registryPort = await freePort()
  const hy2Port = await freePort()
  const repository = `127.0.0.1:${registryPort}/${project}/vm2api`
  const guestRegistry = `127.0.0.1:${registryPort}/${project}/guests`
  const releaseFiles = [
    'docker-compose.yml',
    'deploy/init-managed-egress.sh',
    '.env.example',
    'VERSION',
    'CHANGELOG.md',
    'deploy/install.sh',
  ]
  const released = new Map(await Promise.all(releaseFiles.map(async (file) => [file, await readFile(file)])))
  const downloads = new Set()
  let key
  let proxyId
  let stage = 'preflight'
  let result
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://fixture')
    if (url.pathname.startsWith(`/raw/${tag}/`)) {
      const file = url.pathname.slice(`/raw/${tag}/`.length)
      const body = released.get(file)
      if (body) {
        downloads.add(file)
        res.writeHead(200, { 'content-length': body.length })
        res.end(body)
        return
      }
    }
    if (url.pathname === `/api/${tag}`) {
      res.end(JSON.stringify({ tag_name: tag, body: 'Controlled release transport' }))
      return
    }
    if (url.pathname === '/geo') {
      res.end(JSON.stringify({ query: req.socket.remoteAddress }))
      return
    }
    if (url.pathname === '/source') {
      res.end(req.socket.remoteAddress)
      return
    }
    res.writeHead(404)
    res.end()
  })
  const docker = async (args, allowFailure = false) => {
    try {
      return (await execute('docker', args, { timeout: 300000, maxBuffer: 2 * 1024 * 1024 })).stdout.trim()
    } catch (error) {
      if (allowFailure) return null
      throw new Error(`installer_fixture_docker_failed:${args[0]} ${cleanError(error.stderr)}`)
    }
  }
  const inspect = async (name) => JSON.parse(await docker(['inspect', name]))[0]
  const compose = (args, allowFailure = false) =>
    docker(
      ['compose', '--project-directory', deployment, '-p', project, '-f', `${deployment}/docker-compose.yml`, ...args],
      allowFailure,
    )
  const api = async (method, url, body) => {
    const r = await fetch(`http://127.0.0.1:8787${url}`, {
      method,
      headers: { authorization: `Bearer ${key}`, ...(body ? { 'content-type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(120000),
    })
    const parsed = await r.json()
    assert.equal(r.status, 200, `${stage}: ${method} ${url}: ${cleanError(parsed.error?.message)}`)
    return parsed.data || parsed
  }
  const environment = async () =>
    Object.fromEntries(
      (await readFile(`${deployment}/.env`, 'utf8'))
        .split('\n')
        .filter((line) => line && !line.startsWith('#') && line.includes('='))
        .map((line) => [line.slice(0, line.indexOf('=')), line.slice(line.indexOf('=') + 1)]),
    )
  let installerEnv
  const install = async (command) => {
    try {
      await execute(
        'bash',
        [path.resolve('deploy/install.sh'), command, '--version', tag, '--dir', deployment, '--yes'],
        { env: installerEnv, timeout: 600000, maxBuffer: 2 * 1024 * 1024 },
      )
    } catch {
      throw new Error(`full_cli_${command}_failed; inspect the controlled stage without retaining credentials`)
    }
  }
  const route = async () =>
    docker([
      'exec',
      containerName(vmId),
      'curl',
      '--silent',
      '--show-error',
      '--fail',
      '--noproxy',
      '*',
      '--max-time',
      '8',
      `${installerEnv.FIXTURE_ORIGIN}/source`,
    ])
  const kernelReady = async () => {
    let last
    for (let i = 0; i < 60; i++) {
      const vm = await api('GET', `/api/panel/vms/${vmId}`)
      last = vm.kernel?.rust_health
      if (Number(last?.status) === 200) return
      await delay(500)
    }
    throw new Error(`actual_installed_kernel_unavailable:${cleanError(last?.error)}`)
  }
  try {
    assert.equal(await docker(['info', '--format', '{{.Architecture}}']), 'x86_64')
    assert.equal(execFileSync('uname', ['-m'], { encoding: 'utf8' }).trim(), 'x86_64')
    assert.equal((await inspect(candidate)).Architecture, 'amd64')
    assert.equal(await docker(['ps', '-aq', '--filter', 'name=^vm2api$']), '')
    const candidateId = (await inspect(candidate)).Id
    const guestId = (await inspect('ghcr.io/dofastted/kin-os-ubuntu:24.04')).Id
    await mkdir(deployment)
    await mkdir(`${root}/commands`)
    await new Promise((resolve) => server.listen(0, '0.0.0.0', resolve))
    const releasePort = server.address().port
    const originHost = await docker(['network', 'inspect', 'bridge', '--format', '{{(index .IPAM.Config 0).Gateway}}'])
    const originUrl = `http://${originHost}:${releasePort}`
    await writeFile(
      `${root}/commands/curl`,
      `#!/usr/bin/env python3\nimport os,sys\na=sys.argv[1:]\nfor i,v in enumerate(a):\n p='https://raw.githubusercontent.com/dofastted/vm2api/'\n q='https://api.github.com/repos/dofastted/vm2api/releases/tags/'\n if v.startswith(p):a[i]='http://127.0.0.1:${releasePort}/raw/'+v[len(p):]\n elif v.startswith(q):a[i]='http://127.0.0.1:${releasePort}/api/'+v[len(q):]\nos.execv('/usr/bin/curl',['curl']+a)\n`,
      { mode: 0o755 },
    )
    installerEnv = { ...process.env, PATH: `${root}/commands:${process.env.PATH}`, FIXTURE_ORIGIN: originUrl }
    // Only non-secret registry inputs exist before installation. The real CLI
    // generates its own API key, database secret, and default administrator data.
    await writeFile(
      `${deployment}/.env`,
      `VM2API_IMAGE=${repository}\nKIN_OS_REGISTRY=${guestRegistry}\nCOMPOSE_PROJECT_NAME=${project}\nKIN_PROXY_GEO_URL=${originUrl}/geo\nKIN_AUTO_SYNC_WRAP=0\n`,
      { mode: 0o600 },
    )
    await docker([
      'run',
      '-d',
      '--name',
      registry,
      '--label',
      `vm2api.e2e.owner=${nonce}`,
      '--network',
      'host',
      '-e',
      `REGISTRY_HTTP_ADDR=127.0.0.1:${registryPort}`,
      '-v',
      `${root}/registry:/var/lib/registry`,
      'registry:2.8.3',
    ])
    for (let i = 0; i < 60; i++) {
      try {
        if ((await fetch(`http://127.0.0.1:${registryPort}/v2/`)).ok) break
      } catch {}
      await delay(200)
    }
    for (const [image, target] of [
      [candidate, `${repository}:${tag}`],
      [guestId, `${guestRegistry}/kin-os-ubuntu:24.04`],
    ]) {
      await docker(['tag', image, target])
      await docker(['push', target])
    }
    stage = 'full CLI fresh installation'
    await install('install')
    const envBefore = await environment()
    key = envBefore.VM2API_API_KEY
    assert.ok(/^[a-f0-9]{64}$/.test(key))
    assert.ok(/^[a-f0-9]{64}$/.test(envBefore.VM2API_DB_SECRET))
    assert.ok(envBefore.VM2API_DB_SECRET !== key)
    assert.equal((await stat(`${deployment}/.env`)).mode & 0o777, 0o600)
    for (const file of releaseFiles) {
      assert.ok(downloads.has(file), `the real CLI must download ${file}`)
      assert.deepEqual(await readFile(`${deployment}/${file}`), released.get(file))
    }
    const control = await inspect('vm2api')
    assert.equal(control.Image, candidateId)
    assert.equal((await fetch('http://127.0.0.1:8787/health')).status, 200)
    assert.equal((await fetch('http://127.0.0.1:8787/console')).status, 200)
    assert.equal((await fetch('http://127.0.0.1:8787/api/panel/proxies')).status, 401)
    const fleet = await api('GET', '/api/panel/vms')
    assert.equal((Array.isArray(fleet) ? fleet : fleet.items).length, 0)
    const sharedId = await compose(['ps', '-q', 'sing-box'])
    assert.equal((await inspect(sharedId)).State.Running, true)
    assert.deepEqual(JSON.parse(await readFile(`${deployment}/data/managed-egress/config.json`, 'utf8')).inbounds, [])
    t.diagnostic('unmodified CLI dispatch installed real native AMD64 control and checked empty shared service')
    stage = 'managed import and real factory'
    execFileSync(
      'openssl',
      [
        'req',
        '-x509',
        '-newkey',
        'rsa:2048',
        '-nodes',
        '-keyout',
        `${root}/key.pem`,
        '-out',
        `${root}/cert.pem`,
        '-days',
        '1',
        '-subj',
        '/CN=localhost',
      ],
      { stdio: 'ignore' },
    )
    const password = randomBytes(24).toString('hex')
    await writeFile(
      `${root}/upstream.json`,
      JSON.stringify({
        log: { disabled: true },
        inbounds: [
          {
            type: 'hysteria2',
            listen: '127.0.0.1',
            listen_port: hy2Port,
            users: [{ password }],
            tls: { enabled: true, certificate_path: '/fixture/cert.pem', key_path: '/fixture/key.pem' },
          },
        ],
        outbounds: [{ type: 'direct', inet4_bind_address: '127.0.0.3' }],
      }),
    )
    await docker([
      'run',
      '-d',
      '--name',
      upstream,
      '--label',
      `vm2api.e2e.owner=${nonce}`,
      '--network',
      'host',
      '--read-only',
      '--cap-drop',
      'ALL',
      '-v',
      `${root}:/fixture:ro`,
      MANAGED_EGRESS_IMAGE,
      'run',
      '-c',
      '/fixture/upstream.json',
    ])
    const added = await api('POST', '/api/panel/proxies/import', {
      protocol: 'hysteria2',
      config: {
        server: '127.0.0.1',
        server_port: hy2Port,
        password,
        server_name: 'localhost',
        insecure: true,
      },
    })
    proxyId = added.items[0].id
    const applied = await api('POST', '/api/panel/proxies/apply')
    assert.equal(applied.runtime.applied_version, applied.runtime.desired_version)
    const created = await api('POST', '/api/panel/vms/create', {
      id: vmId,
      kernel: 'ubuntu-24.04',
      runtime_type: 'docker',
      proxy_id: proxyId,
      proxy_cli_enabled: true,
      start: true,
    })
    assert.ok(created.proxy_error == null, `managed factory binding failed: ${cleanError(created.proxy_error)}`)
    assert.ok(created.start_error == null, `managed factory startup failed: ${cleanError(created.start_error)}`)
    assert.equal((await inspect(containerName(vmId))).Image, guestId)
    await kernelReady()
    assert.equal(await route(), '127.0.0.3')
    const routingBefore = createHash('sha256')
      .update(await readFile(`${deployment}/src/config/routing.json`))
      .digest('hex')
    const configBefore = createHash('sha256')
      .update(await readFile(`${deployment}/data/managed-egress/config.json`))
      .digest('hex')
    const sharedBefore = await inspect(sharedId)
    stage = 'full CLI same-version alignment'
    await install('upgrade')
    const environmentDigest = (env) =>
      createHash('sha256')
        .update(JSON.stringify(Object.entries(env).sort()))
        .digest('hex')
    assert.equal(environmentDigest(await environment()), environmentDigest(envBefore))
    assert.equal(
      createHash('sha256')
        .update(await readFile(`${deployment}/src/config/routing.json`))
        .digest('hex'),
      routingBefore,
    )
    assert.equal(
      createHash('sha256')
        .update(await readFile(`${deployment}/data/managed-egress/config.json`))
        .digest('hex'),
      configBefore,
    )
    const current = (await api('GET', '/api/panel/proxies')).proxies.find((p) => p.id === proxyId)
    assert.ok(current.bound_vm_ids.includes(vmId))
    await kernelReady()
    assert.equal(await route(), '127.0.0.3')
    assert.equal((await inspect(sharedId)).State.StartedAt, sharedBefore.State.StartedAt)
    stage = 'installed runtime failure and recovery'
    await docker(['stop', sharedId])
    await api('GET', '/api/panel/proxies')
    assert.equal(
      await docker(
        [
          'exec',
          containerName(vmId),
          'curl',
          '--silent',
          '--fail',
          '--noproxy',
          '*',
          '--max-time',
          '3',
          `${originUrl}/source`,
        ],
        true,
      ),
      null,
    )
    await api('POST', '/api/panel/proxies/recover')
    assert.equal(await route(), '127.0.0.3')
    result = {
      status: 'PASS',
      source,
      environment: 'native Linux AMD64; isolated Docker daemon on authorized host',
      docker_version: await docker(['version', '--format', '{{.Server.Version}}']),
      candidate_image: candidateId,
      guest_image: guestId,
      sing_box_image: MANAGED_EGRESS_IMAGE,
      tag,
      release_transport:
        'only tagged raw-release/API URLs redirected to exact controlled source files; real curl, installer, Compose and registry',
      versions: applied.runtime,
      observed_exit: '127.0.0.3',
      results: [
        'full CLI install including fleet refresh and wrap sync',
        'generated private credentials; authenticated API and anonymous refusal',
        'fresh empty fleet and checked empty shared service',
        'real native factory identity and actual Ubuntu kernel/route',
        'full CLI same-version alignment preserves credentials routing proxy ID binding and shared instance',
        'installed service failure refuses routed traffic; checked recovery restores selected exit',
      ],
      scope:
        'controlled CLI install/alignment and native AMD64 production runtime; no published release, global host preparation, whole-host reboot, provider, real Claude or visual acceptance',
    }
  } catch (error) {
    await receipt({
      status: 'FAIL',
      stage,
      reason: 'inspect the installer E2E assertion; partial execution is not acceptance',
    })
    throw error
  } finally {
    const slot = await inspect(containerName(vmId)).catch(() => null)
    if (slot) {
      assert.equal(slot.Config.Labels['kin.vm.id'], vmId)
      await docker(['rm', '-f', slot.Id])
    }
    const control = await inspect('vm2api').catch(() => null)
    if (control) {
      assert.equal(control.Config.Labels['com.docker.compose.project'], project)
      if (control.State.Running)
        await docker(
          [
            'exec',
            'vm2api',
            'node',
            '--input-type=module',
            '-e',
            'import {stopProxyEgress} from "./src/lib/vm/egress.mjs"; for(const id of process.argv.slice(1)) stopProxyEgress(process.env.KIN_PROJECT_ROOT,id)',
            ...[proxyId, 'px-local'].filter(Boolean),
          ],
          true,
        )
    }
    await compose(['down', '--remove-orphans'], true)
    for (const name of [upstream, registry]) {
      const info = await inspect(name).catch(() => null)
      if (info) {
        assert.equal(info.Config.Labels['vm2api.e2e.owner'], nonce)
        await docker(['rm', '-f', info.Id])
      }
    }
    for (const id of [proxyId, 'px-local'].filter(Boolean)) {
      const found = await docker(['network', 'inspect', `kin-eg-${id}`], true)
      if (found) {
        const info = JSON.parse(found)[0]
        assert.equal(Object.keys(info.Containers || {}).length, 0)
        await docker(['network', 'rm', info.Id])
      }
    }
    await new Promise((resolve) => server.close(resolve))
    await rm(root, { recursive: true, force: true })
  }
  result.source_files = Object.fromEntries(
    await Promise.all(
      [
        'test/e2e/managed-egress-installer.e2e.test.mjs',
        'test/fixtures/managed-egress-cli.Dockerfile',
        'deploy/install.sh',
        'Dockerfile',
        'docker-compose.yml',
        'deploy/init-managed-egress.sh',
        '.env.example',
        'VERSION',
        'scripts/docker-entrypoint.sh',
        'scripts/fleet-services.mjs',
        'src/lib/identity/slot-computer.mjs',
        'src/lib/vm/slot-recovery.mjs',
        'src/lib/vm/proxy-pool.mjs',
        'src/server.mjs',
        'src/lib/admin/panel-routes.mjs',
        'src/lib/admin/backup-service.mjs',
        'src/lib/cluster/cluster-manager.mjs',
        'src/lib/cluster/managed-egress-hosts.mjs',
        'src/lib/vm/vm-package.mjs',
        'src/lib/vm/vm-runtime.mjs',
        'src/lib/oauth/oauth-credentials.mjs',
      ].map(async (file) => [
        file,
        createHash('sha256')
          .update(await readFile(file))
          .digest('hex'),
      ]),
    ),
  )
  await receipt(result)
})
