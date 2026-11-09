import test from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { once } from 'node:events'
import { createHash, randomBytes } from 'node:crypto'
import { mkdir, mkdtemp, readFile, writeFile, rm } from 'node:fs/promises'
import path from 'node:path'
import { connectSshAlias, readSshAliasTarget } from '../helpers/ssh-alias.mjs'
import { startGateway, api } from '../harness.mjs'
import { execCollect } from '../../src/lib/cluster/ssh-link.mjs'
import { openSftp, readRemoteFileNoFollow, writeRemoteFile, shellQuote } from '../../src/lib/cluster/remote-fs.mjs'
import { MANAGED_EGRESS_IMAGE } from '../../src/lib/vm/managed-egress-docker.mjs'
import { slotEgressNames } from '../../src/lib/cluster/remote-slot.mjs'
import { containerName } from '../../src/lib/vm/vm-runtime.mjs'
import { slotExec } from '../../src/lib/vm/slot-runtime.mjs'
import { rustKernelHealth } from '../../src/lib/transport/rust-kernel-client.mjs'
import { HOSTNAME_RE, MACHINE_ID_RE } from '../../src/lib/identity/workstation-fingerprint.mjs'

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const data = (response) => response.json?.data || response.json
const artifact = path.resolve('.tmp/managed-egress-e2e/public-remote-receipt.json')
async function receipt(value) {
  await mkdir(path.dirname(artifact), { recursive: true })
  await writeFile(
    value.status === 'NOT RUN' ? artifact.replace('-receipt', '-not-run-receipt') : artifact,
    JSON.stringify(value, null, 2),
  )
}

test('public gateway enrolls a pinned independent Linux host and routes its real remote slot', {
  timeout: 900000,
}, async (t) => {
  const alias = process.env.MANAGED_EGRESS_PUBLIC_REMOTE_ALIAS
  if (!alias) {
    await receipt({
      status: 'NOT RUN',
      reason: 'an explicitly selected independent SSH host is required',
    })
    t.skip('an explicitly selected independent SSH host is required')
    return
  }
  const rebootHost = process.env.MANAGED_EGRESS_HOST_REBOOT_ALIAS
  assert.ok(!rebootHost || rebootHost === alias, 'reboot must name the explicitly authorized alias')
  if (process.platform !== 'linux') {
    await receipt({ status: 'NOT RUN', reason: 'real remote factory acceptance requires a Linux control runner' })
    t.skip('a Linux control runner with the real pinned computer payload is required')
    return
  }
  const payload = path.resolve(process.env.MANAGED_EGRESS_FULL_SLOT_PAYLOAD || '.tmp/managed-egress-fullslot-payload')
  const helper = path.resolve(
    process.env.KIN_EGRESS_REMOTE_TEST_BIN || '.tmp/managed-egress-helper/kin-egress-linux-amd64',
  )
  execFileSync(process.execPath, ['scripts/fetch-payload.mjs', '--check', '--dest', payload], { stdio: 'pipe' })
  const computerBytes = await readFile(`${payload}/bin/kin-computer`)
  assert.equal(computerBytes.readUInt16LE(18), 62)
  const helperBytes = await readFile(helper)
  assert.equal(helperBytes.readUInt16LE(18), 62)
  const nonce = randomBytes(4).toString('hex')
  const project = await mkdtemp('/tmp/me-pub-')
  const root = '/root/.vm2api'
  const fixture = rebootHost ? `/root/.vm2api-reboot-fixture-${nonce}` : `/tmp/me-public-${nonce}`
  const vmId = `vm-public-${nonce}`
  const names = slotEgressNames(vmId)
  const secondVmId = `vm-reboot-${nonce}`
  const ownedVmIds = [vmId]
  let rebootEvidence, primaryFailure
  let phase = 'setup'
  const guestImage = 'ghcr.io/dofastted/kin-os-ubuntu:24.04'
  const containers = []
  let client,
    gateway,
    nodeId,
    claimed = false,
    fixtureOwned = false,
    before = [],
    result
  const run = async (args, timeoutMs = 45000) => {
    const r = await execCollect(client, args.map(shellQuote).join(' '), {
      timeoutMs,
      maxBytes: 4 * 1024 * 1024,
    })
    if (r.code !== 0) throw new Error(`public_remote_command_failed:${args[0]}`)
    return r.stdout.trim()
  }
  const docker = (args, timeout) => run(['docker', ...args], timeout)
  const inspect = async (name) => JSON.parse(await docker(['inspect', name]))[0]
  const snapshot = async () => {
    const ids = (await docker(['ps', '-q', '--no-trunc'])).split(/\s+/).filter(Boolean)
    return ids.length
      ? JSON.parse(await docker(['inspect', ...ids])).map((x) => ({
          id: x.Id,
          name: x.Name,
          restart_policy: x.HostConfig.RestartPolicy.Name,
          network_mode: x.HostConfig.NetworkMode,
          started: x.State.StartedAt,
          running: x.State.Running,
          restarts: x.RestartCount,
        }))
      : []
  }
  const put = async (name, bytes) =>
    writeRemoteFile(await openSftp(client), `${fixture}/${name}`, Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes), {
      mode: 0o600,
    })
  const http = async (method, url, body) => api(gateway, method, url, { body })
  const expectHttp = async (method, url, body, status = 200) => {
    const r = await http(method, url, body)
    const detail = String(r.json?.error?.message || '')
      .replace(/socks5h?:\/\/[^\s]+/g, '[redacted-proxy]')
      .slice(-600)
    assert.equal(r.status, status, `${method} ${url}: ${r.json?.error?.code || 'unexpected status'} ${detail}`)
    return data(r)
  }
  const stopGateway = async () => {
    if (!gateway) return
    const child = gateway.child
    const ended = child.exitCode == null && child.signalCode == null ? once(child, 'exit') : Promise.resolve()
    await gateway.stop()
    await ended
    gateway = null
  }
  try {
    client = await connectSshAlias(alias)
    assert.equal(await run(['id', '-u']), '0')
    assert.equal(await run(['uname', '-s']), 'Linux')
    assert.equal(await run(['uname', '-m']), 'x86_64')
    assert.equal(await run(['sh', '-c', 'printf "%s" "$HOME"']), '/root')
    before = await snapshot()
    // mkdir is exclusive: refuse existing data, including dangling symlinks.
    await run(['mkdir', '-m', '700', root])
    claimed = true
    await writeRemoteFile(await openSftp(client), `${root}/.acceptance-owner`, Buffer.from(nonce), {
      mode: 0o600,
    })
    await run(['mkdir', '-m', '700', fixture])
    fixtureOwned = true
    await put('.owner', nonce)
    assert.equal(await docker(['ps', '-aq', '--filter', `name=^${containerName(vmId)}$`]), '')
    assert.equal(await docker(['ps', '-aq', '--filter', `name=^${names.egress}$`]), '')
    assert.equal(await docker(['network', 'ls', '--filter', `name=^${names.network}$`, '--format', '{{.Name}}']), '')
    await docker(['image', 'inspect', guestImage])
    await docker(['image', 'inspect', MANAGED_EGRESS_IMAGE])
    const bridge = await docker(['network', 'inspect', 'bridge', '--format', '{{(index .IPAM.Config 0).Gateway}}'])
    assert.match(bridge, /^(172\.|10\.|192\.168\.)/)
    await put(
      'origin.py',
      `import http.server\nclass H(http.server.BaseHTTPRequestHandler):\n def do_GET(self):\n  b=('{"query":"'+self.client_address[0]+'"}' if self.path=='/geo' else self.client_address[0]).encode()\n  self.send_response(200);self.send_header('Content-Length',str(len(b)));self.end_headers();self.wfile.write(b)\n def log_message(self,*args):pass\nimport os\np=int(open('/fixture/port').read()) if os.path.exists('/fixture/port') else 0\ns=http.server.ThreadingHTTPServer(('${bridge}',p),H)\nopen('/fixture/port','w').write(str(s.server_port))\ns.serve_forever()\n`,
    )
    const origin = `me-public-${nonce}-origin`
    await docker([
      'run',
      '-d',
      '--pull=never',
      '--name',
      origin,
      '--restart',
      'unless-stopped',
      '--label',
      `vm2api.e2e.owner=${nonce}`,
      '--network',
      'host',
      '--read-only',
      '--user',
      '0:0',
      '-v',
      `${fixture}:/fixture:rw`,
      '--entrypoint',
      'python3',
      guestImage,
      '/fixture/origin.py',
    ])
    containers.push(origin)
    let port
    for (let i = 0; i < 100; i++) {
      port = Number((await readRemoteFileNoFollow(client, `${fixture}/port`))?.toString())
      if (port > 0 && port < 65536) break
      await delay(100)
    }
    assert.ok(port > 0 && port < 65536)
    const originUrl = `http://${bridge}:${port}`
    execFileSync(
      'openssl',
      [
        'req',
        '-x509',
        '-newkey',
        'rsa:2048',
        '-nodes',
        '-keyout',
        `${project}/key.pem`,
        '-out',
        `${project}/cert.pem`,
        '-days',
        '1',
        '-subj',
        '/CN=localhost',
      ],
      { stdio: 'ignore' },
    )
    await put('key.pem', await readFile(`${project}/key.pem`))
    await put('cert.pem', await readFile(`${project}/cert.pem`))
    const configs = []
    for (let i = 0; i < 2; i++) {
      const upstreamPort = Number(
        await run([
          'python3',
          '-c',
          "import socket;s=socket.socket(socket.AF_INET,socket.SOCK_DGRAM);s.bind(('127.0.0.1',0));print(s.getsockname()[1]);s.close() ",
        ]),
      )
      const password = `controlled-${nonce}-${i}`
      await put(
        `upstream-${i}.json`,
        JSON.stringify({
          log: { disabled: true },
          inbounds: [
            {
              type: 'hysteria2',
              listen: '127.0.0.1',
              listen_port: upstreamPort,
              users: [{ password }],
              tls: {
                enabled: true,
                certificate_path: '/fixture/cert.pem',
                key_path: '/fixture/key.pem',
              },
            },
          ],
          outbounds: [{ type: 'direct', inet4_bind_address: `127.0.0.${i + 2}` }],
        }),
      )
      const name = `me-public-${nonce}-upstream-${i}`
      await docker([
        'run',
        '-d',
        '--pull=never',
        '--name',
        name,
        '--restart',
        'unless-stopped',
        '--label',
        `vm2api.e2e.owner=${nonce}`,
        '--network',
        'host',
        '--read-only',
        '--cap-drop',
        'ALL',
        '-v',
        `${fixture}:/fixture:ro`,
        MANAGED_EGRESS_IMAGE,
        'run',
        '-c',
        `/fixture/upstream-${i}.json`,
      ])
      containers.push(name)
      configs.push({
        server: '127.0.0.1',
        server_port: upstreamPort,
        password,
        server_name: 'localhost',
        insecure: true,
      })
    }
    const routing = JSON.parse(await readFile('src/config/routing.json', 'utf8'))
    routing.inference = { ...routing.inference, session_slots: 1 }
    routing.kernel_watchdog = { ...routing.kernel_watchdog, enabled: true, interval_sec: 5 }
    await mkdir(`${project}/config`, { recursive: true })
    await mkdir(`${project}/vms`, { recursive: true })
    await writeFile(`${project}/vms/active.json`, JSON.stringify({ active_vm: null }), { mode: 0o600 })
    await writeFile(`${project}/config/routing.json`, JSON.stringify(routing), { mode: 0o600 })
    const options = {
      project,
      env: {
        KIN_PROXY_GEO_URL: `${originUrl}/geo`,
        KIN_CLUSTER_EGRESS_BIN: helper,
        KIN_CLUSTER_WORKER_BIN: `${payload}/bin/kin-worker`,
        KIN_COMPUTER_BIN: `${payload}/bin/kin-computer`,
        KIN_KERNEL_BIN: `${payload}/bin/kin-kernel`,
        KIN_OAUTH_AUTH_BIN: `${payload}/bin/kin-oauth-auth`,
        KIN_CODEX_KERNEL_BIN: `${payload}/bin/kin-codex-kernel`,
        KIN_WRAP_CLI_ROOT: `${payload}/share/wrap-cli`,
      },
    }
    gateway = await startGateway(options)
    const target = readSshAliasTarget(alias)
    const joined = await expectHttp(
      'POST',
      '/api/panel/cluster/nodes',
      {
        host: target.host,
        port: target.port,
        username: target.username,
        auth_type: 'key',
        private_key: target.privateKey,
        host_key_sha256: target.expectedSha256,
        host_key_alg: 'ssh-ed25519',
        label: `acceptance-${nonce}`,
      },
      201,
    )
    nodeId = joined.id
    assert.match(nodeId, /^node-[a-f0-9]+$/)
    let node
    for (let i = 0; i < 100; i++) {
      node = await expectHttp('GET', `/api/panel/cluster/nodes/${nodeId}`)
      if (node.link?.state === 'ready' && node.health?.docker?.ok) break
      await delay(300)
    }
    assert.equal(node.link?.state, 'ready')
    assert.equal(node.health?.docker?.ok, true)
    assert.equal(node.platform, 'linux')
    t.diagnostic('public HTTP enrollment discovered the real Linux host with the trusted SSH pin')
    const exits = []
    for (const config of configs) {
      const imported = await expectHttp('POST', '/api/panel/proxies/import', {
        protocol: 'hysteria2',
        host_id: nodeId,
        config,
      })
      exits.push(imported.items[0].id)
    }
    const applied = await expectHttp('POST', '/api/panel/proxies/apply', {
      host_id: nodeId,
    })
    assert.equal(applied.runtime.status, 'ready')
    assert.equal(applied.runtime.desired_version, applied.runtime.applied_version)
    const build = await expectHttp(
      'POST',
      `/api/panel/cluster/nodes/${nodeId}/slot-image`,
      { kernel: 'ubuntu-24.04' },
      202,
    )
    let job = build
    for (let i = 0; i < 600 && job.status === 'running'; i++) {
      await delay(500)
      job = await expectHttp('GET', `/api/panel/cluster/nodes/${nodeId}/slot-image?kernel=ubuntu-24.04`)
    }
    assert.equal(job.status, 'done', 'real remote slot payload build must complete')
    const image = await inspect(job.ref)
    assert.equal(image.Config.Labels['kin.slot.full'], '1')
    t.diagnostic('public remote import/apply and real slot-image build completed')
    const sharedBefore = await docker([
      'ps',
      '-q',
      '--no-trunc',
      '--filter',
      `label=vm2api.managed-egress.node=${nodeId}`,
    ])
    assert.match(sharedBefore, /^[a-f0-9]{64}$/)
    let createSettled = false
    const creating = expectHttp('POST', '/api/panel/vms/create', {
      id: vmId,
      node_id: nodeId,
      kernel: 'ubuntu-24.04',
      runtime_type: 'docker',
      proxy_id: exits[0],
      proxy_cli_enabled: true,
      start: true,
    }).finally(() => {
      createSettled = true
    })
    void creating.catch(() => {})
    let initialRecord
    const recordDeadline = Date.now() + 60000
    while (!createSettled && Date.now() < recordDeadline) {
      initialRecord = await readFile(`${project}/vms/${vmId}.json`, 'utf8').then(
        (text) => {
          try {
            return JSON.parse(text)
          } catch {
            return null
          }
        },
        () => null,
      )
      if (initialRecord) break
      await delay(25)
    }
    const created = await creating
    assert.ok(initialRecord, 'observe the persisted VM while real remote setup is pending')
    assert.equal(initialRecord.status, 'stopped', 'unfinished creation must not authorize watchdog revival')
    if (created.start_error) {
      const pool = await expectHttp('GET', '/api/panel/proxies')
      const link = await expectHttp('GET', `/api/panel/cluster/nodes/${nodeId}`)
      const helperState = await inspect(names.egress).catch(() => null)
      const slotState = await inspect(containerName(vmId)).catch(() => null)
      const state = (info) =>
        info
          ? {
              running: info.State.Running,
              exit_code: info.State.ExitCode,
              restarts: info.RestartCount,
              started_at: info.State.StartedAt,
              network: info.HostConfig.NetworkMode,
            }
          : null
      await mkdir('.tmp/managed-egress-e2e', { recursive: true })
      await writeFile(
        '.tmp/managed-egress-e2e/remote-factory-debug.json',
        JSON.stringify(
          {
            proxy_error: created.proxy_error || null,
            start_error: created.start_error,
            exits: pool.proxies
              .filter((p) => exits.includes(p.id))
              .map((p) => ({
                id: p.id,
                application: p.application_status,
                runtime: p.runtime_status,
                exit: p.exit_status,
                blocked_reason: p.blocked_reason,
                bound_count: p.bound_count,
              })),
            link_state: link.link?.state,
            link_error: link.link?.error?.code || null,
            helper: state(helperState),
            slot: state(slotState),
          },
          null,
          2,
        ),
      )
    }
    assert.equal(created.proxy_error, undefined, 'factory creation must initialize the selected remote helper')
    assert.equal(created.start_error, undefined, 'factory creation must start the actual remote kernel')
    assert.equal(
      await docker(['ps', '-q', '--no-trunc', '--filter', `label=vm2api.managed-egress.node=${nodeId}`]),
      sharedBefore,
    )
    const computerRoot = `${project}/vms/${vmId}/kvm/fingerprint`
    const mintedHostname = (await readFile(`${computerRoot}/system/etc/hostname`, 'utf8')).trim()
    const mintedMachineId = (await readFile(`${computerRoot}/system/etc/machine-id`, 'utf8')).trim()
    assert.match(mintedHostname, HOSTNAME_RE)
    assert.match(mintedMachineId, MACHINE_ID_RE)
    const route = async (expected) =>
      assert.equal(
        await docker([
          'exec',
          containerName(vmId),
          'curl',
          '--silent',
          '--show-error',
          '--fail',
          '--noproxy',
          '*',
          '--max-time',
          '15',
          `${originUrl}/source`,
        ]),
        expected,
      )
    assert.equal(
      (await run(['sha256sum', `${root}/vms/${vmId}/slot-bin/kin-egress`])).split(/\s+/)[0],
      createHash('sha256').update(helperBytes).digest('hex'),
    )
    const running = await inspect(containerName(vmId))
    assert.equal(running.State.Running, true)
    assert.equal(running.Image, image.Id)
    assert.equal(running.Config.Labels['kin.vm.id'], vmId)
    assert.equal(running.Config.Hostname, mintedHostname)
    assert.equal(await docker(['exec', containerName(vmId), 'cat', '/etc/machine-id']), mintedMachineId)
    assert.equal(running.HostConfig.NetworkMode, names.network)
    const record = () => readFile(`${project}/vms/${vmId}.json`, 'utf8').then(JSON.parse)
    const current = await record()
    assert.equal(current.node_id, nodeId)
    assert.equal(current.proxy.id, exits[0])
    assert.equal(current.fingerprint.guest_machine_id, mintedMachineId)
    const verifyKernel = async () => {
      let health
      const healthDeadline = Date.now() + 30000
      while (Date.now() < healthDeadline) {
        health = await rustKernelHealth(slotExec(project, await record()), {
          timeoutMs: 1000,
        })
        if (Number(health.status) === 200) break
        await delay(250)
      }
      assert.equal(
        Number(health.status),
        200,
        `private SSH kernel relay must reach the actual remote kernel: ${health.code || ''} ${health.error || ''}`,
      )
      assert.ok(!String(health.source || '').includes('mock'))
    }
    await verifyKernel()
    await route('127.0.0.2')
    t.diagnostic(
      'public factory creation mints a real computer and starts the actual remote kernel through its selected exit',
    )
    await expectHttp('POST', `/api/panel/vms/${vmId}/stop`)
    await expectHttp('POST', `/api/panel/proxies/${exits[1]}/bind`, {
      vm_id: vmId,
    })
    await expectHttp('POST', `/api/panel/vms/${vmId}/start`)
    await route('127.0.0.3')
    assert.equal((await record()).proxy.id, exits[1])
    await expectHttp('POST', `/api/panel/vms/${vmId}/stop`)
    const archived = await expectHttp('POST', '/api/panel/backups', undefined, 201)
    assert.ok(archived.item.file_name.endsWith('.tar.gz'))
    await expectHttp('PUT', `/api/panel/proxies/${exits[1]}`, {
      config: configs[0],
      label: 'after-archive',
    })
    await expectHttp('POST', '/api/panel/proxies/apply', { host_id: nodeId })
    await expectHttp('POST', `/api/panel/backups/${archived.item.id}/restore`, { confirm: true })
    for (let i = 0; i < 100; i++) {
      node = await expectHttp('GET', `/api/panel/cluster/nodes/${nodeId}`)
      if (node.link?.state === 'ready' && node.health?.docker?.ok) break
      await delay(300)
    }
    assert.equal(node.link?.state, 'ready')
    assert.equal(node.health?.docker?.ok, true)
    const afterArchiveStart = await http('POST', `/api/panel/vms/${vmId}/start`)
    assert.equal(afterArchiveStart.status, 409, 'a restored remote binding must refuse the newer post-backup runtime')
    assert.equal((await record()).proxy.id, exits[1])
    const restoredApplied = await expectHttp('POST', '/api/panel/proxies/apply', { host_id: nodeId })
    await expectHttp('POST', `/api/panel/vms/${vmId}/start`)
    await verifyKernel()
    await route('127.0.0.3')
    assert.equal((await record()).proxy.id, exits[1])
    t.diagnostic(
      'real remote archive restore rebuilds SSH/SQLite holders and requires checked restoration of its selected exit',
    )
    t.diagnostic('real remote HTTP bind/start/stop/rebind retains the assigned transparent route')
    await stopGateway()
    gateway = await startGateway(options)
    let restored = false
    for (let i = 0; i < 100; i++) {
      const r = await http('GET', '/api/panel/proxies')
      const row = data(r)?.proxies?.find((x) => x.id === exits[1])
      if (row?.exit_status === 'ready' && row.blocked_reason == null) {
        restored = true
        break
      }
      await delay(500)
    }
    assert.equal(restored, true, 'gateway restart must verify the retained remote binding')
    await expectHttp('POST', `/api/panel/vms/${vmId}/start`)
    await route('127.0.0.3')
    assert.equal((await record()).proxy.id, exits[1])
    if (rebootHost) {
      ownedVmIds.push(secondVmId)
      const second = await expectHttp('POST', '/api/panel/vms/create', {
        id: secondVmId,
        node_id: nodeId,
        kernel: 'ubuntu-24.04',
        runtime_type: 'docker',
        proxy_id: exits[0],
        proxy_cli_enabled: true,
        start: true,
      })
      assert.equal(second.proxy_error, undefined)
      assert.equal(second.start_error, undefined)
      const secondRecord = () => readFile(`${project}/vms/${secondVmId}.json`, 'utf8').then(JSON.parse)
      const secondRoute = async () =>
        assert.equal(
          await docker([
            'exec',
            containerName(secondVmId),
            'curl',
            '--silent',
            '--show-error',
            '--fail',
            '--noproxy',
            '*',
            '--max-time',
            '15',
            `${originUrl}/source`,
          ]),
          '127.0.0.2',
        )
      await secondRoute()
      const bindingIntent = (vm) => ({
        id: vm.id,
        exit_id: vm.proxy.id,
        host_id: vm.proxy.managed_host_id,
        listener_port: vm.proxy.managed_listener_port,
      })
      const saved = [await record(), await secondRecord()].map(bindingIntent)
      const bootBefore = await run(['cat', '/proc/sys/kernel/random/boot_id'])
      const configBefore = await run(['sha256sum', `${root}/managed-egress/config.json`])
      const originalBefore = await snapshot()
      assert.equal(await run(['systemctl', 'is-enabled', 'docker']), 'enabled')
      t.diagnostic(
        'REBOOT_READY: two real remote slots and original container snapshot verified; issuing one authorized host reboot',
      )
      // A lost SSH command reply is expected; reconnect/boot ID decides the outcome.
      phase = 'reboot_requested'
      await run(['systemctl', 'reboot'], 15000).catch(() => {})
      client?.end()
      let bootAfter
      const reconnectDeadline = Date.now() + 240000
      while (Date.now() < reconnectDeadline) {
        await delay(3000)
        try {
          client = await connectSshAlias(alias)
          bootAfter = await run(['cat', '/proc/sys/kernel/random/boot_id'], 10000)
          if (bootAfter !== bootBefore && (await run(['systemctl', 'is-active', 'docker'])) === 'active') break
        } catch {
          client?.end()
        }
      }
      assert.ok(
        bootAfter && bootAfter !== bootBefore,
        'must observe a changed Linux boot ID; never issue another reboot',
      )
      const manuallyResumed = []
      phase = 'original_container_recovery'
      const recovering = new Set()
      const resumeOriginal = async (previous) => {
        const info = await inspect(previous.id)
        assert.equal(info.Name, previous.name)
        assert.equal(info.HostConfig.RestartPolicy.Name, previous.restart_policy)
        assert.equal(info.HostConfig.NetworkMode, previous.network_mode)
        if (info.State.Running) return
        assert.ok(!recovering.has(previous.id), 'original namespace dependency must not cycle')
        recovering.add(previous.id)
        if (previous.network_mode.startsWith('container:')) {
          const target = previous.network_mode.slice('container:'.length)
          const parent = before.find((row) => row.id === target || row.name === `/${target}`)
          assert.ok(parent, 'do not start an unknown original namespace dependency')
          await resumeOriginal(parent)
        }
        await docker(['start', previous.id])
        manuallyResumed.push(previous.name)
        recovering.delete(previous.id)
      }
      for (const previous of before) await resumeOriginal(previous)
      phase = 'managed_recovery_verification'
      let readyAfterBoot = false
      for (let i = 0; i < 180; i++) {
        const rows = data(await http('GET', '/api/panel/proxies'))?.proxies || []
        if (
          exits.every((id) =>
            rows.some((row) => row.id === id && row.exit_status === 'ready' && row.blocked_reason == null),
          )
        ) {
          readyAfterBoot = true
          break
        }
        await delay(1000)
      }
      assert.equal(
        readyAfterBoot,
        true,
        'SSH reconnect must verify both retained exits after OS boot without apply/start',
      )
      assert.equal(await run(['sha256sum', `${root}/managed-egress/config.json`]), configBefore)
      assert.deepEqual([await record(), await secondRecord()].map(bindingIntent), saved)
      await verifyKernel()
      const secondHealth = await rustKernelHealth(slotExec(project, await secondRecord()), { timeoutMs: 5000 })
      assert.equal(Number(secondHealth.status), 200)
      await route('127.0.0.3')
      await secondRoute()
      rebootEvidence = {
        boot_before: bootBefore,
        boot_after: bootAfter,
        automatic_fixture_recovery: true,
        explicit_fixture_start_or_apply: false,
        config_sha256: configBefore.split(/\s+/)[0],
        slots: [
          { id: vmId, exit_id: exits[1], observed_exit: '127.0.0.3' },
          { id: secondVmId, exit_id: exits[0], observed_exit: '127.0.0.2' },
        ],
        original_container_count: before.length,
        original_container_ids_preserved: true,
        original_restart_policies_preserved: true,
        manually_resumed_original_names: manuallyResumed,
        pre_reboot_snapshot_sha256: createHash('sha256').update(JSON.stringify(originalBefore)).digest('hex'),
      }
      t.diagnostic(
        'REBOOT_VERIFIED: changed boot ID, both actual kernels/routes and saved mappings; original containers resumed',
      )
    }
    result = {
      status: 'PASS',
      alias,
      ssh_host_key_verified: true,
      node_id: nodeId,
      source: execFileSync('git', ['rev-parse', 'HEAD'], {
        encoding: 'utf8',
      }).trim(),
      environment: `${process.platform}/${process.arch} gateway to independent Linux AMD64 host`,
      command:
        'MANAGED_EGRESS_PUBLIC_REMOTE_ALIAS=primaryserver KIN_EGRESS_REMOTE_TEST_BIN=<Linux-AMD64-helper> MANAGED_EGRESS_FULL_SLOT_PAYLOAD=<pinned-payload> node --test test/e2e/managed-egress-public-remote.e2e.test.mjs',
      computer_sha256: createHash('sha256').update(computerBytes).digest('hex'),
      watchdog_enabled: true,
      watchdog_interval_seconds: 5,
      initial_creation_status: initialRecord.status,
      computer_execution:
        process.arch === 'arm64' ? 'AMD64 payload under existing ARM64-host emulation' : 'native AMD64 payload',
      minted_identity_sha256: createHash('sha256').update(`${mintedHostname}\n${mintedMachineId}`).digest('hex'),
      sing_box_image: MANAGED_EGRESS_IMAGE,
      remote_slot_image: job.ref,
      remote_slot_image_id: image.Id,
      helper_sha256: createHash('sha256').update(helperBytes).digest('hex'),
      versions: applied.runtime,
      restored_versions: restoredApplied.runtime,
      observed_exits: ['127.0.0.2', '127.0.0.3'],
      results: [
        'public pinned enrollment and real host discovery',
        'public remote import/apply and real image build',
        'public remote factory creation executes the pinned computer and preserves hostname and machine ID in the actual remote container',
        'unfinished creation remains stopped while the real five-second watchdog runs; successful boot commits running',
        'factory creation reuses the shared service and starts the actual remote kernel through the selected exit',
        'public remote stop/rebind/start with real kernel and transparent routes',
        'gateway restart retains selected remote exit',
        'stopped remote VM archive restore rebuilds cluster links and managed database holders; newer runtime is refused; explicit restored apply recovers its original route',
      ],
      scope:
        'controlled remote gateway lifecycle and stopped-VM archive restore; no concurrent/disaster restoration, host reboot, provider, real Claude, or visual acceptance',
    }
  } catch (error) {
    primaryFailure = error
    await receipt({
      status: 'FAIL',
      alias,
      phase,
      failure_code: error.code || 'remote_acceptance_failed',
      reason: 'inspect the public remote lifecycle assertion; partial execution is not success',
    })
    throw error
  } finally {
    await stopGateway()
    try {
      if (client && claimed) {
        assert.equal((await readRemoteFileNoFollow(client, `${root}/.acceptance-owner`))?.toString(), nonce)
        for (const ownedVmId of ownedVmIds) {
          const vmId = ownedVmId
          const names = slotEgressNames(vmId)
          const slot = await inspect(containerName(vmId)).catch(() => null)
          if (slot) {
            assert.equal(slot.Config.Labels['kin.vm.id'], vmId)
            assert.ok(slot.Mounts.some((x) => x.Source.startsWith(`${root}/vms/${vmId}/`)))
            await docker(['rm', '-f', slot.Id])
          }
          const helperInfo = await inspect(names.egress).catch(() => null)
          if (helperInfo) {
            assert.equal(helperInfo.Config.Labels['kin.egress.vm'], vmId)
            assert.ok(helperInfo.Mounts.some((x) => x.Source === `${root}/vms/${vmId}/egress`))
            await docker(['rm', '-f', helperInfo.Id])
          }
          if (await docker(['network', 'ls', '--filter', `name=^${names.network}$`, '--format', '{{.ID}}'])) {
            const net = JSON.parse(await docker(['network', 'inspect', names.network]))[0]
            assert.equal(net.Labels['kin.egress.vm'], vmId)
            assert.equal(Object.keys(net.Containers || {}).length, 0)
            await docker(['network', 'rm', net.Id])
          }
        }
        if (nodeId) {
          const ids = (await docker(['ps', '-aq', '--filter', `label=vm2api.managed-egress.node=${nodeId}`]))
            .split(/\s+/)
            .filter(Boolean)
          for (const id of ids) {
            const info = await inspect(id)
            assert.ok(info.Mounts.some((x) => x.Source === `${root}/managed-egress`))
            await docker(['rm', '-f', id])
          }
        }
        await run(['rm', '-rf', root])
      }
      for (const name of containers.reverse()) {
        const info = await inspect(name).catch(() => null)
        if (info) {
          assert.equal(info.Config.Labels['vm2api.e2e.owner'], nonce)
          await docker(['rm', '-f', info.Id])
        }
      }
      if (fixtureOwned) {
        assert.equal((await readRemoteFileNoFollow(client, `${fixture}/.owner`))?.toString(), nonce)
        await run(['rm', '-rf', fixture])
      }
      if (client) {
        const after = await snapshot()
        for (const previous of before) {
          const current = after.find((x) => x.id === previous.id)
          if (rebootHost) {
            assert.ok(current?.running, 'original container must be running after reboot')
            assert.equal(current.name, previous.name)
            assert.equal(current.restart_policy, previous.restart_policy)
          } else assert.deepEqual(current, previous)
        }
      }
    } catch (cleanupError) {
      if (!primaryFailure) throw cleanupError
      t.diagnostic(
        `cleanup incomplete after primary failure: ${cleanupError.code || 'ownership_or_connection_check_failed'}`,
      )
    } finally {
      client?.end()
      await rm(project, { recursive: true, force: true })
    }
  }
  result.existing_containers_preserved = true
  if (rebootEvidence) {
    result.host_reboot = rebootEvidence
    result.scope =
      'controlled independent-host factory/lifecycle/archive and authorized whole-OS reboot; no provider, Claude or visual acceptance'
  }
  result.source_files = Object.fromEntries(
    await Promise.all(
      [
        'test/e2e/managed-egress-public-remote.e2e.test.mjs',
        'test/helpers/ssh-alias.mjs',
        'test/harness.mjs',
        'src/server.mjs',
        'src/lib/admin/backup-service.mjs',
        'src/lib/admin/backup-core.mjs',
        'src/lib/vm/managed-egress-host.mjs',
        'src/lib/admin/panel-routes.mjs',
        'src/lib/cluster/cluster-routes.mjs',
        'src/lib/cluster/cluster-manager.mjs',
        'src/lib/cluster/node-edit.mjs',
        'src/lib/cluster/placement.mjs',
        'src/lib/cluster/remote-slot.mjs',
        'src/lib/cluster/remote-slot-files.mjs',
        'src/lib/cluster/remote-fs.mjs',
        'src/lib/cluster/slot-image.mjs',
        'src/lib/cluster/managed-egress-hosts.mjs',
        'src/lib/cluster/managed-egress-runtime.mjs',
        'src/lib/vm/managed-egress-binding.mjs',
        'src/lib/vm/slot-recovery.mjs',
        'src/lib/vm/proxy-pool.mjs',
        'src/lib/identity/workstation-fingerprint.mjs',
        'src/lib/identity/slot-computer.mjs',
        'src/lib/vm/vm-runtime.mjs',
        'src/lib/oauth/oauth-credentials.mjs',
        'deploy/payload.json',
        'test/fixtures/managed-egress-linux.Dockerfile',
      ].map(async (file) => [
        file,
        createHash('sha256')
          .update(await readFile(file))
          .digest('hex'),
      ]),
    ),
  )
  await receipt(result)
  if (rebootEvidence)
    await writeFile(path.join(path.dirname(artifact), 'host-reboot-receipt.json'), JSON.stringify(result, null, 2))
})
