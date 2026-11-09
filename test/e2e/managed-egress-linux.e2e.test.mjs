import test from 'node:test'
import assert from 'node:assert/strict'
import { execFile, execFileSync, spawn } from 'node:child_process'
import { promisify } from 'node:util'
import { createHash, randomBytes } from 'node:crypto'
import { mkdtemp, mkdir, readFile, writeFile, rm, stat, symlink, readdir } from 'node:fs/promises'
import { tmpdir, networkInterfaces } from 'node:os'
import path from 'node:path'
import net from 'node:net'
import http from 'node:http'
import dgram from 'node:dgram'
import { DatabaseSync } from 'node:sqlite'
import { once } from 'node:events'
import { createDatabase } from '../../src/lib/db/database.mjs'
import { ManagedEgressHost } from '../../src/lib/vm/managed-egress-host.mjs'
import { ManagedEgressDocker, MANAGED_EGRESS_IMAGE } from '../../src/lib/vm/managed-egress-docker.mjs'
import { managedEgressConfig } from '../../src/lib/vm/managed-egress-config.mjs'
import {
  setManagedEgressReady,
  registerManagedEgressEndpoint,
  unregisterManagedEgressEndpoint,
} from '../../src/lib/vm/managed-egress-readiness.mjs'
import { acquireManagedDrain, EgressDrainClient } from '../../src/lib/vm/managed-egress-drain.mjs'
import { ensureProxyEgress, stopProxyEgress, egressRunDir, networkName } from '../../src/lib/vm/egress.mjs'
import { egressPidsForProxyConfig, egressPidActive } from '../../src/lib/vm/egress.mjs'
import { reserveAbsentManagedHelper } from '../../src/lib/vm/managed-egress-helper-absence.mjs'
import { withManagedEgressMaintenance } from '../../src/lib/vm/managed-egress-admission.mjs'
import { ProxyPool } from '../../src/lib/vm/proxy-pool.mjs'
import { RemoteManagedEgressHosts } from '../../src/lib/cluster/managed-egress-hosts.mjs'
import { makeProxyFetch } from '../../src/lib/protocol/codex-models.mjs'
import { startControlledSsh } from '../helpers/controlled-ssh.mjs'
import { sshDocker } from '../../src/lib/cluster/docker-remote.mjs'
import { ensureRemoteEgress, releaseRemoteEgress } from '../../src/lib/cluster/remote-slot.mjs'
import { execCollect } from '../../src/lib/cluster/ssh-link.mjs'
import { openSftp, writeRemoteFile, shellQuote } from '../../src/lib/cluster/remote-fs.mjs'
import { startRemoteEgressDrain } from '../../src/lib/cluster/managed-egress-drain.mjs'
import { resolveImportProxy } from '../../src/lib/vm/proxy-resolve.mjs'
import { startGateway, seedVm, api } from '../harness.mjs'
import { containerName } from '../../src/lib/vm/vm-runtime.mjs'
import { slotExec } from '../../src/lib/vm/slot-runtime.mjs'
import { rustKernelHealth, rustKernelProcessUp } from '../../src/lib/transport/rust-kernel-client.mjs'

const execute = promisify(execFile)
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const packageReplay = process.env.MANAGED_EGRESS_PACKAGE_REPLAY === '1'
const artifact = path.resolve(
  `.tmp/managed-egress-e2e/${packageReplay ? 'package-runtime-replay' : 'linux'}-receipt.json`,
)
const command =
  'MANAGED_EGRESS_LINUX_E2E=1 MANAGED_EGRESS_FULL_SLOT_PAYLOAD=<payload> MANAGED_EGRESS_SLOT_IMAGE=<local-image> MANAGED_EGRESS_ORIGIN_HOST=<host-IPv4> SING_BOX_BIN=<binary> KIN_EGRESS_TEST_BIN=<binary> node --test test/e2e/managed-egress-linux.e2e.test.mjs'
async function receipt(value) {
  await mkdir(path.dirname(artifact), { recursive: true })
  const target = value.status === 'NOT RUN' ? artifact.replace('-receipt.json', '-not-run-receipt.json') : artifact
  await writeFile(target, JSON.stringify(value, null, 2))
}
async function freePort(udp = false) {
  const socket = udp ? dgram.createSocket('udp4') : net.createServer()
  await new Promise((resolve) => (udp ? socket.bind(0, '127.0.0.1', resolve) : socket.listen(0, '127.0.0.1', resolve)))
  const port = socket.address().port
  await new Promise((resolve) => socket.close(resolve))
  return port
}
async function stop(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return
  await new Promise((resolve) => {
    child.once('exit', resolve)
    child.kill('SIGTERM')
  })
}

test('Linux containers use two managed Hysteria exits through real transparent helpers', {
  timeout: 480000,
}, async (t) => {
  const enabled = process.env.MANAGED_EGRESS_LINUX_E2E === '1'
  if (!enabled || process.platform !== 'linux') {
    const reason = !enabled ? 'explicit Linux acceptance opt-in is absent' : 'the test runner is not Linux'
    await receipt({
      status: 'NOT RUN',
      reason,
      environment: `${process.platform}/${process.arch}`,
      command,
    })
    t.skip(reason)
    return
  }
  const binary = process.env.SING_BOX_BIN
  const helper = process.env.KIN_EGRESS_TEST_BIN
  const slotImage = process.env.MANAGED_EGRESS_SLOT_IMAGE
  const originHost = process.env.MANAGED_EGRESS_ORIGIN_HOST
  const payloadRoot = process.env.MANAGED_EGRESS_FULL_SLOT_PAYLOAD
  const guestImage = 'ghcr.io/dofastted/kin-os-ubuntu:24.04'
  await receipt({
    status: 'NOT RUN',
    reason: 'Linux prerequisites have not passed',
    environment: `${process.platform}/${process.arch}`,
  })
  assert.ok(binary && helper && slotImage, 'native binaries and an existing local slot image are required')
  assert.ok(payloadRoot, 'manifest-verified full slot payload is required')
  execFileSync(process.execPath, ['scripts/fetch-payload.mjs', '--check', '--dest', payloadRoot], { stdio: 'pipe' })
  assert.equal(net.isIPv4(originHost || ''), true, "origin host must be this Linux host's non-loopback IPv4 address")
  assert.ok(!originHost.startsWith('127.'), 'container loopback cannot identify the Linux host')
  assert.ok(
    Object.values(networkInterfaces())
      .flat()
      .some((address) => address && !address.internal && address.address === originHost),
    'origin address must belong to this Linux host',
  )
  assert.equal(process.getuid(), 0, 'this test changes only its own iptables chains and requires root')
  const docker = async (args) => {
    try {
      return (await execute('docker', args, { timeout: 45000, maxBuffer: 1024 * 1024 })).stdout.trim()
    } catch {
      throw new Error('controlled_linux_docker_failed')
    }
  }
  await docker(['info', '--format', '{{.OSType}}']).then((value) => assert.equal(value, 'linux'))
  const context = JSON.parse(await docker(['context', 'inspect']))[0]
  assert.match(
    process.env.DOCKER_HOST || context.Endpoints.docker.Host,
    /^unix:/,
    'the native helper and Docker daemon must share this Linux host',
  )
  // Never pull arbitrary slot images as a side effect. The caller selects an existing image.
  const slotMetadata = JSON.parse(await docker(['image', 'inspect', slotImage]))[0]
  const guestMetadata = JSON.parse(await docker(['image', 'inspect', guestImage]))[0]
  assert.equal(guestMetadata.Architecture, 'amd64')
  assert.ok(slotMetadata?.Id?.startsWith('sha256:'))
  assert.match(execFileSync(binary, ['version'], { encoding: 'utf8' }), /sing-box version 1\.12\.0/)
  const nonce = randomBytes(5).toString('hex')
  const project = `me-e2e-${nonce}`
  const dir = await mkdtemp(path.join(tmpdir(), `${project}-`))
  // Native helper sockets must fit sockaddr_un even when Docker volume paths are long.
  const helperRoot = await mkdtemp('/tmp/me-helper-')
  const configDir = path.join(dir, 'managed-egress')
  const containers = []
  const children = []
  const exits = []
  const networks = []
  const ownedExits = []
  let db
  let remoteHosts
  let remoteSsh
  let remoteHost
  let remoteNodeId
  let remotePool
  let remoteRoot
  let remoteRootCreated = false
  let remoteSession
  let apiGateway
  let apiRoot
  let apiProject
  const apiExitIds = []
  const apiSlotIds = []
  let fullSlotHealth
  let apiOwnLocal = false
  const remoteNetworks = []
  const remoteTraffic = []
  const remoteVmHosts = new Map()
  let releaseHeld
  let heldStarted
  let signalHeld
  const origin = http.createServer((req, res) => {
    const index = ['127.0.0.2', '127.0.0.3'].indexOf(req.socket.remoteAddress)
    if (req.url === '/credential') {
      req.resume()
      req.on('end', () =>
        res.end(JSON.stringify({ source: req.socket.remoteAddress, received: req.method === 'POST' })),
      )
      return
    }
    if (req.url === '/source') {
      res.end(req.socket.remoteAddress)
      return
    }
    if (req.url === '/geo') {
      res.end(JSON.stringify({ query: req.socket.remoteAddress }))
      return
    }
    if (req.url === '/held') {
      res.write(`exit-${index}:`)
      releaseHeld = () => res.end('finished')
      signalHeld?.()
      return
    }
    res.end(`exit-${index}`)
  })
  const previousGeo = process.env.KIN_PROXY_GEO_URL
  try {
    await mkdir(configDir, { mode: 0o700 })
    await writeFile(path.join(configDir, 'config.json'), JSON.stringify(managedEgressConfig([])), { mode: 0o600 })
    await new Promise((resolve) => origin.listen(0, '0.0.0.0', resolve))
    const originPort = origin.address().port
    process.env.KIN_PROXY_GEO_URL = `http://127.0.0.1:${originPort}/geo`
    execFileSync(
      'openssl',
      [
        'req',
        '-x509',
        '-newkey',
        'rsa:2048',
        '-nodes',
        '-keyout',
        path.join(dir, 'key.pem'),
        '-out',
        path.join(dir, 'cert.pem'),
        '-days',
        '1',
        '-subj',
        '/CN=localhost',
      ],
      { stdio: 'ignore' },
    )
    for (let i = 0; i < 2; i++) {
      const port = await freePort(true)
      const file = path.join(dir, `upstream-${i}.json`)
      await writeFile(
        file,
        JSON.stringify({
          log: { disabled: true },
          inbounds: [
            {
              type: 'hysteria2',
              listen: '127.0.0.1',
              listen_port: port,
              users: [{ password: `controlled-${nonce}-${i}` }],
              tls: { enabled: true, certificate_path: path.join(dir, 'cert.pem'), key_path: path.join(dir, 'key.pem') },
            },
          ],
          outbounds: [{ type: 'direct', inet4_bind_address: `127.0.0.${i + 2}` }],
        }),
        { mode: 0o600 },
      )
      execFileSync(binary, ['check', '-c', file], { stdio: 'pipe' })
      const child = spawn(binary, ['run', '-c', file], { stdio: 'ignore' })
      children.push(child)
      exits.push({
        id: `px-${nonce}-${i}`,
        protocol: 'hysteria2',
        port: await freePort(),
        username: 'controlled-listener',
        password: `listener-${nonce}-${i}`,
        config: { server: '127.0.0.1', server_port: port, password: `controlled-${nonce}-${i}`, insecure: true },
      })
    }
    await delay(200)
    // This container supplies real Docker mount/Compose identity, not a running API.
    const control = `${project}-control`
    await docker([
      'create',
      '--name',
      control,
      '--label',
      `com.docker.compose.project=${project}`,
      '--label',
      `vm2api.e2e.owner=${nonce}`,
      '--network',
      'host',
      '--volume',
      `${dir}:${dir}:rw`,
      MANAGED_EGRESS_IMAGE,
      'check',
      '-c',
      path.join(configDir, 'config.json'),
    ])
    containers.push(control)
    const service = `${project}-sing-box`
    await docker([
      'run',
      '-d',
      '--name',
      service,
      '--label',
      `com.docker.compose.project=${project}`,
      '--label',
      'com.docker.compose.service=sing-box',
      '--label',
      `vm2api.e2e.owner=${nonce}`,
      '--network',
      'host',
      '--cap-drop',
      'ALL',
      '--security-opt',
      'no-new-privileges',
      '--read-only',
      '--volume',
      `${configDir}:/var/lib/vm2api-egress:ro`,
      MANAGED_EGRESS_IMAGE,
      'run',
      '-c',
      '/var/lib/vm2api-egress/config.json',
    ])
    containers.push(service)
    db = createDatabase({ dbPath: path.join(dir, 'host.db') })
    const runtime = new ManagedEgressDocker({ configDir, controlContainer: control })
    const manager = new ManagedEgressHost({
      db,
      hostId: 'control-plane',
      configDir,
      runtime,
      acquireDrain: async ({ recovery = false } = {}) => {
        const reservations = []
        const lease = await acquireManagedDrain({
          ids: exits.map((exit) => exit.id),
          helpers: async () => {
            const controls = []
            for (let index = 0; index < networks.length; index++) {
              const id = exits[index].id
              const pids = egressPidsForProxyConfig(helperRoot, id)
              assert.ok(pids.length <= 1, 'helper identity must be unambiguous')
              if (!pids.length) {
                assert.equal(recovery, true, 'absence proof is recovery-only')
                const dir = egressRunDir(helperRoot, id)
                reservations.push(
                  await reserveAbsentManagedHelper({
                    id,
                    configFile: path.join(dir, 'egress.json'),
                    pidFile: path.join(dir, 'egress.pid'),
                  }),
                )
                continue
              }
              controls.push(
                new EgressDrainClient({
                  id: exits[index].id,
                  socketPath: path.join(egressRunDir(helperRoot, exits[index].id), 'drain.sock'),
                }),
              )
            }
            return controls
          },
        })
        return {
          wait: (timeout) => lease.wait(timeout),
          release: async (options) => {
            try {
              await lease.release(options)
            } finally {
              await Promise.all(reservations.map((proof) => proof.close()))
            }
          },
        }
      },
    })
    assert.equal((await manager.apply(exits)).error, null)
    for (let i = 0; i < exits.length; i++) {
      const exit = exits[i]
      registerManagedEgressEndpoint(exit.id, '127.0.0.1', exit.port)
      setManagedEgressReady(exit.id, true)
      assert.equal(
        await docker(['network', 'ls', '--filter', `name=^${networkName(exit.id)}$`, '--format', '{{.Name}}']),
        '',
        'test network must not already exist',
      )
      ownedExits.push(exit)
      const network = await ensureProxyEgress(
        helperRoot,
        { ...exit, host: '127.0.0.1', managed: true },
        { bin: helper },
      )
      assert.equal(network.ok, true, `real helper/network setup must succeed: ${network.error || 'unreported failure'}`)
      networks.push(network)
      assert.ok(
        !originHost.startsWith(network.gateway.split('.').slice(0, 3).join('.') + '.'),
        'origin must be outside the proxy bridge subnet',
      )
      const name = `${project}-slot-${i}`
      await docker([
        'run',
        '-d',
        '--pull=never',
        '--name',
        name,
        '--label',
        `vm2api.e2e.owner=${nonce}`,
        '--network',
        network.network,
        '--entrypoint',
        '/bin/sh',
        slotImage,
        '-c',
        'exec sleep 600',
      ])
      containers.push(name)
    }
    const request = (index, route = '/', timeout = '5') =>
      docker([
        'exec',
        `${project}-slot-${index}`,
        'curl',
        '--silent',
        '--show-error',
        '--fail',
        '--noproxy',
        '*',
        '--connect-timeout',
        '2',
        '--max-time',
        timeout,
        `http://${originHost}:${originPort}${route}`,
      ])
    const observedIPs = []
    for (let i = 0; i < 2; i++) {
      assert.equal(await request(i), `exit-${i}`)
      const observed = await request(i, '/source')
      assert.equal(observed, `127.0.0.${i + 2}`)
      observedIPs.push(observed)
    }
    const started = () => docker(['inspect', service, '--format', '{{.State.StartedAt}}'])
    heldStarted = new Promise((resolve) => {
      signalHeld = resolve
    })
    const held = request(0, '/held', '30')
    void held.catch(() => {})
    await Promise.race([
      heldStarted,
      held.then(() => {
        throw new Error('controlled held response ended early')
      }),
    ])
    const before = await started()
    const timeout = await manager.apply(exits, { drainTimeoutMs: 100 })
    assert.equal(timeout.error, 'managed_drain_timeout')
    assert.equal(await started(), before)
    let applied = false
    const applying = manager.apply(exits).then((state) => {
      applied = true
      return state
    })
    await delay(200)
    assert.equal(applied, false)
    releaseHeld()
    assert.equal(await held, 'exit-0:finished')
    assert.equal((await applying).error, null)
    assert.notEqual(await started(), before)
    await stop(children[0])
    await assert.rejects(request(0))
    assert.equal(await request(1), 'exit-1')
    const restored = spawn(binary, ['run', '-c', path.join(dir, 'upstream-0.json')], { stdio: 'ignore' })
    children.push(restored)
    await delay(200)
    await docker(['stop', '--time', '2', service])
    for (let i = 0; i < 2; i++) await assert.rejects(request(i))
    assert.equal((await manager.recover()).status, 'ready')
    for (const exit of exits) setManagedEgressReady(exit.id, true)
    for (let i = 0; i < 2; i++) assert.equal(await request(i), `exit-${i}`)
    await docker(['stop', '--time', '2', service])
    const firstControl = path.join(egressRunDir(helperRoot, exits[0].id), 'drain.sock')
    const liveSocket = await stat(firstControl)
    assert.throws(() =>
      execFileSync(helper, ['-config', path.join(egressRunDir(helperRoot, exits[0].id), 'egress.json')], {
        timeout: 2000,
        stdio: 'pipe',
      }),
    )
    assert.equal(
      (await stat(firstControl)).ino,
      liveSocket.ino,
      'a duplicate helper must preserve the live control socket',
    )
    for (let index = 0; index < networks.length; index++) {
      const pid = networks[index].pid
      assert.deepEqual(egressPidsForProxyConfig(helperRoot, exits[index].id), [pid])
      process.kill(pid, 'SIGKILL')
      for (let attempt = 0; attempt < 100 && egressPidActive(pid); attempt++) await delay(10)
      assert.equal(egressPidActive(pid), false)
      setManagedEgressReady(exits[index].id, false)
    }
    assert.equal((await manager.recover()).status, 'ready')
    for (let index = 0; index < exits.length; index++) {
      const proxy = { ...exits[index], host: '127.0.0.1', managed: true }
      const repaired = await withManagedEgressMaintenance(proxy, () =>
        ensureProxyEgress(helperRoot, proxy, { bin: helper }),
      )
      assert.equal(repaired.ok, true, `crashed helper must rebuild: ${repaired.error || ''}`)
      networks[index] = repaired
      setManagedEgressReady(proxy.id, true)
      assert.equal(await request(index), `exit-${index}`)
    }
    // Exercise the complete HTTP bind route with real runtime/helper setup.
    // Inference remains mocked; no full gateway VM is started by this fixture.
    apiProject = path.join(dir, 'api')
    apiRoot = `/tmp/me-api-${nonce}`
    await mkdir(path.join(apiProject, 'data/managed-egress'), { recursive: true, mode: 0o700 })
    await symlink(apiProject, apiRoot)
    const apiConfig = path.join(apiProject, 'data/managed-egress/config.json')
    await writeFile(apiConfig, JSON.stringify(managedEgressConfig([])), { mode: 0o600 })
    const apiControl = `${project}-api-control`
    const apiService = `${project}-api-sing-box`
    await docker([
      'create',
      '--name',
      apiControl,
      '--label',
      `com.docker.compose.project=${project}-api`,
      '--label',
      `vm2api.e2e.owner=${nonce}`,
      '--network',
      'host',
      '--volume',
      `${apiProject}:${apiRoot}:rw`,
      MANAGED_EGRESS_IMAGE,
      'check',
      '-c',
      `${apiRoot}/data/managed-egress/config.json`,
    ])
    containers.push(apiControl)
    await docker([
      'run',
      '-d',
      '--name',
      apiService,
      '--label',
      `com.docker.compose.project=${project}-api`,
      '--label',
      'com.docker.compose.service=sing-box',
      '--label',
      `vm2api.e2e.owner=${nonce}`,
      '--network',
      'host',
      '--cap-drop',
      'ALL',
      '--security-opt',
      'no-new-privileges',
      '--read-only',
      '--volume',
      `${path.dirname(apiConfig)}:/var/lib/vm2api-egress:ro`,
      MANAGED_EGRESS_IMAGE,
      'run',
      '-c',
      '/var/lib/vm2api-egress/config.json',
    ])
    containers.push(apiService)
    const apiVmId = `vm-api-${nonce}`
    const apiVm = seedVm({ project: apiRoot, id: apiVmId, oauth: false })
    await writeFile(
      path.join(apiRoot, 'vms', `${apiVmId}.json`),
      JSON.stringify({ ...apiVm, policy: { ...apiVm.policy, sessionSlots: 1 }, proxy: null, status: 'stopped' }),
    )
    await docker([
      'run',
      '--rm',
      '--pull=never',
      '--platform',
      'linux/amd64',
      '--network',
      'none',
      '--read-only',
      '--tmpfs',
      '/tmp:rw,exec,nosuid,size=128m',
      '--user',
      '0:0',
      '--volume',
      `${apiProject}:${apiRoot}:rw`,
      '--volume',
      `${payloadRoot}:${payloadRoot}:ro`,
      '--entrypoint',
      `${payloadRoot}/bin/kin-computer`,
      guestImage,
      'create',
      '--runtime',
      'docker',
      '--vm-id',
      apiVmId,
      '--out',
      `${apiRoot}/vms/${apiVmId}/kvm/fingerprint`,
    ])
    assert.equal(
      await docker(['network', 'ls', '--filter', `name=^${networkName('px-local')}$`, '--format', '{{.Name}}']),
      '',
    )
    apiOwnLocal = true
    const apiHelper = path.join(apiRoot, 'kin-egress')
    await symlink(helper, apiHelper)
    await mkdir(path.join(apiRoot, 'config'), { recursive: true })
    const apiRouting = JSON.parse(await readFile('src/config/routing.json', 'utf8'))
    apiRouting.inference = { ...apiRouting.inference, session_slots: 1 }
    await writeFile(path.join(apiRoot, 'config/routing.json'), JSON.stringify(apiRouting))
    const apiGatewayOptions = {
      project: apiRoot,
      env: {
        VM2API_CONTAINER_NAME: apiControl,
        KIN_EGRESS_BIN: apiHelper,
        KIN_KERNEL_BIN: `${payloadRoot}/bin/kin-kernel`,
        KIN_WORKER_BIN: `${payloadRoot}/bin/kin-worker`,
        KIN_OAUTH_AUTH_BIN: `${payloadRoot}/bin/kin-oauth-auth`,
        KIN_COMPUTER_BIN: `${payloadRoot}/bin/kin-computer`,
        KIN_WRAP_CLI_ROOT: `${payloadRoot}/share/wrap-cli`,
      },
    }
    apiGateway = await startGateway(apiGatewayOptions)
    const httpImported = await api(apiGateway, 'POST', '/api/panel/proxies/import', {
      body: { protocol: 'hysteria2', config: exits[0].config },
    })
    assert.equal(httpImported.status, 200, 'the real gateway must import the controlled exit')
    const httpId = (httpImported.json.data || httpImported.json).items[0].id
    apiExitIds.push(httpId)
    const importedData = httpImported.json.data || httpImported.json
    assert.equal(importedData.application_status, 'applied', 'import must apply without a second request')
    assert.equal(importedData.items[0].blocked_reason, null)
    assert.equal(importedData.items[0].exit_status, 'ready')
    const initialProbe = await api(apiGateway, 'POST', `/api/panel/proxies/${httpId}/probe`)
    assert.equal((initialProbe.json.data || initialProbe.json).probe.ok, true)
    const probeHelperDir = egressRunDir(apiRoot, httpId)
    const probeHelperConfig = JSON.parse(await readFile(path.join(probeHelperDir, 'egress.json'), 'utf8'))
    assert.equal(
      probeHelperConfig.control_socket,
      path.join(probeHelperDir, 'drain.sock'),
      'manual probe must preserve managed helper control before periodic inspection',
    )
    assert.equal(
      (
        await new EgressDrainClient({ id: httpId, socketPath: probeHelperConfig.control_socket }).request(
          'GET',
          '/status',
        )
      ).paused,
      false,
    )
    await delay(17000)
    const afterMonitor = (await api(apiGateway, 'GET', '/api/panel/proxies')).json.data.proxies.find(
      (p) => p.id === httpId,
    )
    assert.equal(afterMonitor.blocked_reason, null, 'manual probe must stay ready after monitor')
    assert.equal(afterMonitor.observed_ip, '127.0.0.2')
    const probeGeo = await api(apiGateway, 'POST', `/api/panel/proxies/${httpId}/geo`)
    assert.equal(probeGeo.status, 200, 'geolocation must remain available after manual probe and monitor')
    assert.equal((probeGeo.json.data || probeGeo.json).geo.ip, '127.0.0.2')
    const missingSlot = await api(apiGateway, 'POST', `/api/panel/proxies/${httpId}/bind`, {
      body: { vm_id: 'absent-slot' },
    })
    assert.equal(missingSlot.status, 400)
    const httpBound = await api(apiGateway, 'POST', `/api/panel/proxies/${httpId}/bind`, { body: { vm_id: apiVmId } })
    assert.equal(
      httpBound.status,
      200,
      `the real gateway must initialize the bound helper: ${httpBound.json?.error?.code || ''}`,
    )
    const httpProxy = (httpBound.json.data || httpBound.json).proxy
    assert.ok(httpProxy.bound_vm_ids.includes(apiVmId))
    assert.equal(httpProxy.exit_status, 'ready')
    assert.equal(httpProxy.blocked_reason, null)
    assert.equal(httpProxy.username, undefined)
    assert.equal(httpProxy.password, undefined)
    const httpTraffic = `${project}-api-traffic`
    await docker([
      'run',
      '--rm',
      '--pull=never',
      '--name',
      httpTraffic,
      '--label',
      `vm2api.e2e.owner=${nonce}`,
      '--network',
      networkName(httpId),
      '--entrypoint',
      'curl',
      slotImage,
      '--silent',
      '--show-error',
      '--fail',
      '--noproxy',
      '*',
      '--connect-timeout',
      '2',
      '--max-time',
      '15',
      `http://${originHost}:${originPort}/source`,
    ]).then((actual) =>
      assert.equal(actual, '127.0.0.2', 'HTTP binding must initialize the selected transparent route'),
    )
    stopProxyEgress(apiRoot, httpId)
    for (let attempt = 0; attempt < 100 && egressPidsForProxyConfig(apiRoot, httpId).length; attempt++) await delay(20)
    assert.equal(
      egressPidsForProxyConfig(apiRoot, httpId).length,
      0,
      'the test-owned helper must exit before failure injection',
    )
    await rm(apiHelper)
    const httpFailed = await api(apiGateway, 'POST', `/api/panel/proxies/${httpId}/bind`, { body: { vm_id: apiVmId } })
    assert.equal(httpFailed.status, 400)
    assert.equal(httpFailed.json.error.details.binding_committed, true)
    assert.equal(httpFailed.json.error.details.proxy.exit_status, 'unavailable')
    await symlink(helper, apiHelper)
    const httpRetried = await api(apiGateway, 'POST', `/api/panel/proxies/${httpId}/bind`, { body: { vm_id: apiVmId } })
    assert.equal(httpRetried.status, 200, 'the HTTP route must retry a retained failed binding')
    assert.equal((httpRetried.json.data || httpRetried.json).proxy.exit_status, 'ready')
    await docker([
      'run',
      '--rm',
      '--pull=never',
      '--name',
      httpTraffic,
      '--label',
      `vm2api.e2e.owner=${nonce}`,
      '--network',
      networkName(httpId),
      '--entrypoint',
      'curl',
      slotImage,
      '--silent',
      '--show-error',
      '--fail',
      '--noproxy',
      '*',
      '--connect-timeout',
      '2',
      '--max-time',
      '15',
      `http://${originHost}:${originPort}/source`,
    ]).then((actual) => assert.equal(actual, '127.0.0.2', 'the retried HTTP binding must restore the selected route'))
    const actualSlot = containerName(apiVmId)
    assert.equal(await docker(['ps', '-aq', '--filter', `name=^${actualSlot}$`]), '')
    apiSlotIds.push(apiVmId)
    const startedSlot = await api(apiGateway, 'POST', `/api/panel/vms/${apiVmId}/start`)
    assert.equal(startedSlot.status, 200, `real slot startup must succeed: ${startedSlot.json?.error?.message || ''}`)
    const slotInfo = JSON.parse(await docker(['inspect', actualSlot]))[0]
    assert.equal(slotInfo.State.Running, true)
    assert.equal(slotInfo.Config.Labels['kin.vm.id'], apiVmId)
    assert.equal(slotInfo.Config.Image, guestImage)
    assert.equal(slotInfo.Image, guestMetadata.Id)
    assert.equal(slotInfo.HostConfig.NetworkMode, networkName(httpId))
    assert.equal(slotInfo.Config.Cmd.includes('--gateway-worker'), true)
    async function verifyActualKernel(vmId = apiVmId) {
      const currentSlot = containerName(vmId)
      const actualRecord = JSON.parse(await readFile(path.join(apiRoot, 'vms', `${vmId}.json`), 'utf8'))
      assert.ok(actualRecord.runtime.worker_run_dir, 'verified startup must persist the runtime directory')
      assert.ok(actualRecord.runtime.kernel_socket, 'verified startup must persist the kernel socket')
      const healthDeadline = Date.now() + 30000
      while (Date.now() < healthDeadline) {
        fullSlotHealth = await rustKernelHealth(slotExec(apiRoot, actualRecord), { timeoutMs: 1000 })
        if (Number(fullSlotHealth.status) === 200) break
        await delay(250)
      }
      if (Number(fullSlotHealth.status) !== 200) {
        const current = JSON.parse(await docker(['inspect', currentSlot]))[0]
        const logs = await execute('docker', ['logs', '--tail', '12', currentSlot], { maxBuffer: 65536 }).then(
          ({ stdout, stderr }) => `${stdout}\n${stderr}`,
          () => 'kernel logs unavailable',
        )
        const redacted = logs
          .replace(/socks5h?:\/\/[^\s]+/g, '[redacted-proxy]')
          .replace(/[a-fA-F0-9]{32,}/g, '[redacted-token]')
        throw new Error(
          `actual kernel health unavailable: ${JSON.stringify({ running: current.State.Running, exit: current.State.ExitCode, restarts: current.RestartCount, error: fullSlotHealth.error || null, logs: redacted.slice(0, 2000) })}`,
        )
      }
      assert.equal(rustKernelProcessUp(fullSlotHealth), true)
      assert.ok(!String(fullSlotHealth.source || '').includes('mock'))
    }
    await verifyActualKernel()
    assert.equal(
      await docker([
        'exec',
        actualSlot,
        'curl',
        '--silent',
        '--show-error',
        '--fail',
        '--noproxy',
        '*',
        '--max-time',
        '15',
        `http://${originHost}:${originPort}/source`,
      ]),
      '127.0.0.2',
    )
    assert.equal((await api(apiGateway, 'POST', `/api/panel/vms/${apiVmId}/stop`)).status, 200)
    const restartedSlot = await api(apiGateway, 'POST', `/api/panel/vms/${apiVmId}/start`)
    assert.equal(
      restartedSlot.status,
      200,
      `real slot restart must succeed: ${restartedSlot.json?.error?.message || ''}`,
    )
    assert.equal(
      await docker([
        'exec',
        actualSlot,
        'curl',
        '--silent',
        '--show-error',
        '--fail',
        '--noproxy',
        '*',
        '--max-time',
        '15',
        `http://${originHost}:${originPort}/source`,
      ]),
      '127.0.0.2',
    )
    assert.equal((await api(apiGateway, 'POST', `/api/panel/vms/${apiVmId}/stop`)).status, 200)
    stopProxyEgress(apiRoot, httpId)
    for (let attempt = 0; attempt < 100 && egressPidsForProxyConfig(apiRoot, httpId).length; attempt++) await delay(20)
    assert.equal(egressPidsForProxyConfig(apiRoot, httpId).length, 0)
    await rm(apiHelper)
    const failedBeforeStart = await api(apiGateway, 'POST', `/api/panel/proxies/${httpId}/bind`, {
      body: { vm_id: apiVmId },
    })
    assert.equal(failedBeforeStart.status, 400)
    assert.equal(failedBeforeStart.json.error.details.binding_committed, true)
    await symlink(helper, apiHelper)
    const repairedStart = await api(apiGateway, 'POST', `/api/panel/vms/${apiVmId}/start`)
    assert.equal(
      repairedStart.status,
      200,
      `start must initialize the retained managed binding: ${repairedStart.json?.error?.message || ''}`,
    )
    await verifyActualKernel()
    assert.equal(JSON.parse(await readFile(path.join(apiRoot, 'vms', `${apiVmId}.json`), 'utf8')).proxy.id, httpId)
    assert.equal(
      await docker([
        'exec',
        actualSlot,
        'curl',
        '--silent',
        '--show-error',
        '--fail',
        '--noproxy',
        '*',
        '--max-time',
        '15',
        `http://${originHost}:${originPort}/source`,
      ]),
      '127.0.0.2',
    )
    assert.equal((await api(apiGateway, 'POST', `/api/panel/vms/${apiVmId}/stop`)).status, 200)
    const factoryExit = await api(apiGateway, 'POST', '/api/panel/proxies/import', {
      body: { protocol: 'hysteria2', config: exits[1].config },
    })
    assert.equal(factoryExit.status, 200)
    const factoryExitId = (factoryExit.json.data || factoryExit.json).items[0].id
    apiExitIds.push(factoryExitId)
    assert.equal((await api(apiGateway, 'POST', '/api/panel/proxies/apply')).status, 200)
    const factoryId = `vm-factory-${nonce}`
    assert.equal(await docker(['ps', '-aq', '--filter', `name=^${containerName(factoryId)}$`]), '')
    apiSlotIds.push(factoryId)
    const created = await api(apiGateway, 'POST', '/api/panel/vms/create', {
      body: {
        id: factoryId,
        kernel: 'ubuntu-24.04',
        runtime_type: 'docker',
        proxy_id: factoryExitId,
        proxy_cli_enabled: true,
        start: true,
      },
    })
    assert.equal(created.status, 200, `real factory creation must succeed: ${created.json?.error?.message || ''}`)
    const createdData = created.json.data || created.json
    assert.equal(createdData.proxy_error, undefined)
    assert.equal(createdData.start_error, undefined)
    await verifyActualKernel(factoryId)
    const slotSource = (vmId) =>
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
        '15',
        `http://${originHost}:${originPort}/source`,
      ])
    assert.equal(await slotSource(factoryId), '127.0.0.3')
    if (packageReplay) {
      const recordFile = path.join(apiRoot, 'vms', `${factoryId}.json`)
      const state = async () => {
        const record = JSON.parse(await readFile(recordFile, 'utf8'))
        const info = JSON.parse(await docker(['inspect', containerName(factoryId)]))[0]
        const files = []
        for (const base of ['cli-home', 'cli-home/.claude', 'cli-home/.kin', 'run']) {
          const root = path.join(apiRoot, 'vms', factoryId, base)
          const names = await readdir(root).catch(() => [])
          for (const name of ['', ...names.slice(0, 40)]) {
            const file = path.join(root, name)
            const st = await stat(file).catch(() => null)
            if (st) files.push({ path: `${base}/${name}`, uid: st.uid, gid: st.gid, mode: st.mode & 0o777 })
          }
        }
        const config = JSON.parse(await readFile(path.join(record.runtime.worker_run_dir, 'kernel.json'), 'utf8'))
        return {
          name: record.name,
          user: info.Config.User,
          network: info.HostConfig.NetworkMode,
          worker_run_dir: record.runtime.worker_run_dir,
          kernel_socket: record.runtime.kernel_socket,
          configured_socket: config.socket_path,
          files,
        }
      }
      const before = await state()
      const doc = (await api(apiGateway, 'GET', `/api/panel/vms/${apiVmId}/package`)).json.data
      doc.vm.name = String(Number(before.name) + 7)
      assert.equal((await api(apiGateway, 'POST', `/api/panel/vms/${factoryId}/stop`)).status, 200)
      const written = await api(apiGateway, 'PUT', `/api/panel/vms/${factoryId}/package`, { body: doc })
      assert.equal(written.status, 200)
      assert.equal((await api(apiGateway, 'POST', `/api/panel/vms/${factoryId}/start`)).status, 200)
      const after = await state()
      await mkdir('.tmp/managed-egress-e2e', { recursive: true })
      await writeFile('.tmp/managed-egress-e2e/package-runtime-debug.json', JSON.stringify({ before, after }, null, 2))
      assert.equal(after.user, before.user, 'package traits must preserve the deployed runtime UID')
      await verifyActualKernel(factoryId)
      assert.equal(await slotSource(factoryId), '127.0.0.2')
      await receipt({
        status: 'PASS',
        scope: 'minimal actual package write-back, runtime ownership and selected route',
        before,
        after,
      })
      return
    }
    assert.equal((await api(apiGateway, 'POST', `/api/panel/vms/${apiVmId}/start`)).status, 200)
    await verifyActualKernel()
    assert.equal(await slotSource(apiVmId), '127.0.0.2')
    for (const mode of ['keep', 'traits']) {
      const rebuilt = await api(apiGateway, 'POST', `/api/panel/vms/${factoryId}/reset`, { body: { mode } })
      assert.equal(rebuilt.status, 200, `factory ${mode} rebuild must succeed: ${rebuilt.json?.error?.message || ''}`)
      await verifyActualKernel(factoryId)
      const record = JSON.parse(await readFile(path.join(apiRoot, 'vms', `${factoryId}.json`), 'utf8'))
      assert.equal(record.proxy.id, factoryExitId)
      assert.equal(await slotSource(factoryId), '127.0.0.3')
      assert.equal(await slotSource(apiVmId), '127.0.0.2')
    }
    const failedExit = await api(apiGateway, 'POST', '/api/panel/proxies/import', {
      body: { protocol: 'hysteria2', config: exits[0].config },
    })
    assert.equal(failedExit.status, 200)
    const failedExitId = (failedExit.json.data || failedExit.json).items[0].id
    apiExitIds.push(failedExitId)
    assert.equal((await api(apiGateway, 'POST', '/api/panel/proxies/apply')).status, 200)
    const failedFactoryId = `vm-failed-${nonce}`
    await rm(apiHelper)
    const failedCreated = await api(apiGateway, 'POST', '/api/panel/vms/create', {
      body: {
        id: failedFactoryId,
        platform: 'openai',
        kernel: 'ubuntu-24.04',
        runtime_type: 'docker',
        proxy_id: failedExitId,
        proxy_cli_enabled: true,
        start: false,
      },
    })
    assert.equal(failedCreated.status, 200)
    assert.equal((failedCreated.json.data || failedCreated.json).proxy_error, 'managed_helper_setup_failed')
    assert.equal(
      JSON.parse(await readFile(path.join(apiRoot, 'vms', `${failedFactoryId}.json`), 'utf8')).proxy.id,
      failedExitId,
    )
    await symlink(helper, apiHelper)
    const retriedFactory = await api(apiGateway, 'POST', `/api/panel/proxies/${failedExitId}/bind`, {
      body: { vm_id: failedFactoryId },
    })
    assert.equal(retriedFactory.status, 200, 'stopped Codex binding must initialize its actual transparent helper')
    assert.equal((retriedFactory.json.data || retriedFactory.json).proxy.exit_status, 'ready')
    const autoExit = await api(apiGateway, 'POST', '/api/panel/proxies/import', {
      body: { protocol: 'hysteria2', config: exits[0].config },
    })
    assert.equal(autoExit.status, 200)
    const autoExitId = (autoExit.json.data || autoExit.json).items[0].id
    apiExitIds.push(autoExitId)
    assert.equal((await api(apiGateway, 'POST', '/api/panel/proxies/apply')).status, 200)
    assert.equal(egressPidsForProxyConfig(apiRoot, autoExitId).length, 0)
    // The earlier manual probe makes this used exit preferred over unknown exits.
    assert.equal((await api(apiGateway, 'POST', `/api/panel/proxies/${httpId}/disable`)).status, 200)
    assert.equal((await api(apiGateway, 'POST', '/api/panel/proxies/px-local/disable')).status, 200)
    const autoId = `vm-auto-${nonce}`
    const autoCreated = await api(apiGateway, 'POST', '/api/panel/vms/create', {
      body: { id: autoId, kernel: 'ubuntu-24.04', runtime_type: 'docker', auto_allocate_proxy: true, start: false },
    })
    assert.equal(autoCreated.status, 200)
    const autoData = autoCreated.json.data || autoCreated.json
    assert.equal(autoData.proxy_error, undefined)
    const autoRecord = JSON.parse(await readFile(path.join(apiRoot, 'vms', `${autoId}.json`), 'utf8'))
    assert.equal(autoRecord.proxy.managed, true)
    assert.equal(autoRecord.proxy.id, autoExitId, 'automatic allocation must pick the unused managed exit')
    assert.equal(egressPidsForProxyConfig(apiRoot, autoRecord.proxy.id).length, 1)
    const autoSource = await docker([
      'run',
      '--rm',
      '--pull=never',
      '--label',
      `vm2api.e2e.owner=${nonce}`,
      '--network',
      networkName(autoRecord.proxy.id),
      '--entrypoint',
      'curl',
      slotImage,
      '--silent',
      '--show-error',
      '--fail',
      '--noproxy',
      '*',
      '--max-time',
      '15',
      `http://${originHost}:${originPort}/source`,
    ])
    assert.equal(autoSource, autoRecord.proxy.id === factoryExitId ? '127.0.0.3' : '127.0.0.2')
    assert.equal((await api(apiGateway, 'POST', '/api/panel/proxies/px-local/enable')).status, 200)
    assert.equal((await api(apiGateway, 'POST', `/api/panel/vms/${factoryId}/stop`)).status, 200)
    assert.equal((await api(apiGateway, 'POST', `/api/panel/vms/${apiVmId}/stop`)).status, 200)
    apiSlotIds.push(autoId)
    const savedProxyHash = createHash('sha256').update(JSON.stringify(autoRecord.proxy)).digest('hex')
    async function stopGatewayForRestore() {
      const child = apiGateway.child
      await apiGateway.stop()
      if (child.exitCode === null && child.signalCode === null) await once(child, 'exit')
      apiGateway = null
    }
    await stopGatewayForRestore()
    let restoreDb = new DatabaseSync(path.join(apiRoot, 'data/kin.db'))
    let savedExit
    try {
      savedExit = restoreDb.prepare('SELECT * FROM proxies WHERE id = ?').get(autoExitId)
      assert.ok(savedExit)
      restoreDb.prepare('DELETE FROM proxies WHERE id = ?').run(autoExitId)
    } finally {
      restoreDb.close()
    }
    apiGateway = await startGateway(apiGatewayOptions)
    const missingExitStart = await api(apiGateway, 'POST', `/api/panel/vms/${autoId}/start`)
    assert.equal(missingExitStart.status, 409, 'a missing saved managed exit must not authorize another exit')
    const proxyAfterMissing = JSON.parse(await readFile(path.join(apiRoot, 'vms', `${autoId}.json`), 'utf8')).proxy
    assert.equal(createHash('sha256').update(JSON.stringify(proxyAfterMissing)).digest('hex'), savedProxyHash)
    await stopGatewayForRestore()
    restoreDb = new DatabaseSync(path.join(apiRoot, 'data/kin.db'))
    try {
      const columns = Object.keys(savedExit)
      assert.ok(columns.every((column) => /^[a-z_][a-z0-9_]*$/.test(column)))
      restoreDb
        .prepare(`INSERT INTO proxies (${columns.join(',')}) VALUES (${columns.map(() => '?').join(',')})`)
        .run(
          ...columns.map((column) => (column === 'enabled' ? 0 : column === 'bound_vm_id' ? null : savedExit[column])),
        )
    } finally {
      restoreDb.close()
    }
    apiGateway = await startGateway(apiGatewayOptions)
    const disabledExitStart = await api(apiGateway, 'POST', `/api/panel/vms/${autoId}/start`)
    assert.equal(disabledExitStart.status, 409, 'a disabled saved managed exit must not authorize another exit')
    const proxyAfterDisabled = JSON.parse(await readFile(path.join(apiRoot, 'vms', `${autoId}.json`), 'utf8')).proxy
    assert.equal(createHash('sha256').update(JSON.stringify(proxyAfterDisabled)).digest('hex'), savedProxyHash)
    assert.equal((await api(apiGateway, 'POST', `/api/panel/proxies/${autoExitId}/enable`)).status, 200)
    for (let attempt = 0; attempt < 100; attempt++) {
      const view = await api(apiGateway, 'GET', '/api/panel/proxies')
      const item = (view.json.data || view.json).proxies.find((proxy) => proxy.id === autoExitId)
      if (item?.exit_status === 'ready' && !item.blocked_reason) break
      await delay(200)
    }
    const restoredStart = await api(apiGateway, 'POST', `/api/panel/vms/${autoId}/start`)
    assert.equal(
      restoredStart.status,
      200,
      `restoring the selected exit must allow startup: ${restoredStart.json?.error?.code || ''}`,
    )
    await verifyActualKernel(autoId)
    assert.equal(await slotSource(autoId), '127.0.0.2')
    assert.equal(JSON.parse(await readFile(path.join(apiRoot, 'vms', `${autoId}.json`), 'utf8')).proxy.id, autoExitId)
    assert.equal((await api(apiGateway, 'POST', `/api/panel/vms/${autoId}/stop`)).status, 200)
    const archived = await api(apiGateway, 'POST', '/api/panel/backups')
    assert.equal(archived.status, 201, 'the real archive worker must create a restorable backup')
    assert.ok(archived.json.item.file_name.endsWith('.tar.gz'))
    const changedAfterArchive = await api(apiGateway, 'PUT', `/api/panel/proxies/${autoExitId}`, {
      body: { config: exits[1].config, label: 'after-archive' },
    })
    assert.equal(changedAfterArchive.status, 200)
    assert.equal((await api(apiGateway, 'POST', '/api/panel/proxies/apply')).status, 200)
    const fullRestore = await api(apiGateway, 'POST', `/api/panel/backups/${archived.json.item.id}/restore`, {
      body: { confirm: true },
    })
    assert.equal(fullRestore.status, 200, 'a real archive restore must rebind every managed database holder')
    const restoredPool = (await api(apiGateway, 'GET', '/api/panel/proxies')).json.data
    const restoredExit = restoredPool.proxies.find((proxy) => proxy.id === autoExitId)
    assert.ok(restoredExit.bound_vm_ids.includes(autoId))
    assert.notEqual(restoredExit.label, 'after-archive')
    const mismatchedArchiveStart = await api(apiGateway, 'POST', `/api/panel/vms/${autoId}/start`)
    assert.equal(mismatchedArchiveStart.status, 409, 'restored desired state must refuse the post-backup runtime')
    const restoredApply = await api(apiGateway, 'POST', '/api/panel/proxies/apply')
    assert.equal(restoredApply.status, 200, 'restored managed apply must use the new SQLite handle')
    assert.equal((await api(apiGateway, 'GET', '/api/panel/cluster/nodes')).status, 200)
    assert.equal((await api(apiGateway, 'POST', `/api/panel/vms/${autoId}/start`)).status, 200)
    await verifyActualKernel(autoId)
    assert.equal(await slotSource(autoId), '127.0.0.2')
    assert.equal((await api(apiGateway, 'POST', `/api/panel/vms/${autoId}/stop`)).status, 200)
    const packageExport = await api(apiGateway, 'GET', `/api/panel/vms/${autoId}/package`)
    assert.equal(packageExport.status, 200)
    const packageDoc = packageExport.json.data
    assert.equal(packageDoc.proxy.kind, 'managed')
    assert.equal(packageDoc.proxy.id, autoExitId)
    assert.deepEqual(Object.keys(packageDoc.proxy).sort(), ['host_id', 'id', 'kind', 'label'])
    const packageVmId = `vm-package-${nonce}`
    const previousBindLimit = (await api(apiGateway, 'GET', '/api/panel/proxies/config')).json.data.bind_limit
    assert.equal((await api(apiGateway, 'PUT', '/api/panel/proxies/config', { body: { bind_limit: 1 } })).status, 200)
    const packageQuota = await api(apiGateway, 'POST', '/api/panel/vms/package', {
      body: { ...packageDoc, vm: { ...packageDoc.vm, id: packageVmId } },
    })
    assert.equal(packageQuota.status, 409)
    assert.equal(packageQuota.json.error.code, 'proxy_bind_limit')
    await assert.rejects(stat(path.join(apiRoot, 'vms', packageVmId)), { code: 'ENOENT' })
    assert.equal(
      (await api(apiGateway, 'PUT', '/api/panel/proxies/config', { body: { bind_limit: previousBindLimit } })).status,
      200,
    )
    apiSlotIds.push(packageVmId)
    const packageCreated = await api(apiGateway, 'POST', '/api/panel/vms/package', {
      body: { ...packageDoc, vm: { ...packageDoc.vm, id: packageVmId } },
    })
    assert.equal(packageCreated.status, 201, `managed package creation: ${packageCreated.json?.error?.code || ''}`)
    assert.equal(packageCreated.json.data.start_error, null)
    await verifyActualKernel(packageVmId)
    assert.equal(await slotSource(packageVmId), '127.0.0.2')
    assert.equal(
      JSON.parse(await readFile(path.join(apiRoot, 'vms', `${packageVmId}.json`), 'utf8')).proxy.id,
      autoExitId,
    )
    assert.equal((await api(apiGateway, 'POST', `/api/panel/vms/${packageVmId}/stop`)).status, 200)
    const factoryRuntimeUser = JSON.parse(await docker(['inspect', containerName(factoryId)]))[0].Config.User
    const writeBack = await api(apiGateway, 'PUT', `/api/panel/vms/${factoryId}/package`, { body: packageDoc })
    assert.equal(writeBack.status, 200, `managed package write-back: ${writeBack.json?.error?.code || ''}`)
    assert.equal(
      JSON.parse(await readFile(path.join(apiRoot, 'vms', `${factoryId}.json`), 'utf8')).proxy.id,
      autoExitId,
    )
    assert.equal((await api(apiGateway, 'POST', `/api/panel/vms/${factoryId}/start`)).status, 200)
    assert.equal(JSON.parse(await docker(['inspect', containerName(factoryId)]))[0].Config.User, factoryRuntimeUser)
    await verifyActualKernel(factoryId)
    assert.equal(await slotSource(factoryId), '127.0.0.2')
    assert.equal((await api(apiGateway, 'POST', `/api/panel/vms/${factoryId}/stop`)).status, 200)
    const afterPackages = (await api(apiGateway, 'GET', '/api/panel/proxies')).json.data.proxies
    assert.equal(
      afterPackages.filter((row) => row.managed).length,
      restoredPool.proxies.filter((row) => row.managed).length,
    )
    assert.equal(afterPackages.filter((row) => !row.managed && row.protocol !== 'local').length, 0)
    await apiGateway.stop()
    apiGateway = null
    for (const id of apiExitIds) stopProxyEgress(apiRoot, id)
    if (apiOwnLocal) stopProxyEgress(apiRoot, 'px-local')

    // Real SSH/SFTP and Compose, using the same controlled Linux daemon.
    // This is not an independently provisioned physical remote host.
    remoteRoot = process.env.MANAGED_EGRESS_NODE_ROOT || path.join(dir, 'ssh-node')
    await mkdir(remoteRoot, { mode: 0o700 })
    remoteRootCreated = true
    const remotePorts = new Set()
    const remoteSockets = new Set(['/var/run/docker.sock'])
    remoteSsh = await startControlledSsh({ root: remoteRoot, ports: remotePorts, sockets: remoteSockets })
    remoteNodeId = `controlled-ssh-${nonce}`
    remotePool = new ProxyPool({ db, vmNodeOf: (vmId) => remoteVmHosts.get(vmId) })
    remoteHosts = new RemoteManagedEgressHosts({
      db,
      rowsFor: (nodeId) => remotePool.managedRows(nodeId),
      socketDir: path.join(helperRoot, 'ssh'),
      cluster: {
        client(nodeId) {
          assert.equal(nodeId, remoteNodeId)
          return remoteSsh.client
        },
        async remoteHost(nodeId) {
          assert.equal(nodeId, remoteNodeId)
          return { platform: 'linux', root: remoteRoot, uid: process.getuid(), gid: process.getgid() }
        },
      },
    })
    remotePool.managedPortsFor = (nodeId) => remoteHosts.occupiedPorts(nodeId)
    remotePool.managedHostFor = (nodeId) => remoteHosts.get(nodeId)
    remotePool.managedPrepareHost = (nodeId) => remoteHosts.ensureProvisioned(nodeId)
    remotePool.managedEndpointFor = (proxy) => remoteHosts.addressFor(proxy)
    remotePool.managedHelperStatus = (proxy) => remoteHosts.helperStatus(proxy)
    remotePool.managedPlacementSupported = (proxy, nodeId) => remoteHosts.supportsPlacement(proxy, nodeId)
    const remoteImported = []
    for (const exit of exits) {
      const imported = await remotePool.importManaged({ host_id: remoteNodeId, config: exit.config })
      assert.equal(imported.ok, true)
      const id = imported.items[0].id
      remoteImported.push(id)
      remotePorts.add(remotePool.state.proxies.find((proxy) => proxy.id === id).port)
    }
    remoteHost = await remoteHosts.get(remoteNodeId)
    assert.equal(
      (await remotePool.applyManaged({ hostId: remoteNodeId })).ok,
      true,
      'real SSH/Compose provisioning and apply must verify',
    )
    const remoteObservedIPs = []
    for (let index = 0; index < remoteImported.length; index++) {
      const proxy = remotePool.getProxyByIdWithAuth(remoteImported[index])
      assert.ok(!remotePorts.has(proxy.port), 'control-plane route must be the SSH bridge')
      const observed = await (await makeProxyFetch(proxy.url)(`http://127.0.0.1:${originPort}/source`)).text()
      assert.equal(observed, `127.0.0.${index + 2}`)
      remoteObservedIPs.push(observed)
    }
    remoteSession = {
      nodeId: remoteNodeId,
      client: remoteSsh.client,
      host: { platform: 'linux', root: remoteRoot, uid: 0, gid: 0, sudo: false },
      docker: sshDocker(remoteSsh.client),
    }
    for (let index = 0; index < remoteImported.length; index++) {
      const vmId = `vm-${nonce}-${index}`
      remoteVmHosts.set(vmId, remoteNodeId)
      remoteVmHosts.set('wrong-host', 'another-host')
      assert.equal(
        remotePool.bind(remoteImported[index], 'wrong-host', { force: true }).error,
        'managed_host_unsupported',
      )
      const socket = path.join(remoteRoot, 'vms', vmId, 'egress-control/drain.sock')
      assert.ok(Buffer.byteLength(socket) < 108, 'fixture remote control path must fit the Linux Unix socket limit')
      remoteSockets.add(socket)
      const slotBin = path.join(remoteRoot, 'vms', vmId, 'slot-bin')
      assert.equal((await execCollect(remoteSsh.client, `umask 077 && mkdir -p ${shellQuote(slotBin)}`)).code, 0)
      await writeRemoteFile(
        await openSftp(remoteSsh.client),
        path.join(slotBin, 'kin-egress'),
        await readFile(helper),
        { mode: 0o755 },
      )
      let network
      const binding = await remotePool.bindManaged(remoteImported[index], vmId, async (proxy) => {
        const vm = { id: vmId, node_id: remoteNodeId, proxy }
        network = await ensureRemoteEgress(remoteSession, vm, {
          imageRef: slotImage,
          binaryDigest: createHash('sha256')
            .update(await readFile(helper))
            .digest('hex'),
        })
        if (network.ok) remoteNetworks.push(network.network)
        return network
      })
      assert.equal(binding.ok, true)
      assert.equal(network.ok, true, `real remote helper setup must succeed: ${network.error || ''}`)
      const authoritative = remotePool.getProxyForVm(vmId)
      assert.equal(authoritative.id, remoteImported[index])
      const vm = { id: vmId, node_id: remoteNodeId, proxy: { ...authoritative, url: 'socks5h://127.0.0.1:9' } }
      const credentials = resolveImportProxy({ vm, proxyPool: remotePool })
      assert.equal(credentials.ok, true)
      assert.equal(
        resolveImportProxy({ vm, proxyPool: remotePool, overrideUrl: 'socks5h://127.0.0.1:9' }).reason,
        'managed_proxy_override_forbidden',
      )
      const exchanged = await (
        await makeProxyFetch(credentials.proxyUrl)(`http://127.0.0.1:${originPort}/credential`, {
          method: 'POST',
          body: 'controlled-credential-fixture',
        })
      ).json()
      assert.deepEqual(exchanged, { source: `127.0.0.${index + 2}`, received: true })
      const trafficName = `${project}-remote-traffic-${index}`
      await docker([
        'run',
        '-d',
        '--pull=never',
        '--name',
        trafficName,
        '--label',
        `vm2api.e2e.owner=${nonce}`,
        '--network',
        network.network,
        '--entrypoint',
        '/bin/sh',
        slotImage,
        '-c',
        'exec sleep 600',
      ])
      containers.push(trafficName)
      remoteTraffic.push(trafficName)
    }
    remotePool.save()
    const firstVm = `vm-${nonce}-0`
    const oldLimit = remotePool.state.config.bind_limit
    remotePool.state.config.bind_limit = 1
    assert.equal(remotePool.bind(remoteImported[1], firstVm).error, 'proxy_bind_limit')
    assert.equal(
      remotePool.getProxyForVm(firstVm).id,
      remoteImported[0],
      'quota rejection must preserve the previous binding',
    )
    remotePool.state.config.bind_limit = oldLimit
    remoteVmHosts.set('failed-setup', remoteNodeId)
    const failedSetup = await remotePool.bindManaged(remoteImported[0], 'failed-setup', async () => ({ ok: false }))
    assert.equal(failedSetup.ok, false)
    assert.equal(failedSetup.binding_committed, true)
    assert.ok(
      remotePool.state.proxies.find((proxy) => proxy.id === remoteImported[0]).bound_vm_ids.includes('failed-setup'),
    )
    remotePool.unbind(remoteImported[0], 'failed-setup')
    await remotePool.inspectManaged()
    remotePool.reload()
    assert.equal(remotePool.getProxyForVm(firstVm), null)
    await remotePool.inspectManaged()
    assert.equal(remotePool.getProxyForVm(firstVm).id, remoteImported[0])
    const retryFailure = await remotePool.bindManaged(remoteImported[0], firstVm, async () => ({ ok: false }))
    assert.equal(retryFailure.ok, false)
    assert.equal(retryFailure.binding_committed, true)
    const retryRow = remotePool.state.proxies.find((proxy) => proxy.id === remoteImported[0])
    const originalConfig = { ...retryRow.managed_config }
    await remotePool.updateManaged(retryRow.id, { config: { server_port: originalConfig.server_port + 1 } })
    let invalidRepairStarted = false
    const pendingRetry = await remotePool.bindManaged(retryRow.id, firstVm, async () => {
      invalidRepairStarted = true
      return { ok: true }
    })
    assert.equal(pendingRetry.ok, false, 'a pending outbound edit cannot authorize helper repair')
    assert.equal(invalidRepairStarted, false)
    await remotePool.updateManaged(retryRow.id, { config: originalConfig })
    const retriedBinding = await remotePool.bindManaged(retryRow.id, firstVm, async (proxy) =>
      ensureRemoteEgress(
        remoteSession,
        { id: firstVm, node_id: remoteNodeId, proxy },
        {
          imageRef: slotImage,
          binaryDigest: createHash('sha256')
            .update(await readFile(helper))
            .digest('hex'),
        },
      ),
    )
    assert.equal(retriedBinding.ok, true, 'verified applied configuration must allow retrying a retained binding')
    const remoteRequest = (index, route = '/') =>
      docker([
        'exec',
        remoteTraffic[index],
        'curl',
        '--silent',
        '--show-error',
        '--fail',
        '--noproxy',
        '*',
        '--connect-timeout',
        '2',
        '--max-time',
        '30',
        `http://${originHost}:${originPort}${route}`,
      ])
    for (let index = 0; index < 2; index++) assert.equal(await remoteRequest(index), `exit-${index}`)
    const rebindExits = []
    for (const [target, expected] of [
      [remoteImported[1], 'exit-1'],
      [remoteImported[0], 'exit-0'],
    ]) {
      const rebound = await remotePool.bindManaged(target, firstVm, async (proxy) =>
        ensureRemoteEgress(
          remoteSession,
          { id: firstVm, node_id: remoteNodeId, proxy },
          {
            imageRef: slotImage,
            binaryDigest: createHash('sha256')
              .update(await readFile(helper))
              .digest('hex'),
          },
        ),
      )
      assert.equal(rebound.ok, true, 'managed rebind must verify the replacement helper')
      assert.equal(remotePool.getProxyForVm(firstVm).id, target)
      const actual = await remoteRequest(0)
      assert.equal(actual, expected, 'the existing traffic container must use the newly selected exit')
      rebindExits.push(actual)
      assert.equal(await remoteRequest(1), 'exit-1', 'rebinding one slot must preserve the other slot')
    }
    assert.ok((await remotePool.inspectManaged()).ok)
    heldStarted = new Promise((resolve) => {
      signalHeld = resolve
    })
    const heldRemote = remoteRequest(0, '/held')
    void heldRemote.catch(() => {})
    await Promise.race([
      heldStarted,
      heldRemote.then(() => {
        throw new Error('remote held response ended early')
      }),
    ])
    let remoteApplied = false
    const remoteApplying = remotePool.applyManaged({ hostId: remoteNodeId }).then((result) => {
      remoteApplied = true
      return result
    })
    void remoteApplying.catch(() => {})
    const firstRemote = remotePool.state.proxies.find((proxy) => proxy.id === remoteImported[0])
    const observing = await startRemoteEgressDrain({
      id: firstRemote.id,
      nodeId: remoteNodeId,
      remotePath: path.join(remoteRoot, 'vms', firstRemote.bound_vm_id, 'egress-control/drain.sock'),
      socketPath: path.join(helperRoot, 'observed.sock'),
      getClient: () => remoteSsh.client,
    })
    try {
      let observed
      for (let attempt = 0; attempt < 100; attempt++) {
        observed = await observing.inspect()
        if (remoteHost.state().status === 'draining' && observed.paused && observed.active > 0) break
        await delay(50)
      }
      assert.equal(remoteHost.state().status, 'draining')
      assert.equal(observed.paused, true)
      assert.ok(observed.active > 0, 'a real remote helper flow must still be active while paused')
      assert.equal(remoteApplied, false, 'remote helper drain must retain the live transparent flow')
      releaseHeld()
      assert.equal(await heldRemote, 'exit-0:finished')
      assert.equal((await remoteApplying).ok, true)
    } finally {
      releaseHeld?.()
      await remoteApplying.catch(() => {})
      await observing.close()
    }
    for (let index = 0; index < 2; index++) assert.equal(await remoteRequest(index), `exit-${index}`)
    const remoteContainer = await remoteHost.runtime.locate()
    await remoteHost.runtime.docker(['stop', '--time', '2', remoteContainer])
    await remotePool.inspectManaged()
    assert.ok(remotePool.snapshot().proxies.every((proxy) => proxy.exit_status === 'unavailable'))
    for (let index = 0; index < 2; index++) assert.equal(await request(index), `exit-${index}`)
    assert.equal((await remotePool.recoverManaged({ hostId: remoteNodeId })).ok, true)
    for (let index = 0; index < remoteImported.length; index++) {
      const proxy = remotePool.getProxyByIdWithAuth(remoteImported[index])
      assert.equal(
        await (await makeProxyFetch(proxy.url)(`http://127.0.0.1:${originPort}/source`)).text(),
        `127.0.0.${index + 2}`,
      )
    }
    const stale = remotePool.getProxyForVm(firstVm)
    await remoteSsh.reconnect()
    remoteSession.client = remoteSsh.client
    remoteSession.docker = sshDocker(remoteSsh.client)
    assert.equal(remotePool.getProxyForVm(firstVm), null)
    assert.equal(remotePool.ensureBoundToVm(firstVm, remoteImported[0]), null)
    remoteHost = await remoteHosts.get(remoteNodeId)
    await remotePool.inspectManaged()
    const reconnected = resolveImportProxy({
      vm: { id: firstVm, node_id: remoteNodeId, proxy: stale },
      proxyPool: remotePool,
    })
    assert.equal(reconnected.ok, true)
    assert.notEqual(new URL(reconnected.proxyUrl).port, String(stale.port))
    assert.equal(
      await (await makeProxyFetch(reconnected.proxyUrl)(`http://127.0.0.1:${originPort}/source`)).text(),
      '127.0.0.2',
    )
    const files = [
      'test/e2e/managed-egress-linux.e2e.test.mjs',
      'src/lib/vm/managed-egress-host.mjs',
      'src/lib/vm/managed-egress-docker.mjs',
      'src/lib/vm/egress.mjs',
      'src/lib/vm/managed-egress-drain.mjs',
      'src/lib/vm/managed-egress-helper-absence.mjs',
      'src/lib/vm/managed-egress-admission.mjs',
      'src/lib/vm/managed-egress-config.mjs',
      'worker/cmd/kin-egress/main.go',
      'worker/internal/egress/server.go',
      'worker/internal/egress/origdst_linux.go',
      'worker/internal/egress/domain_forward.go',
      'worker/go.mod',
      'worker/go.sum',
      'src/lib/cluster/managed-egress-hosts.mjs',
      'src/lib/cluster/managed-egress-runtime.mjs',
      'src/lib/cluster/managed-egress-files.mjs',
      'src/lib/cluster/managed-egress-endpoint.mjs',
      'src/lib/vm/proxy-pool.mjs',
      'src/lib/vm/proxy-resolve.mjs',
      'src/lib/admin/panel-routes.mjs',
      'src/server.mjs',
      'src/lib/admin/backup-service.mjs',
      'src/lib/admin/backup-core.mjs',
      'src/lib/vm/vm-package.mjs',
      'src/lib/oauth/oauth-credentials.mjs',
      'src/lib/cluster/cluster-manager.mjs',
      'test/helpers/controlled-ssh.mjs',
      'test/fixtures/managed-egress-linux.Dockerfile',
      'src/lib/cluster/remote-slot.mjs',
      'src/lib/cluster/remote-egress-proxy.mjs',
      'src/lib/cluster/managed-egress-drain.mjs',
      'src/lib/cluster/docker-remote.mjs',
      'src/lib/cluster/remote-fs.mjs',
      'src/lib/cluster/ssh-link.mjs',
      'test/harness.mjs',
      'src/lib/vm/slot-recovery.mjs',
      'src/lib/vm/managed-egress-binding.mjs',
      'src/lib/vm/slot-runtime.mjs',
      'src/lib/vm/vm-runtime.mjs',
      'deploy/payload.json',
      'worker/internal/egress/drain.go',
    ]
    await receipt({
      status: 'PASS',
      command,
      source: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
      source_files: Object.fromEntries(
        await Promise.all(
          files.map(async (file) => [
            file,
            createHash('sha256')
              .update(await readFile(file))
              .digest('hex'),
          ]),
        ),
      ),
      environment: `${process.platform}/${process.arch}`,
      sing_box_image: MANAGED_EGRESS_IMAGE,
      slot_image_id: slotMetadata.Id,
      gateway_slot_image_id: guestMetadata.Id,
      gateway_slot_architecture: guestMetadata.Architecture,
      gateway_slot_execution: process.arch === 'arm64' ? 'amd64 emulation on arm64 Docker host' : 'native amd64',
      gateway_slot_health_status: Number(fullSlotHealth.status),
      helper_sha256: createHash('sha256')
        .update(await readFile(helper))
        .digest('hex'),
      native_sing_box_sha256: createHash('sha256')
        .update(await readFile(binary))
        .digest('hex'),
      versions: manager.state(),
      remote_versions: remoteHost.state(),
      remote_actual_exits: remoteObservedIPs,
      remote_rebind_exits: rebindExits,
      expected_exits: ['127.0.0.2', '127.0.0.3'],
      actual_exits: observedIPs,
      results: [
        'two transparent container paths',
        'authenticated gateway HTTP import apply and initial binding initialize a real transparent helper; missing slot refused; listener credentials redacted',
        'HTTP helper initialization failure retains binding and revokes readiness; restoring the helper permits an explicit verified retry and real traffic',
        'HTTP starts and restarts a real Ubuntu slot with pinned kernel payload; actual private kernel health and transparent exit verified',
        'HTTP start verifies and rebuilds a retained managed binding after helper setup failure, preserving the exit and actual kernel health',
        'real factory creation and keep/traits rebuild preserve the selected exit; two complete local slots retain separate routes and private kernel health',
        'factory helper failure retains VM and binding; stopped Codex helper initialization can retry after executable restoration',
        'HTTP automatic managed allocation initializes the selected helper and preserves its controlled route',
        'partial restore with a missing or disabled managed exit refuses alternate allocation and preserves the snapshot; restoring the original exit restores actual kernel health and route',
        'real HTTP archive restore rebinds managed and cluster SQLite holders; newer runtime is refused; explicit restored apply recovers actual kernel and original route',
        'real HTTP managed VM package export, creation and write-back preserve the referenced exit; actual kernels and original route verified without external SOCKS aliases',
        'live flow drains before restart',
        'timeout retains instance',
        'isolated upstream failure without fallback',
        'stopped service recovery',
        'simultaneous shared-service and SIGKILL helper loss recovered',
        'real SSH/SFTP/Compose import apply and stopped-service recovery on selected logical host',
        'SSH-bridged control-plane requests preserve the two selected exits',
        'verified managed pool binding initializes real remote helpers; wrong-host and quota rejection preserve mappings; failed setup retains binding',
        'retained failed binding can retry after applied-config verification; pending outbound edit cannot authorize repair',
        'existing transparent traffic container switches to the second managed exit and back without changing the other slot',
        'controlled credential POST uses the pool bridge; arbitrary override and stale snapshot fallback refused; reload and SSH reconnect restore authoritative binding',
      ],
      scope:
        'real local Ubuntu gateway slot startup/restart/helper recovery, Linux Docker networks, iptables, helpers and SSH/SFTP/Compose logical-host lifecycle on the same daemon; control mount identity fixture; no separate physical host, full remote gateway slot lifecycle, host reboot, real Claude or visual acceptance',
    })
  } catch (error) {
    await receipt({
      status: 'FAIL',
      environment: `${process.platform}/${process.arch}`,
      error: 'controlled Linux acceptance failed; inspect the local test assertion',
      scope: 'no success inferred from partial execution',
    })
    throw error
  } finally {
    releaseHeld?.()
    await apiGateway?.stop()
    for (const vmId of apiSlotIds) {
      const name = containerName(vmId)
      const info = await docker(['inspect', name]).then(
        (text) => JSON.parse(text)[0],
        () => null,
      )
      if (
        info?.Config?.Labels?.['kin.vm.id'] === vmId &&
        info.Mounts?.some(
          (mount) => mount.Source === `${apiProject}/vms/${vmId}/cli-home` && mount.Destination === '/home/kincli',
        )
      )
        await docker(['rm', '-f', info.Id])
    }
    for (const name of [...containers].reverse()) {
      const metadata = await docker(['inspect', name]).then(
        (text) => JSON.parse(text)[0],
        () => null,
      )
      if (metadata?.Config?.Labels?.['vm2api.e2e.owner'] === nonce) await docker(['rm', '-f', name]).catch(() => {})
    }
    for (const network of remoteNetworks) await releaseRemoteEgress(remoteSession, network).catch(() => {})
    if (remoteHost) {
      const id = await remoteHost.runtime.locate({ requireRunning: false }).catch(() => null)
      if (id) await remoteHost.runtime.docker(['rm', '-f', id]).catch(() => {})
    }
    await remoteHosts?.close()
    await remoteSsh?.close()
    if (remoteRootCreated) await rm(remoteRoot, { recursive: true, force: true })
    for (const exit of ownedExits) {
      stopProxyEgress(helperRoot, exit.id)
    }
    for (const id of apiExitIds) stopProxyEgress(apiRoot, id)
    if (apiOwnLocal) stopProxyEgress(apiRoot, 'px-local')
    if (apiRoot) await rm(apiRoot, { force: true })
    for (const exit of exits) unregisterManagedEgressEndpoint(exit.id)
    for (const child of children) await stop(child)
    origin.closeAllConnections()
    await new Promise((resolve) => origin.close(resolve))
    db?.close()
    if (previousGeo === undefined) delete process.env.KIN_PROXY_GEO_URL
    else process.env.KIN_PROXY_GEO_URL = previousGeo
    await rm(dir, { recursive: true, force: true })
    await rm(helperRoot, { recursive: true, force: true })
  }
})
