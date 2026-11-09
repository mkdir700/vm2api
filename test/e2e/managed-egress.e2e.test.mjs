import dgram from 'node:dgram'
import { acquireManagedDrain, EgressDrainClient } from '../../src/lib/vm/managed-egress-drain.mjs'
import { makeProxyFetch } from '../../src/lib/protocol/codex-models.mjs'
import { lookupProxyGeo } from '../../src/lib/vm/proxy-geo.mjs'
import { pauseManagedEgress } from '../../src/lib/vm/managed-egress-admission.mjs'
import { boundProxyUrl } from '../../src/lib/vm/egress.mjs'
import { proxyBlockedReason } from '../../src/lib/vm/proxy-policy.mjs'
import { reserveAbsentManagedHelper } from '../../src/lib/vm/managed-egress-helper-absence.mjs'
import { verifyManagedListeners } from '../../src/lib/vm/managed-egress-docker.mjs'
import test from 'node:test'
import assert from 'node:assert/strict'
import { spawn, execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdtemp, writeFile, rm, mkdir, readFile, stat, readdir, copyFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import net from 'node:net'
import http from 'node:http'
import fetch from 'node-fetch'
import { SocksProxyAgent } from 'socks-proxy-agent'
import { managedEgressConfig, parseHysteria2Link } from '../../src/lib/vm/managed-egress-config.mjs'

import { createDatabase } from '../../src/lib/db/database.mjs'
import { ProxiesRepo } from '../../src/lib/db/repos/proxies-repo.mjs'
import { ManagedEgressHost } from '../../src/lib/vm/managed-egress-host.mjs'
import { ProxyPool } from '../../src/lib/vm/proxy-pool.mjs'
import { managedEgressIdForUrl } from '../../src/lib/vm/managed-egress-readiness.mjs'

const binary = process.env.SING_BOX_BIN
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
async function freePort() {
  const server = net.createServer()
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const port = server.address().port
  await new Promise((resolve) => server.close(resolve))
  return port
}

test('two real Hysteria 2 routes isolate upstream failure without direct fallback', {
  skip: !binary,
  timeout: 60000,
}, async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'managed-egress-'))
  const children = []
  let releaseDns
  let dnsRequests = 0
  let releaseFetch
  let markFetchStarted
  const fetchStarted = new Promise((resolve) => {
    markFetchStarted = resolve
  })
  let releaseOrigin
  let markHeldStarted
  const heldStarted = new Promise((resolve) => {
    markHeldStarted = resolve
  })
  const origin = http.createServer((req, res) => {
    if (req.url === '/joint-dns') {
      dnsRequests++
      const chunks = []
      req.on('data', (chunk) => chunks.push(chunk))
      req.on('end', () => {
        const response = Buffer.concat(chunks)
        response[2] |= 0x80
        releaseDns = () => res.end(response)
        if (dnsRequests > 1) releaseDns()
      })
    } else if (req.url === '/fetch-held') {
      res.write('controlled-')
      releaseFetch = () => res.end('origin')
      markFetchStarted()
    } else if (req.url === '/held') {
      releaseOrigin = () => res.end('controlled-origin')
      markHeldStarted()
    } else if (req.url === '/geo') {
      res.setHeader('content-type', 'application/json')
      res.end(JSON.stringify({ query: '127.0.0.1' }))
    } else res.end('controlled-origin')
  })
  await new Promise((resolve) => origin.listen(0, '127.0.0.1', resolve))
  async function start(name, config) {
    const file = path.join(dir, `${name}.json`)
    await writeFile(file, JSON.stringify(config), { mode: 0o600 })
    execFileSync(binary, ['check', '-c', file], { stdio: 'pipe' })
    const child = spawn(binary, ['run', '-c', file], { stdio: 'ignore' })
    children.push(child)
    await delay(350)
    assert.equal(child.exitCode, null, `${name} must remain running`)
    return child
  }
  async function stop(child) {
    if (child.exitCode !== null || child.signalCode !== null) return
    await new Promise((resolve) => {
      child.once('exit', resolve)
      child.kill('SIGTERM')
    })
  }
  try {
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
    const bootstrap = path.resolve('deploy/init-managed-egress.sh')
    const configDir = path.join(dir, 'bootstrap')
    const bootstrapFile = path.join(configDir, 'config.json')
    execFileSync('sh', [bootstrap, configDir, binary], { stdio: 'pipe' })
    const initial = await readFile(bootstrapFile, 'utf8')
    assert.equal((await stat(bootstrapFile)).mode & 0o777, 0o600)
    await stop(await start('empty', JSON.parse(initial)))
    execFileSync('sh', [bootstrap, configDir, binary], { stdio: 'pipe' })
    assert.equal(await readFile(bootstrapFile, 'utf8'), initial)
    await writeFile(bootstrapFile, '{invalid-existing-config')
    assert.throws(() => execFileSync('sh', [bootstrap, configDir, binary], { stdio: 'pipe' }))
    assert.equal(await readFile(bootstrapFile, 'utf8'), '{invalid-existing-config')
    const exits = []
    const servers = []
    for (let i = 0; i < 2; i++) {
      const upstream = await freePort()
      servers.push(
        await start(`upstream-${i}`, {
          log: { disabled: true },
          inbounds: [
            {
              type: 'hysteria2',
              listen: '127.0.0.1',
              listen_port: upstream,
              users: [{ password: `upstream-secret-${i}` }],
              tls: { enabled: true, certificate_path: path.join(dir, 'cert.pem'), key_path: path.join(dir, 'key.pem') },
            },
          ],
          outbounds: [{ type: 'direct' }],
        }),
      )
      exits.push({
        id: `controlled-${i}`,
        protocol: 'hysteria2',
        port: await freePort(),
        username: 'generated-user',
        password: `listener-secret-${i}`,
        config: parseHysteria2Link(`hy2://upstream-secret-${i}@127.0.0.1:${upstream}/?insecure=1`),
      })
    }
    // Persist through the production repository, close the DB, and reconstruct routes.
    const dbPath = path.join(dir, 'kin.db')
    const previousSecret = process.env.VM2API_DB_SECRET
    process.env.VM2API_DB_SECRET = 'controlled-e2e-only-encryption-key'
    const oldMigrations = path.join(dir, 'old-migrations')
    await mkdir(oldMigrations)
    const migrationDir = new URL('../../src/lib/db/migrations/', import.meta.url)
    for (const name of await readdir(migrationDir)) {
      if (name.endsWith('.sql') && name < '049')
        await copyFile(new URL(name, migrationDir), path.join(oldMigrations, name))
    }
    let db = createDatabase({ dbPath, migrationsDir: oldMigrations })
    db.prepare('INSERT INTO proxies(id, protocol, host, port, bound_vm_id) VALUES (?, ?, ?, ?, ?)').run(
      'legacy-proxy',
      'socks5',
      '127.0.0.1',
      1080,
      'legacy-slot',
    )
    db.close()
    db = createDatabase({ dbPath })
    assert.equal(
      db.prepare('SELECT bound_vm_id FROM proxies WHERE id = ?').get('legacy-proxy').bound_vm_id,
      'legacy-slot',
    )
    try {
      const legacy = {
        id: 'legacy-proxy',
        scheme: 'socks5',
        host: '127.0.0.1',
        port: 1080,
        bound_vm_id: 'legacy-slot',
        enabled: true,
      }
      const rows = exits.map((exit, i) => ({
        ...exit,
        scheme: 'hysteria2',
        host: '127.0.0.1',
        managed_host_id: 'control-plane',
        managed_config: exit.config,
        config: undefined,
        bound_vm_id: `controlled-slot-${i}`,
        enabled: true,
      }))
      new ProxiesRepo(db).replaceAll([legacy, ...rows])
      const stored = db
        .prepare('SELECT managed_config, username, password FROM proxies WHERE managed_config IS NOT NULL')
        .all()
      for (const row of stored) {
        for (const value of Object.values(row)) assert.ok(value.startsWith('enc:v1:'))
      }
      assert.throws(() => new ProxiesRepo(db).replaceAll([legacy, ...rows, { ...rows[0], id: 'duplicate-port' }]))
      db.close()
      db = createDatabase({ dbPath })
      const restored = new ProxiesRepo(db).loadAll()
      assert.equal(restored.find((p) => p.id === 'legacy-proxy').bound_vm_id, 'legacy-slot')
      for (const exit of exits) {
        const persisted = restored.find((p) => p.id === exit.id)
        assert.equal(persisted.port, exit.port)
        assert.equal(persisted.password, exit.password)
        assert.equal(persisted.managed_host_id, 'control-plane')
        exit.config = persisted.managed_config
      }
      process.env.VM2API_DB_SECRET = 'wrong-e2e-key'
      assert.throws(() => new ProxyPool({ db }), /managed_egress_decryption_failed/)
      assert.equal(db.prepare('SELECT COUNT(*) AS count FROM proxies').get().count, 3)
      process.env.VM2API_DB_SECRET = 'controlled-e2e-only-encryption-key'
      const pool = new ProxyPool({ db })
      for (const exit of exits) {
        const view = pool.snapshot().proxies.find((p) => p.id === exit.id)
        assert.equal(view.host, null)
        assert.equal(view.port, null)
        assert.equal(view.blocked_reason, 'managed_egress_not_ready')
        assert.equal(view.managed_config, undefined)
        assert.equal(pool.remove(exit.id).error, 'proxy_in_use')
        assert.equal(pool.getProxyForVm(`controlled-slot-${exits.indexOf(exit)}`), null)
        assert.equal(pool.bind(exit.id, 'new-slot').error, 'managed_egress_not_ready')
      }
    } finally {
      db.close()
      if (previousSecret === undefined) delete process.env.VM2API_DB_SECRET
      else process.env.VM2API_DB_SECRET = previousSecret
    }
    let client = await start('client', managedEgressConfig(exits))
    async function request(exit, password = exit.password, resource = '/') {
      const agent = new SocksProxyAgent(`socks5h://${exit.username}:${password}@127.0.0.1:${exit.port}`)
      try {
        const response = await fetch(`http://127.0.0.1:${origin.address().port}${resource}`, { agent, timeout: 1800 })
        return await response.text()
      } finally {
        agent.destroy()
      }
    }
    const verified = await verifyManagedListeners(managedEgressConfig(exits), {
      endpoint: `http://127.0.0.1:${origin.address().port}/geo`,
    })
    assert.equal(verified.length, 2)
    assert.ok(verified.every((entry) => entry.ip === '127.0.0.1'))
    for (const exit of exits) assert.equal(await request(exit), 'controlled-origin')
    await assert.rejects(request(exits[0], 'wrong-password'))
    // Exercise the production apply manager against real processes and real routes.
    const hostDir = path.join(dir, 'host')
    await mkdir(hostDir)
    await writeFile(path.join(hostDir, 'config.json'), JSON.stringify(managedEgressConfig(exits)), { mode: 0o600 })
    let hostDb = createDatabase({ dbPath: path.join(dir, 'host.db') })
    let paused = false
    let allowDrain = true
    let restarts = 0
    let activeLease = false
    let pendingRequest = null
    let corruptCandidate = false
    let failDrainRelease = false
    const hostOptions = {
      db: hostDb,
      hostId: 'control-plane',
      configDir: hostDir,
      runtime: {
        async check(file) {
          assert.equal(client.exitCode, null)
          assert.equal(client.signalCode, null)
          if (corruptCandidate) await writeFile(file, '{invalid-candidate')
          execFileSync(binary, ['check', '-c', file], { stdio: 'pipe' })
        },
        async restart() {
          assert.equal(paused, true, 'restart requires a paused admission gate')
          restarts++
          await stop(client)
          client = await start('managed-client', JSON.parse(await readFile(path.join(hostDir, 'config.json'), 'utf8')))
        },
        async verify(config) {
          for (const inbound of config.inbounds) {
            const user = inbound.users[0]
            assert.equal(await request({ port: inbound.listen_port, ...user }), 'controlled-origin')
          }
          return verifyManagedListeners(config, { endpoint: `http://127.0.0.1:${origin.address().port}/geo` })
        },
      },
      async acquireDrain() {
        assert.equal(activeLease, false, 'host updates must serialize')
        activeLease = true
        paused = true
        return {
          async wait(timeout) {
            if (!allowDrain) return false
            if (!pendingRequest) return true
            let timer
            try {
              return await Promise.race([
                pendingRequest.then(() => true),
                new Promise((resolve) => {
                  timer = setTimeout(() => resolve(false), timeout)
                }),
              ])
            } finally {
              clearTimeout(timer)
            }
          },
          async release({ unavailable }) {
            activeLease = false
            paused = unavailable
            if (failDrainRelease) throw new Error('controlled-release-failure')
          },
        }
      },
    }
    const manager = new ManagedEgressHost(hostOptions)
    let applyingPool
    try {
      new ProxiesRepo(hostDb).replaceAll(
        exits.map((exit) => ({
          id: exit.id,
          scheme: 'hysteria2',
          host: '127.0.0.1',
          port: exit.port,
          username: exit.username,
          password: exit.password,
          managed_host_id: 'control-plane',
          managed_config: exit.config,
          enabled: true,
          status: 'unknown',
        })),
      )
      applyingPool = new ProxyPool({ db: hostDb })
      applyingPool.managedHost = manager
      assert.equal((await applyingPool.applyManaged()).ok, true)
      assert.equal(applyingPool.bind(exits[0].id, 'controlled-bound-slot').ok, true)
      const snapshot = applyingPool.getProxyForVm('controlled-bound-slot')
      applyingPool.managedHelperStatus = async () => false
      await applyingPool.inspectManaged()
      assert.equal(applyingPool.getProxyForVm('controlled-bound-slot'), null)
      applyingPool.managedHelperStatus = async () => true
      await applyingPool.inspectManaged()

      assert.ok(boundProxyUrl(snapshot))
      const proxyFetch = makeProxyFetch(snapshot.url)
      const hostResponse = await proxyFetch(`http://127.0.0.1:${origin.address().port}/fetch-held`)
      await fetchStarted
      const hostDrain = pauseManagedEgress([snapshot.id])
      try {
        assert.equal(await hostDrain.wait(20), false)
        await assert.rejects(proxyFetch(`http://127.0.0.1:${origin.address().port}/`), {
          code: 'managed_egress_not_ready',
        })
        const geoOptions = { endpoint: `http://127.0.0.1:${origin.address().port}/geo` }
        assert.equal((await lookupProxyGeo(snapshot.url, geoOptions)).ok, false)
        assert.equal((await verifyManagedListeners(managedEgressConfig(exits), geoOptions)).length, 2)
        releaseFetch()
        assert.equal(await hostResponse.text(), 'controlled-origin')
        assert.equal(await hostDrain.wait(100), true)
      } finally {
        releaseFetch?.()
        hostResponse.body?.destroy()
        await hostDrain.release()
      }

      const abandoned = await proxyFetch(`http://127.0.0.1:${origin.address().port}/fetch-held`)
      const abandonedDrain = pauseManagedEgress([snapshot.id])
      try {
        assert.equal(await abandonedDrain.wait(20), false)
        abandoned.body.destroy()
        assert.equal(await abandonedDrain.wait(100), true)
      } finally {
        releaseFetch?.()
        await abandonedDrain.release()
      }
      assert.equal(
        (await lookupProxyGeo(snapshot.url, { endpoint: `http://127.0.0.1:${origin.address().port}/geo` })).ok,
        true,
      )

      if (process.env.KIN_EGRESS_TEST_BIN) {
        const helperSocket = path.join(dir, 'joint.sock')
        const dnsPort = await freePort()
        const helperConfig = path.join(dir, 'joint-egress.json')
        const helperPidFile = path.join(dir, 'joint-egress.pid')
        const helperTcpPort = await freePort()
        await writeFile(
          helperConfig,
          JSON.stringify({
            proxy_id: exits[0].id,
            proxy_url: snapshot.url,
            listen_tcp: `127.0.0.1:${helperTcpPort}`,
            listen_dns: `127.0.0.1:${dnsPort}`,
            dns_upstream: `http://127.0.0.1:${origin.address().port}/joint-dns`,
            control_socket: helperSocket,
          }),
          { mode: 0o600 },
        )
        let helper = spawn(process.env.KIN_EGRESS_TEST_BIN, ['-config', helperConfig], { stdio: 'ignore' })
        children.push(helper)
        await writeFile(helperPidFile, String(helper.pid), { mode: 0o600 })
        const control = new EgressDrainClient({ id: exits[0].id, socketPath: helperSocket })
        async function waitFor(check) {
          for (let i = 0; i < 500; i++) {
            if (await check()) return
            await delay(10)
          }
          assert.fail('joint drain observation timed out')
        }
        await waitFor(async () => {
          try {
            return (await control.request('GET', '/status')).version === 1
          } catch {
            return false
          }
        })
        const originalHelperStatus = applyingPool.managedHelperStatus
        let repairAttempts = 0
        let permitRepair = false
        let markRepair
        let continueRepair
        const repairStarted = new Promise((resolve) => {
          markRepair = resolve
        })
        const repairGate = new Promise((resolve) => {
          continueRepair = resolve
        })
        applyingPool.managedHelperStatus = async (row) =>
          row.id !== exits[0].id || !(await control.request('GET', '/status')).paused
        applyingPool.managedRepairHelper = async (row) => {
          if (helper.exitCode === null && helper.signalCode === null) return false
          repairAttempts++
          assert.equal(row.id, exits[0].id)
          assert.equal(proxyBlockedReason(row), null, 'verified maintenance must admit only the repair context')
          if (!permitRepair) return false
          markRepair()
          await repairGate
          helper = spawn(process.env.KIN_EGRESS_TEST_BIN, ['-config', helperConfig], { stdio: 'ignore' })
          children.push(helper)
          await writeFile(helperPidFile, String(helper.pid), { mode: 0o600 })
          await waitFor(async () => {
            try {
              return (await control.request('GET', '/status')).version === 1
            } catch {
              return false
            }
          })
          return true
        }
        await stop(helper)
        applyingPool.setEnabled(exits[0].id, false)
        await applyingPool.inspectManaged()
        assert.equal(repairAttempts, 0, 'disabled exits must not restart their helper')
        applyingPool.setEnabled(exits[0].id, true)
        await applyingPool.updateManaged(exits[0].id, { config: { password: 'unverified-desired-edit' } })
        await applyingPool.inspectManaged()
        assert.equal(repairAttempts, 0, 'pending desired settings must not authorize helper repair')
        await applyingPool.updateManaged(exits[0].id, { config: { password: exits[0].config.password } })
        const beforeRepair = restarts
        await applyingPool.inspectManaged()
        assert.equal(repairAttempts, 1)
        assert.equal(applyingPool.getProxyForVm('controlled-bound-slot'), null)
        assert.equal(
          applyingPool.snapshot().proxies.find((row) => row.id === exits[0].id).bound_vm_id,
          'controlled-bound-slot',
        )
        permitRepair = true
        const repairing = applyingPool.inspectManaged()
        await repairStarted
        await assert.rejects(proxyFetch(`http://127.0.0.1:${origin.address().port}/`), {
          code: 'managed_egress_not_ready',
        })
        const maintenanceDrain = pauseManagedEgress([exits[0].id])
        assert.equal(await maintenanceDrain.wait(20), false, 'maintenance must retain an active admission lease')
        await maintenanceDrain.release()
        continueRepair()
        await repairing
        assert.equal(repairAttempts, 2)
        assert.ok(applyingPool.getProxyForVm('controlled-bound-slot'))
        assert.equal(restarts, beforeRepair, 'helper repair must not restart the shared runtime')
        const pausedHelper = new EgressDrainClient({ id: exits[0].id, socketPath: helperSocket })
        await pausedHelper.pause()
        const repairedPid = helper.pid
        await applyingPool.inspectManaged()
        assert.equal(repairAttempts, 2, 'a live paused helper must not be replaced')
        assert.equal(helper.pid, repairedPid)
        assert.equal(applyingPool.getProxyForVm('controlled-bound-slot'), null)
        await pausedHelper.resume()
        await applyingPool.inspectManaged()
        assert.ok(applyingPool.getProxyForVm('controlled-bound-slot'))
        const absenceOptions = { id: exits[0].id, configFile: helperConfig, pidFile: helperPidFile }
        await assert.rejects(reserveAbsentManagedHelper(absenceOptions), /managed_helper_absence_unproven/)
        const stoppedHelperPid = helper.pid
        await stop(helper)
        await stop(client)
        await applyingPool.updateManaged(exits[0].id, { config: { password: 'pending-during-dual-loss' } })
        await writeFile(helperPidFile, String(process.pid))
        await assert.rejects(reserveAbsentManagedHelper(absenceOptions), /managed_helper_absence_unproven/)
        await writeFile(helperPidFile, String(stoppedHelperPid))
        const unknownTcp = net.createServer((socket) => socket.destroy())
        await new Promise((resolve) => unknownTcp.listen(helperTcpPort, '127.0.0.1', resolve))
        await assert.rejects(reserveAbsentManagedHelper(absenceOptions), /managed_helper_absence_unproven/)
        await new Promise((resolve) => unknownTcp.close(resolve))
        const unknownUdp = dgram.createSocket('udp4')
        await new Promise((resolve) => unknownUdp.bind(dnsPort, '127.0.0.1', resolve))
        await assert.rejects(reserveAbsentManagedHelper(absenceOptions), /managed_helper_absence_unproven/)
        await new Promise((resolve) => unknownUdp.close(resolve))
        let recoveryMode = false
        const dualLossManager = new ManagedEgressHost({
          ...hostOptions,
          runtime: {
            ...hostOptions.runtime,
            async check(file) {
              execFileSync(binary, ['check', '-c', file], { stdio: 'pipe' })
            },
          },
          acquireDrain: async ({ recovery = false } = {}) => {
            recoveryMode = recovery
            paused = true
            const reservations = []
            const lease = await acquireManagedDrain({
              ids: exits.map((exit) => exit.id),
              helpers: async () => {
                assert.equal(recovery, true, 'missing-helper proof is recovery-only')
                reservations.push(await reserveAbsentManagedHelper(absenceOptions))
                return []
              },
            })
            return {
              wait: (timeout) => lease.wait(timeout),
              release: async (options) => {
                try {
                  await lease.release(options)
                } finally {
                  paused = options.unavailable
                  await Promise.all(reservations.map((proof) => proof.close()))
                }
              },
            }
          },
        })
        dualLossManager.record({ status: 'unavailable' })
        applyingPool.managedHost = dualLossManager
        const dualRecovered = await applyingPool.recoverManaged()
        assert.equal(recoveryMode, true)
        assert.equal(
          dualRecovered.ok,
          true,
          'explicit recovery must restore runtime before rebuilding its absent helper',
        )
        assert.equal(dualRecovered.pending_changes, true)
        assert.equal(
          applyingPool.getProxyForVm('controlled-bound-slot'),
          null,
          'recovery must not publish the pending desired version',
        )
        assert.notEqual(helper.pid, stoppedHelperPid)
        for (const exit of exits) assert.equal(await request(exit), 'controlled-origin')
        assert.equal(
          applyingPool.state.proxies.find((row) => row.id === exits[0].id).managed_config.password,
          'pending-during-dual-loss',
        )
        await applyingPool.updateManaged(exits[0].id, { config: { password: exits[0].config.password } })
        await applyingPool.inspectManaged()
        assert.ok(applyingPool.getProxyForVm('controlled-bound-slot'))
        applyingPool.managedHost = manager
        const udp = dgram.createSocket('udp4')
        const jointManager = new ManagedEgressHost({
          ...hostOptions,
          acquireDrain: async () => {
            activeLease = true
            paused = true
            const lease = await acquireManagedDrain({
              ids: exits.map((exit) => exit.id),
              helpers: () => [new EgressDrainClient({ id: exits[0].id, socketPath: helperSocket })],
            })
            return {
              wait: (timeout) => lease.wait(timeout),
              release: async (options) => {
                try {
                  await lease.release(options)
                } finally {
                  activeLease = false
                  paused = options.unavailable
                }
              },
            }
          },
        })
        try {
          const heldHost = await proxyFetch(`http://127.0.0.1:${origin.address().port}/fetch-held`)
          const query = Buffer.from([0x45, 0x67, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0])
          const dnsResponse = new Promise((resolve) => udp.once('message', resolve))
          udp.send(query, dnsPort, '127.0.0.1')
          await waitFor(async () => !!releaseDns)
          const beforeJoint = restarts
          const applying = jointManager.apply(exits, { drainTimeoutMs: 5000 })
          await waitFor(async () => jointManager.state().status === 'draining')
          assert.equal((await control.request('GET', '/status')).paused, false)
          assert.equal(restarts, beforeJoint)
          releaseFetch()
          assert.equal(await heldHost.text(), 'controlled-origin')
          await waitFor(async () => (await control.request('GET', '/status')).paused)
          assert.equal((await control.request('GET', '/status')).active, 1)
          assert.equal(restarts, beforeJoint)
          udp.send(query, dnsPort, '127.0.0.1')
          await delay(30)
          assert.equal(dnsRequests, 1)
          releaseDns()
          assert.equal((await dnsResponse).readUInt16BE(0), 0x4567)
          assert.equal((await applying).status, 'ready')
          assert.equal(restarts, beforeJoint + 1)
          assert.equal((await control.request('GET', '/status')).paused, false)
          const resumedDns = new Promise((resolve) => udp.once('message', resolve))
          udp.send(query, dnsPort, '127.0.0.1')
          const resumedReply = await resumedDns
          assert.equal(resumedReply[3] & 0x0f, 0)
          assert.equal(dnsRequests, 2)
          for (const exit of exits) assert.equal(await request(exit), 'controlled-origin')
          const timeoutHost = await proxyFetch(`http://127.0.0.1:${origin.address().port}/fetch-held`)
          const beforeTimeout = restarts
          const timedOut = await jointManager.apply(exits, { drainTimeoutMs: 30 })
          assert.equal(timedOut.error, 'managed_drain_timeout')
          assert.equal(restarts, beforeTimeout)
          assert.equal((await control.request('GET', '/status')).paused, false)
          releaseFetch()
          assert.equal(await timeoutHost.text(), 'controlled-origin')
        } finally {
          continueRepair()
          applyingPool.managedHelperStatus = originalHelperStatus
          applyingPool.managedRepairHelper = null
          releaseDns?.()
          releaseFetch?.()
          try {
            udp.close()
          } catch {}
          await stop(helper)
        }
      }
      assert.equal((await applyingPool.applyManaged()).ok, true)
      assert.equal(
        (await applyingPool.updateManaged(exits[0].id, { config: { password: exits[0].config.password } })).ok,
        true,
      )
      applyingPool.unbind(exits[0].id, 'controlled-bound-slot')
      applyingPool.reload()
      assert.throws(() => boundProxyUrl(snapshot), /受管出口尚未就绪/)
      let beforeInspectionRestarts = restarts
      assert.equal((await applyingPool.inspectManaged()).ok, true)
      assert.ok(boundProxyUrl(snapshot))
      assert.equal(restarts, beforeInspectionRestarts)
      const imported = await applyingPool.importManaged({ link: 'hy2://unapplied@localhost/' })
      await applyingPool.inspectManaged()
      assert.equal(
        applyingPool.snapshot().proxies.find((p) => p.id === imported.items[0].id).application_status,
        'pending',
      )
      const removingId = imported.items[0].id
      const assignedPort = applyingPool.getProxyByIdWithAuth(removingId).port
      assert.equal((await applyingPool.updateManaged(removingId, {}, { remove: true })).ok, true)
      applyingPool.reload()
      assert.equal(applyingPool.getProxyByIdWithAuth(removingId).port, assignedPort)
      assert.equal(applyingPool.snapshot().proxies.find((p) => p.id === removingId).removal_pending, true)
      assert.equal((await applyingPool.applyManaged()).ok, true)
      assert.equal(applyingPool.getProxyByIdWithAuth(removingId), null)
      beforeInspectionRestarts = restarts
      await stop(servers[0])
      applyingPool.startManagedMonitor()
      try {
        for (
          let i = 0;
          i < 1000 && applyingPool.snapshot().proxies.find((p) => p.id === exits[0].id).exit_status === 'ready';
          i++
        )
          await delay(10)
        const status = applyingPool.snapshot().proxies
        assert.equal(status.find((p) => p.id === exits[0].id).exit_status, 'unavailable')
        assert.equal(status.find((p) => p.id === exits[0].id).application_status, 'applied')
        assert.equal(status.find((p) => p.id === exits[1].id).exit_status, 'ready')
      } finally {
        applyingPool.stopManagedMonitor()
      }
      servers[0] = await start(
        'upstream-0-monitor-recovered',
        JSON.parse(await readFile(path.join(dir, 'upstream-0.json'), 'utf8')),
      )
      await applyingPool.inspectManaged()
      assert.ok(boundProxyUrl(snapshot))
      assert.equal(restarts, beforeInspectionRestarts)
      await stop(client)
      assert.equal((await applyingPool.inspectManaged()).ok, false)
      assert.ok(
        applyingPool
          .snapshot()
          .proxies.filter((p) => p.managed)
          .every((p) => p.runtime_status === 'unavailable'),
      )
      // Simulate a service restarted by its supervisor, then reconcile without another restart.
      client = await start(
        'client-monitor-recovered',
        JSON.parse(await readFile(path.join(hostDir, 'config.json'), 'utf8')),
      )
      await applyingPool.inspectManaged()
      assert.ok(boundProxyUrl(snapshot))
      allowDrain = false
      const poolTimeout = await applyingPool.applyManaged()
      assert.equal(poolTimeout.ok, false)
      assert.equal(poolTimeout.error, 'managed_drain_timeout')
      assert.ok(boundProxyUrl(snapshot), 'verified unchanged routes must resume after timeout')
      allowDrain = true
      const ready = await manager.apply(exits)
      assert.equal(ready.status, 'ready')
      assert.equal(ready.desired_version, ready.applied_version)
      const active = await readFile(path.join(hostDir, 'config.json'), 'utf8')
      const restartCount = restarts
      corruptCandidate = true
      assert.equal((await manager.apply(exits)).error, 'managed_candidate_failed')
      assert.equal(restarts, restartCount)
      corruptCandidate = false
      pendingRequest = request(exits[0], exits[0].password, '/held')
      await heldStarted
      const drainingApply = applyingPool.applyManaged()
      for (let i = 0; i < 100 && manager.state().status !== 'draining'; i++) await delay(10)
      assert.equal(manager.state().status, 'draining')
      assert.equal(paused, true)
      assert.equal(restarts, restartCount)
      let editFinished = false
      const concurrentEdit = applyingPool
        .updateManaged(exits[0].id, { config: { password: 'concurrent-wrong-upstream' } })
        .then((result) => {
          editFinished = true
          return result
        })
      await delay(30)
      assert.equal(editFinished, false, 'a distinct edit must wait for the draining apply')
      assert.equal(
        applyingPool.state.proxies.find((row) => row.id === exits[0].id).managed_config.password,
        exits[0].config.password,
      )
      releaseOrigin()
      assert.equal(await pendingRequest, 'controlled-origin')
      pendingRequest = null
      assert.equal((await drainingApply).ok, true)
      assert.equal((await concurrentEdit).ok, true)
      assert.equal(
        applyingPool.state.proxies.find((row) => row.id === exits[0].id).managed_config.password,
        'concurrent-wrong-upstream',
      )
      assert.equal(applyingPool.snapshot().proxies.find((row) => row.id === exits[0].id).application_status, 'pending')
      assert.equal(await readFile(path.join(hostDir, 'config.json'), 'utf8'), active)
      for (const exit of exits) assert.equal(await request(exit), 'controlled-origin')
      const rejectedEdit = await applyingPool.applyManaged()
      assert.equal(rejectedEdit.ok, false)
      assert.equal(rejectedEdit.error, 'managed_apply_failed_rolled_back')
      for (const exit of exits) assert.equal(await request(exit), 'controlled-origin')
      assert.equal(
        (await applyingPool.updateManaged(exits[0].id, { config: { password: exits[0].config.password } })).ok,
        true,
      )
      assert.equal((await applyingPool.applyManaged()).ok, true)
      assert.equal(applyingPool.getProxyByIdWithAuth(exits[0].id).port, exits[0].port)
      assert.equal(applyingPool.getProxyByIdWithAuth(exits[0].id).password, exits[0].password)
      const afterDrainRestarts = restarts

      allowDrain = false
      assert.equal((await manager.apply(exits, { drainTimeoutMs: 1 })).error, 'managed_drain_timeout')
      assert.equal(restarts, afterDrainRestarts)
      assert.equal(await readFile(path.join(hostDir, 'config.json'), 'utf8'), active)
      allowDrain = true
      const bad = structuredClone(exits)
      bad[0].config.password = 'wrong-upstream-password'
      const rolledBack = await manager.apply(bad)
      assert.equal(rolledBack.status, 'ready')
      assert.equal(rolledBack.error, 'managed_apply_failed_rolled_back')
      assert.notEqual(rolledBack.desired_version, rolledBack.applied_version)
      for (const exit of exits) assert.equal(await request(exit), 'controlled-origin')
      const concurrent = await Promise.all([manager.apply(exits), manager.apply(exits)])
      assert.ok(concurrent.every((state) => state.status === 'ready'))
      failDrainRelease = true
      await assert.rejects(manager.apply(exits), /managed_drain_release_failed/)
      assert.equal(manager.state().status, 'unavailable')
      assert.equal((await manager.inspect()).ok, false)
      failDrainRelease = false
      assert.equal((await manager.recover()).status, 'ready')
      await stop(servers[0])
      assert.equal((await manager.apply(exits)).status, 'unavailable')
      assert.equal(paused, true)
      assert.ok(await readFile(path.join(hostDir, 'previous.json'), 'utf8'))
      servers[0] = await start(
        'upstream-0-recovered',
        JSON.parse(await readFile(path.join(dir, 'upstream-0.json'), 'utf8')),
      )
      // Simulate startup with a new manager using the persisted recovery file.
      hostDb.close()
      hostDb = createDatabase({ dbPath: path.join(dir, 'host.db') })
      const recoveredManager = new ManagedEgressHost({ ...hostOptions, db: hostDb })
      assert.equal(recoveredManager.state().status, 'unavailable')
      assert.equal((await recoveredManager.recover()).status, 'ready')
      assert.equal(paused, false)
      const removalPool = new ProxyPool({ db: hostDb })
      removalPool.managedHost = recoveredManager
      removalPool.managedHelperStatus = async () => false
      assert.equal((await removalPool.recoverManaged()).ok, false)
      removalPool.managedHelperStatus = async () => true
      assert.equal((await removalPool.recoverManaged()).ok, true)
      await removalPool.inspectManaged()
      const stableEndpoint = removalPool.getProxyByIdWithAuth(exits[0].id)
      assert.equal(
        (await removalPool.updateManaged(exits[0].id, { config: { password: 'wrong-edited-upstream' } })).ok,
        true,
      )
      const recoverPending = await removalPool.recoverManaged()
      assert.equal(recoverPending.ok, true)
      assert.equal(recoverPending.pending_changes, true)
      assert.equal(removalPool.snapshot().proxies.find((p) => p.id === exits[0].id).application_status, 'pending')
      assert.equal((await removalPool.applyManaged()).ok, false)
      assert.equal(await request(exits[0]), 'controlled-origin')
      assert.equal(
        (await removalPool.updateManaged(exits[0].id, { config: { password: exits[0].config.password } })).ok,
        true,
      )
      assert.equal((await removalPool.applyManaged()).ok, true)
      const afterEdit = removalPool.getProxyByIdWithAuth(exits[0].id)
      assert.equal(afterEdit.port, stableEndpoint.port)
      assert.equal(afterEdit.password, stableEndpoint.password)

      assert.equal((await removalPool.updateManaged(exits[0].id, {}, { remove: true })).ok, true)
      assert.equal(removalPool.getProxyByIdWithAuth(exits[0].id).port, exits[0].port)
      assert.equal((await removalPool.applyManaged()).ok, true)
      assert.equal(removalPool.getProxyByIdWithAuth(exits[0].id), null)
      await assert.rejects(request(exits[0]))
      assert.equal(await request(exits[1]), 'controlled-origin')
      const releasedPort = net.createServer()
      await new Promise((resolve, reject) =>
        releasedPort.once('error', reject).listen(exits[0].port, '127.0.0.1', resolve),
      )
      await new Promise((resolve) => releasedPort.close(resolve))

      // Two logical host identities use separate real processes and configuration
      // directories. This verifies host routing, not a remote Docker deployment.
      const hostB = 'controlled-host-b'
      const hostBDir = path.join(dir, 'host-b')
      await mkdir(hostBDir)
      await writeFile(path.join(hostBDir, 'config.json'), JSON.stringify(managedEgressConfig([])), { mode: 0o600 })
      const hostBExit = { ...exits[1], id: 'controlled-host-b-exit', port: await freePort() }
      removalPool.state.proxies.push({
        ...removalPool.state.proxies.find((p) => p.id === exits[1].id),
        id: hostBExit.id,
        port: hostBExit.port,
        managed_host_id: hostB,
        bound_vm_ids: [],
        bound_vm_id: null,
      })
      removalPool.save()
      removalPool.reload()
      assert.equal(managedEgressIdForUrl(`socks5h://127.0.0.1:${hostBExit.port}`), null)
      let hostBProcess
      let corruptHostB = false
      const managerB = new ManagedEgressHost({
        db: hostDb,
        hostId: hostB,
        configDir: hostBDir,
        runtime: {
          async check(file) {
            if (corruptHostB && path.basename(file) === 'candidate.json') await writeFile(file, 'invalid-json')
            execFileSync(binary, ['check', '-c', file], { stdio: 'pipe' })
          },
          async restart() {
            if (hostBProcess) await stop(hostBProcess)
            hostBProcess = await start(
              'host-b-client',
              JSON.parse(await readFile(path.join(hostBDir, 'config.json'), 'utf8')),
            )
          },
          async verify(config) {
            return verifyManagedListeners(config, { endpoint: `http://127.0.0.1:${origin.address().port}/geo` })
          },
        },
        acquireDrain: async () => acquireManagedDrain({ ids: [hostBExit.id], helpers: [] }),
      })
      removalPool.managedHostFor = async (hostId) => (hostId === hostB ? managerB : null)
      try {
        const hostAActive = await readFile(path.join(hostDir, 'config.json'), 'utf8')
        const hostAVersion = recoveredManager.state().applied_version
        const hostARestarts = restarts
        assert.equal((await removalPool.applyManaged({ hostId: hostB })).ok, true)
        assert.equal(await request(hostBExit), 'controlled-origin')
        assert.equal(await readFile(path.join(hostDir, 'config.json'), 'utf8'), hostAActive)
        assert.equal(recoveredManager.state().applied_version, hostAVersion)
        assert.equal(restarts, hostARestarts)
        const hostBConfig = JSON.parse(await readFile(path.join(hostBDir, 'config.json'), 'utf8'))
        assert.deepEqual(
          hostBConfig.inbounds.map((inbound) => inbound.tag),
          [`in-${hostBExit.id}`],
        )
        assert.notEqual(managerB.state().applied_version, hostAVersion)
        corruptHostB = true
        assert.equal((await removalPool.applyManaged({ hostId: hostB })).ok, false)
        corruptHostB = false
        assert.equal(await request(exits[1]), 'controlled-origin')
        removalPool.managedHostFor = null
        assert.equal((await removalPool.inspectManaged()).ok, false)
        assert.equal(removalPool.snapshot().proxies.find((p) => p.id === exits[1].id).exit_status, 'ready')
        assert.equal(removalPool.snapshot().proxies.find((p) => p.id === hostBExit.id).runtime_status, 'unavailable')
        assert.equal((await removalPool.applyManaged({ hostId: 'missing-host' })).error, 'managed_runtime_unavailable')
        removalPool.managedHostFor = async (hostId) => (hostId === hostB ? managerB : null)
        assert.equal((await removalPool.recoverManaged({ hostId: hostB })).ok, true)
        assert.equal(restarts, hostARestarts)
        assert.equal((await removalPool.updateManaged(exits[1].id, {}, { remove: true })).ok, true)
        assert.equal((await removalPool.applyManaged({ hostId: hostB })).ok, true)
        assert.equal(removalPool.snapshot().proxies.find((p) => p.id === exits[1].id).removal_pending, true)
        assert.equal(await readFile(path.join(hostDir, 'config.json'), 'utf8'), hostAActive)
      } finally {
        if (hostBProcess) await stop(hostBProcess)
      }
    } finally {
      releaseOrigin?.()
      if (pendingRequest) await pendingRequest.catch(() => {})
      await applyingPool?.whenManagedIdle()
      await manager.queue
      hostDb.close()
    }

    await stop(servers[0])
    await assert.rejects(request(exits[0]))
    assert.equal(await request(exits[1]), 'controlled-origin')
    await stop(client)
    for (const exit of exits) await assert.rejects(request(exit))
    const artifactDir = path.resolve('.tmp/managed-egress-e2e')
    await mkdir(artifactDir, { recursive: true })
    await writeFile(
      path.join(artifactDir, 'receipt.json'),
      JSON.stringify(
        {
          source: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
          working_tree: 'includes uncommitted changes',
          source_files: Object.fromEntries(
            await Promise.all(
              [
                'src/lib/vm/managed-egress-admission.mjs',
                'src/lib/vm/managed-egress-helper-absence.mjs',
                'src/lib/vm/proxy-geo.mjs',
                'src/lib/protocol/codex-models.mjs',
                'src/server.mjs',
                'src/lib/vm/vm-registry.mjs',
                'src/lib/vm/proxy-resolve.mjs',
                'src/lib/vm/managed-egress-host.mjs',
                'src/lib/vm/managed-egress-docker.mjs',
                'src/lib/vm/managed-egress-readiness.mjs',
                'src/lib/vm/managed-egress-config.mjs',
                'src/lib/vm/proxy-pool.mjs',
                'src/lib/vm/proxy-policy.mjs',
                'src/lib/db/repos/proxies-repo.mjs',
                'src/lib/db/migrations/049_managed_egress.sql',
                'src/lib/db/migrations/050_managed_egress_removal.sql',
                'deploy/init-managed-egress.sh',
                'docker-compose.yml',
                'docker-compose.arm64.yml',
                'deploy/install.sh',
                'scripts/panel-upgrade.sh',
              ].map(async (file) => [
                file,
                createHash('sha256')
                  .update(await readFile(file))
                  .digest('hex'),
              ]),
            ),
          ),
          converter_sha256: createHash('sha256')
            .update(await readFile(new URL('../../src/lib/vm/managed-egress-config.mjs', import.meta.url)))
            .digest('hex'),
          test_sha256: createHash('sha256')
            .update(await readFile(new URL(import.meta.url)))
            .digest('hex'),
          binary_sha256: createHash('sha256')
            .update(await readFile(binary))
            .digest('hex'),
          binary_version: execFileSync(binary, ['version'], { encoding: 'utf8' }).split('\n')[0],
          environment: `${process.platform}/${process.arch}`,
          scope: 'real local Hysteria 2 processes; no slots or Claude requests',
          command: 'SING_BOX_BIN=/path/to/sing-box node --test test/e2e/managed-egress.e2e.test.mjs',
          results: {
            simultaneous_runtime_helper_loss: process.env.KIN_EGRESS_TEST_BIN
              ? 'real stopped shared process and bound helper recovered; live PID and unknown TCP/UDP listeners reject absence proof; pending desired edit retained and blocked; applied routes and binding preserved'
              : 'NOT RUN: helper binary missing',
            missing_helper_repair: process.env.KIN_EGRESS_TEST_BIN
              ? 'verified applied settings rebuild a real missing helper; desired mismatch denied, failed repair retains binding, ordinary requests remain blocked during repair, maintenance drains, shared instance unchanged'
              : 'NOT RUN: helper binary missing',
            per_host_lifecycle:
              'two logical host identities with separate real sing-box processes; apply/recover, versions, missing-manager failure, healthy-host inspection and tombstone isolation passed; not remote deployment',
            bootstrap: 'created and validated; existing files preserved',
            persistence: 'encrypted settings and credentials restored; IDs, bindings, host and ports preserved',
            pending_runtime: 'binding blocked and listener details redacted',
            empty_start: 'passed',
            two_routes: 'passed',
            combined_helper_apply: process.env.KIN_EGRESS_TEST_BIN
              ? 'real kin-egress DNS through Hysteria 2; host request and DNS finish before restart; timeout preserves process'
              : 'NOT RUN: KIN_EGRESS_TEST_BIN missing',
            host_fetch:
              'response body retained lease; paused geo rejected; runtime verification bypassed gate; destroyed body released lease',
            removal:
              'pending removal retains port across reload; verified apply removes active listener and releases port',
            monitoring:
              'read-only startup reconciliation, isolated node failure, shared-process failure and recovery passed',
            lifecycle:
              'serialized apply, drain timeout, verified rollback, failed rollback isolation and recovery passed',
            concurrent_distinct_edit:
              'edit queued during held-request drain; later desired config remains pending; old route preserved; bad edit rolls back; corrected edit applies with stable listener',
            wrong_listener_auth: 'rejected',
            upstream_failure: 'isolated',
            client_stop: 'no direct fallback',
          },
        },
        null,
        2,
      ),
    )
  } finally {
    releaseDns?.()
    releaseFetch?.()
    releaseOrigin?.()
    for (const child of children) await stop(child)
    await new Promise((resolve) => origin.close(resolve))
    await rm(dir, { recursive: true, force: true })
  }
})
