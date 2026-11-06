import { startRemoteEgressDrain } from '../../src/lib/cluster/managed-egress-drain.mjs'
import { RemoteManagedEgressHosts } from '../../src/lib/cluster/managed-egress-hosts.mjs'
import { remoteEgressProxyUrl } from '../../src/lib/cluster/remote-egress-proxy.mjs'
import { ensureRemoteEgress, slotEgressNames } from '../../src/lib/cluster/remote-slot.mjs'
import { bindVmProxy } from '../../src/lib/vm/vm-registry.mjs'
import { RemoteManagedEgressDocker } from '../../src/lib/cluster/managed-egress-runtime.mjs'
import { MANAGED_EGRESS_IMAGE, ManagedEgressDocker } from '../../src/lib/vm/managed-egress-docker.mjs'
import { ManagedEgressHost } from '../../src/lib/vm/managed-egress-host.mjs'
import { managedEgressConfig } from '../../src/lib/vm/managed-egress-config.mjs'
import { createDatabase } from '../../src/lib/db/database.mjs'
import { ProxiesRepo } from '../../src/lib/db/repos/proxies-repo.mjs'
import { ProxyPool } from '../../src/lib/vm/proxy-pool.mjs'
import { execCollect } from '../../src/lib/cluster/ssh-link.mjs'
import { shellQuote } from '../../src/lib/cluster/remote-fs.mjs'
import { RemoteManagedEgressFiles } from '../../src/lib/cluster/managed-egress-files.mjs'
import test from 'node:test'
import assert from 'node:assert/strict'
import ssh2 from 'ssh2'
const { Server, Client } = ssh2
import { spawn, execFileSync } from 'node:child_process'
import { createHash, randomBytes } from 'node:crypto'
import net from 'node:net'
import dgram from 'node:dgram'
import http from 'node:http'
import path from 'node:path'
import { tmpdir } from 'node:os'
import { existsSync } from 'node:fs'
import { mkdtemp, readFile, writeFile, mkdir, rm, stat, symlink, readdir } from 'node:fs/promises'
import { startRemoteManagedEgressEndpoint } from '../../src/lib/cluster/managed-egress-endpoint.mjs'
import { verifyManagedProxyGeo, lookupProxyGeo } from '../../src/lib/vm/proxy-geo.mjs'
import { makeProxyFetch } from '../../src/lib/protocol/codex-models.mjs'
import {
  setManagedEgressReady,
  managedEgressReady,
  managedEgressIdForUrl,
  registerManagedEgressEndpoint,
} from '../../src/lib/vm/managed-egress-readiness.mjs'

const binary = process.env.SING_BOX_BIN
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
test('host requests reach a selected remote SOCKS listener through real SSH forwarding', {
  skip: !binary,
  timeout: 20000,
}, async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'managed-remote-'))
  const coordinatorDir = await mkdtemp('/tmp/vm2api-me-')
  let releaseHeld
  let dnsRequests = 0
  const largeBody = Buffer.alloc(1024 * 1024, 0x5a)
  const origin = http.createServer((req, res) => {
    if (req.url === '/slot-dns') {
      dnsRequests++
      const chunks = []
      req.on('data', (chunk) => chunks.push(chunk))
      req.on('end', () => {
        const response = Buffer.concat(chunks)
        response[2] |= 0x80
        res.writeHead(200, { 'content-type': 'application/dns-message' })
        res.end(response)
      })
      return
    }
    if (req.url === '/large') {
      res.end(largeBody)
      return
    }
    if (req.url === '/held') {
      res.write('partial')
      releaseHeld = () => res.end('finished')
      return
    }
    res.end(JSON.stringify({ query: '127.0.0.1', marker: 'controlled-node-route' }))
  })
  await new Promise((resolve) => origin.listen(0, '127.0.0.1', resolve))
  const reserve = net.createServer()
  await new Promise((resolve) => reserve.listen(0, '127.0.0.1', resolve))
  const remotePort = reserve.address().port
  await new Promise((resolve) => reserve.close(resolve))
  const client = new Client()
  let ssh
  let socks
  let bridge
  let replacement
  let dockerFixturePath
  let fixtureBin
  let remoteDrain
  let coordinator
  let coordinatorDb
  let secondClient
  let coordinationVersions = null
  let helperChannel
  let helperRunning = false
  const allowedControlPaths = new Set()
  const subprocesses = new Set()
  const remoteCommands = []
  const sftpBinary = ['/usr/libexec/sftp-server', '/usr/lib/openssh/sftp-server', '/usr/lib/ssh/sftp-server'].find(
    existsSync,
  )
  const peers = new Set()
  const streams = new Set()
  let forwards = 0
  let linkReady = true
  try {
    const key = path.join(dir, 'host-key')
    execFileSync('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-f', key], { stdio: 'ignore' })
    const publicBlob = Buffer.from((await readFile(`${key}.pub`, 'utf8')).split(' ')[1], 'base64')
    const pinnedHash = createHash('sha256').update(publicBlob).digest('hex')
    const config = path.join(dir, 'socks.json')
    await writeFile(
      config,
      JSON.stringify({
        log: { disabled: true },
        inbounds: [
          {
            type: 'socks',
            listen: '127.0.0.1',
            listen_port: remotePort,
            users: [{ username: 'controlled-user', password: 'controlled-remote-password' }],
          },
        ],
        outbounds: [{ type: 'direct' }],
      }),
      { mode: 0o600 },
    )
    socks = spawn(binary, ['run', '-c', config], { stdio: 'ignore' })
    await delay(300)
    ssh = new Server({ hostKeys: [await readFile(key)] }, (peer) => {
      peers.add(peer)
      peer.on('error', () => {})
      peer.on('close', () => peers.delete(peer))
      peer.on('authentication', (ctx) => {
        if (ctx.method === 'password' && ctx.username === 'controlled' && ctx.password === 'controlled-ssh-password')
          ctx.accept()
        else ctx.reject()
      })
      peer.on('ready', () =>
        peer.on('openssh.streamlocal', (accept, reject, info) => {
          if (!allowedControlPaths.has(info.socketPath)) {
            reject()
            return
          }
          const channel = accept()
          const target = net.connect({ path: info.socketPath })
          streams.add(target)
          target.on('error', () => channel.destroy())
          channel.on('error', () => target.destroy())
          target.on('close', () => {
            streams.delete(target)
            channel.end()
          })
          channel.on('close', () => target.destroy())
          channel.pipe(target).pipe(channel)
        }),
      )
      peer.on('ready', () =>
        peer.on('session', (accept) => {
          const session = accept()
          function run(channel, executable, args) {
            const child = spawn(executable, args, {
              stdio: ['pipe', 'pipe', 'pipe'],
              env: {
                ...process.env,
                ...(fixtureBin
                  ? { PATH: `${fixtureBin}:${process.env.PATH}`, MANAGED_DOCKER_FIXTURE: dockerFixturePath }
                  : {}),
              },
            })
            subprocesses.add(child)
            channel.pipe(child.stdin)
            child.stdout.pipe(channel, { end: false })
            child.stderr.pipe(channel.stderr, { end: false })
            child.stdin.on('error', () => {})
            channel.on('error', () => {})
            channel.once('close', () => {
              if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM')
            })
            child.once('close', (code) => {
              subprocesses.delete(child)
              channel.exit(code || 0)
              channel.end()
            })
          }
          session.on('exec', (accept, _reject, info) => {
            remoteCommands.push(info.command)
            run(accept(), '/bin/sh', ['-c', info.command])
          })
          session.on('subsystem', (accept, reject, info) => {
            if (info.name !== 'sftp' || !sftpBinary) {
              reject()
              return
            }
            run(accept(), sftpBinary, [])
          })
        }),
      )
      peer.on('ready', () =>
        peer.on('tcpip', (accept, reject, info) => {
          if (info.destIP !== '127.0.0.1' || info.destPort !== remotePort) {
            reject()
            return
          }
          forwards++
          const channel = accept()
          const target = net.connect({ host: info.destIP, port: info.destPort })
          streams.add(target)
          target.on('error', () => channel.destroy())
          target.on('close', () => {
            streams.delete(target)
            channel.destroy()
          })
          channel.on('error', () => target.destroy())
          channel.on('close', () => target.destroy())
          channel.pipe(target).pipe(channel)
        }),
      )
    })
    await new Promise((resolve) => ssh.listen(0, '127.0.0.1', resolve))
    client.on('error', () => {})
    await new Promise((resolve, reject) => {
      client.once('ready', resolve)
      client.once('error', reject)
      client.connect({
        host: '127.0.0.1',
        port: ssh.address().port,
        username: 'controlled',
        password: 'controlled-ssh-password',
        hostHash: 'sha256',
        hostVerifier: (hash) => hash === pinnedHash,
      })
    })
    if (sftpBinary) {
      const root = path.join(dir, "remote host's config")
      const files = new RemoteManagedEgressFiles({ nodeId: 'controlled-node', root, clientFor: async () => client })
      const secret = 'controlled-secret-over-sftp-only'
      await files.ensure()
      assert.equal((await stat(root)).mode & 0o777, 0o700)
      await assert.rejects(files.read('config.json'), { code: 'ENOENT' })
      const text = JSON.stringify({ marker: secret })
      await files.atomic('config.json', text)
      assert.equal((await stat(path.join(root, 'config.json'))).mode & 0o777, 0o600)
      assert.equal(await files.read('config.json'), text)
      await files.atomic('config.json', JSON.stringify({ marker: 'replaced' }))
      assert.equal(JSON.parse(await files.read('config.json')).marker, 'replaced')
      const largeTransfer = randomBytes(1024 * 1024 + 73).toString('base64')
      await files.atomic('config.json', largeTransfer)
      assert.equal(await readFile(path.join(root, 'config.json'), 'utf8'), largeTransfer)
      const rejectedDestination = path.join(root, 'candidate.json')
      await mkdir(rejectedDestination)
      await writeFile(path.join(rejectedDestination, 'preserved'), 'previous-destination')
      await assert.rejects(files.atomic('candidate.json', largeTransfer))
      assert.equal(await readFile(path.join(rejectedDestination, 'preserved'), 'utf8'), 'previous-destination')
      assert.ok((await readdir(root)).every((name) => !name.startsWith('.kin-')))
      await rm(rejectedDestination, { recursive: true })
      const outside = path.join(dir, 'outside.json')
      await writeFile(outside, 'outside-unchanged')
      await symlink(outside, path.join(root, 'previous.json'))
      await assert.rejects(files.read('previous.json'), /managed_remote_read_failed/)
      await files.atomic('previous.json', text)
      assert.equal(await readFile(outside, 'utf8'), 'outside-unchanged')
      assert.equal(await files.read('previous.json'), text)
      await assert.rejects(files.atomic('../escape.json', text), /managed_remote_file_invalid/)
      await files.remove('previous.json')
      await files.remove('previous.json')
      assert.ok(remoteCommands.every((command) => !command.includes(secret)))
      await files.atomic('config.json', JSON.stringify(managedEgressConfig([])))
      const databasePath = path.join(dir, 'host.db')
      let database = createDatabase({ dbPath: databasePath })
      let remoteRun
      let remoteRunning = false
      let corruptCandidate = false
      let allowDrain = true
      const runtime = {
        async check(file) {
          if (corruptCandidate && path.basename(file) === 'candidate.json')
            await files.atomic('candidate.json', 'invalid-json')
          const result = await execCollect(client, `${shellQuote(binary)} check -c ${shellQuote(file)} >/dev/null 2>&1`)
          if (result.code !== 0) throw new Error('controlled_remote_check_failed')
        },
        async restart() {
          if (remoteRun && remoteRunning)
            await new Promise((resolve) => {
              remoteRun.once('close', resolve)
              remoteRun.close()
            })
          remoteRun = await new Promise((resolve, reject) =>
            client.exec(
              `exec ${shellQuote(binary)} run -c ${shellQuote(files.file('config.json'))}`,
              (error, channel) => (error ? reject(error) : resolve(channel)),
            ),
          )
          remoteRunning = true
          remoteRun.once('close', () => {
            remoteRunning = false
          })
          remoteRun.on('error', () => {})
          remoteRun.on('data', () => {})
          remoteRun.stderr.on('data', () => {})
          await delay(80)
        },
        async verify(config) {
          assert.ok(remoteRun && remoteRunning, 'remote process must remain running')
          return []
        },
      }
      const options = {
        db: database,
        hostId: 'controlled-node',
        configDir: root,
        files,
        runtime,
        acquireDrain: async () => ({ wait: async () => allowDrain, release: async () => {} }),
      }
      let lifecycle = new ManagedEgressHost(options)
      try {
        const applied = await lifecycle.apply([])
        assert.equal(applied.status, 'ready')
        assert.equal(applied.desired_version, applied.applied_version)
        const activeText = await files.read('config.json')
        corruptCandidate = true
        assert.equal((await lifecycle.apply([])).error, 'managed_candidate_failed')
        assert.equal(await files.read('config.json'), activeText)
        corruptCandidate = false
        allowDrain = false
        assert.equal((await lifecycle.apply([])).error, 'managed_drain_timeout')
        assert.equal(await files.read('config.json'), activeText)
        allowDrain = true
        const occupied = net.createServer()
        await new Promise((resolve) => occupied.listen(0, '127.0.0.1', resolve))
        try {
          const failed = await lifecycle.apply([
            {
              id: 'remote-port-conflict',
              protocol: 'hysteria2',
              port: occupied.address().port,
              username: 'generated-test-user',
              password: 'generated-test-password',
              config: { server: '127.0.0.1', server_port: 443, password: secret, insecure: true },
            },
          ])
          assert.equal(failed.error, 'managed_apply_failed_rolled_back')
          assert.equal(failed.status, 'ready')
          assert.notEqual(failed.desired_version, failed.applied_version)
          assert.equal(await files.read('config.json'), activeText)
        } finally {
          await new Promise((resolve) => occupied.close(resolve))
        }
        await files.atomic('previous.json', activeText)
        await files.atomic('config.json', 'interrupted-invalid-config')
        lifecycle.record({ status: 'applying' })
        database.close()
        database = createDatabase({ dbPath: databasePath })
        lifecycle = new ManagedEgressHost({ ...options, db: database })
        assert.equal((await lifecycle.recover()).status, 'ready')
        assert.equal(await files.read('config.json'), activeText)
        await assert.rejects(files.read('previous.json'), { code: 'ENOENT' })
        assert.ok(remoteCommands.every((command) => !command.includes(secret)))
      } finally {
        if (remoteRun && remoteRunning)
          await new Promise((resolve) => {
            remoteRun.once('close', resolve)
            remoteRun.close()
          })
        database.close()
      }
    }
    const options = {
      id: 'controlled-remote-exit',
      nodeId: 'controlled-node',
      port: remotePort,
      clientFor: async (node) => {
        assert.equal(node, 'controlled-node')
        return linkReady ? client : null
      },
    }
    bridge = await startRemoteManagedEgressEndpoint(options)
    const urlFor = (endpoint) => `socks5h://controlled-user:controlled-remote-password@127.0.0.1:${endpoint.port}`
    const originUrl = `http://127.0.0.1:${origin.address().port}/`
    // The Docker command fixture exercises SSH transport and real config checking.
    // It does not supply container isolation or a real Docker restart.
    fixtureBin = path.join(dir, 'fixture-bin')
    await mkdir(fixtureBin)
    dockerFixturePath = path.join(dir, 'docker-fixture.json')
    const root = path.join(dir, "remote host's config")
    const containerId = 'c'.repeat(64)
    const metadata = {
      Id: containerId,
      Config: {
        Image: MANAGED_EGRESS_IMAGE,
        Labels: {
          'com.docker.compose.project': 'controlled-managed',
          'com.docker.compose.service': 'sing-box',
          'vm2api.managed-egress.node': 'controlled-node',
        },
      },
      Mounts: [{ Source: root, Destination: '/var/lib/vm2api-egress', RW: false }],
      HostConfig: { NetworkMode: 'host', ReadonlyRootfs: true, Privileged: false, CapAdd: [] },
      State: { Running: true },
    }
    const fixture = {
      dockerBinary: execFileSync('/bin/sh', ['-c', 'command -v docker'], { encoding: 'utf8' }).trim(),
      ids: [containerId],
      metadata,
      binary,
      root,
      log: path.join(dir, 'docker-commands.jsonl'),
    }
    await writeFile(
      path.join(fixtureBin, 'docker'),
      String.raw`#!/usr/bin/env node
const fs = require('node:fs'); const cp = require('node:child_process'); const path = require('node:path');
const fixture = JSON.parse(fs.readFileSync(process.env.MANAGED_DOCKER_FIXTURE, 'utf8'));
const args = process.argv.slice(2); fs.appendFileSync(fixture.log, JSON.stringify(args) + '\n');
if (args[0] === 'ps') process.stdout.write((args.includes('label=kin.egress=1') ? (fixture.helperIds || []) : fixture.ids).join('\n'));
else if (args[0] === 'network' && args[1] === 'inspect') process.stdout.write(JSON.stringify((fixture.networks || []).filter(network => args.slice(2).includes(network.Name))));
else if (args[0] === 'inspect') process.stdout.write(fixture.inspectRaw || JSON.stringify(args.slice(1).map(id => id === fixture.controlName ? fixture.control : fixture.helpers?.find(helper => helper.Id === id) || fixture.metadata)));
else if (args[0] === 'run') { try { cp.execFileSync(fixture.binary, ['check', '-c', path.join(fixture.root, path.basename(args[args.indexOf('-c') + 1]))], {stdio:'pipe'}); } catch { process.exit(1); } }
else if (args[0] === 'compose') {
 const action = args.indexOf('run') >= 0 ? 'run' : 'up';
 try {
  cp.execFileSync(fixture.dockerBinary, [...args.slice(0, args.indexOf(action)), 'config', '--format', 'json'], {stdio:'pipe'});
  if (action === 'run') cp.execFileSync(fixture.binary, ['check', '-c', path.join(fixture.root, 'config.json')], {stdio:'pipe'});
  if (action === 'up') {
   if (fixture.failProvision) process.exit(11);
   fixture.ids = [fixture.metadata.Id]; fs.writeFileSync(process.env.MANAGED_DOCKER_FIXTURE, JSON.stringify(fixture));
  }
 } catch { process.exit(1); }
}
else if (args[0] === 'restart' && fixture.failRestart) process.exit(10);
else if (args[0] === 'restart' && fixture.startOnRestart) {
 fixture.metadata.State.Running=true; fs.writeFileSync(process.env.MANAGED_DOCKER_FIXTURE, JSON.stringify(fixture));
}
else if (args[0] === 'restart' && fixture.controlSocket) {
 const req = require('node:http').get({socketPath: fixture.controlSocket, path:'/status', agent:false}, res => {
  let body=''; res.on('data', chunk => body += chunk); res.on('end', () => {
   try { if (!JSON.parse(body).paused) process.exitCode=7; } catch { process.exitCode=8; }
  });
 }); req.on('error', () => { process.exitCode=9; }); req.setTimeout(1000, () => req.destroy());
}
else if (args[0] !== 'restart') process.exit(2);
`,
      { mode: 0o700 },
    )
    await writeFile(path.join(fixtureBin, 'iptables'), String.raw`#!/usr/bin/env node
const fs = require('node:fs');
const fixture = JSON.parse(fs.readFileSync(process.env.MANAGED_DOCKER_FIXTURE, 'utf8'));
// Command contract only. Real Linux rules/traffic are covered by separate E2Es.
if (!process.argv.slice(2).includes('-C') || !fixture.networks?.length) process.exit(2);
`, { mode: 0o700 })
    const saveFixture = () => writeFile(dockerFixturePath, JSON.stringify(fixture))
    await writeFile(
      path.join(fixtureBin, 'ss'),
      String.raw`#!/usr/bin/env node
const f = JSON.parse(require('node:fs').readFileSync(process.env.MANAGED_DOCKER_FIXTURE,'utf8'));
if (f.ssFailure) process.exit(1);
process.stdout.write(f.ssRaw ?? (f.busyPorts || []).map(port => 'LISTEN 0 128 127.0.0.1:' + port + ' 0.0.0.0:*').join('\n'));
`,
      { mode: 0o700 },
    )
    await saveFixture()
    const remoteRuntime = new RemoteManagedEgressDocker({
      nodeId: 'controlled-node',
      root,
      project: 'controlled-managed',
      clientFor: async () => client,
      endpointFor: async ({ nodeId, port }) => {
        assert.equal(nodeId, 'controlled-node')
        assert.equal(port, remotePort)
        return bridge
      },
    })
    const previousGeoUrl = process.env.KIN_PROXY_GEO_URL
    process.env.KIN_PROXY_GEO_URL = originUrl
    try {
      if (sftpBinary) {
        const store = new RemoteManagedEgressFiles({ nodeId: 'controlled-node', root, clientFor: async () => client })
        const activeBeforeProvision = await store.read('config.json')
        assert.equal((await remoteRuntime.provision(store)).image, MANAGED_EGRESS_IMAGE)
        assert.equal(await store.read('config.json'), activeBeforeProvision)
        const manifest = JSON.parse(await store.read('compose.json'))
        assert.equal(manifest.services['sing-box'].network_mode, 'host')
        assert.equal(manifest.services['sing-box'].volumes[0].read_only, true)
        await store.atomic('candidate.json', JSON.stringify(managedEgressConfig([])))
        const cliProbe = await execCollect(client, 'docker ps -aq')
        assert.equal(cliProbe.code, 0, cliProbe.stderr)
        await remoteRuntime.check(store.file('candidate.json'))
        await remoteRuntime.restart()
        const observed = await remoteRuntime.verify({
          inbounds: [
            {
              type: 'socks',
              tag: 'in-controlled-remote-exit',
              listen: '127.0.0.1',
              listen_port: remotePort,
              users: [{ username: 'controlled-user', password: 'controlled-remote-password' }],
            },
          ],
        })
        assert.equal(observed.length, 1)
        fixture.inspectRaw = 'invalid-inspect-private-marker'
        await saveFixture()
        await assert.rejects(remoteRuntime.locate(), { message: 'managed_remote_inspect_failed' })
        delete fixture.inspectRaw
        fixture.metadata.Config.Image = 'unexpected-image'
        await saveFixture()
        await assert.rejects(remoteRuntime.locate(), /identity_mismatch/)
        fixture.metadata.Config.Image = MANAGED_EGRESS_IMAGE
        fixture.metadata.Mounts[0].RW = true
        await saveFixture()
        await assert.rejects(remoteRuntime.locate(), /mount_mismatch/)
        fixture.metadata.Mounts[0].RW = false
        fixture.metadata.HostConfig.Privileged = true
        await saveFixture()
        await assert.rejects(remoteRuntime.locate(), /isolation_mismatch/)
        fixture.metadata.HostConfig.Privileged = false
        fixture.metadata.Mounts.push({ Source: '/var/run/docker.sock', Destination: '/engine', RW: false })
        await saveFixture()
        await assert.rejects(remoteRuntime.locate(), /isolation_mismatch/)
        fixture.metadata.Mounts.pop()
        fixture.ids.push('d'.repeat(64))
        await saveFixture()
        await assert.rejects(remoteRuntime.locate(), /missing_or_ambiguous/)
        fixture.ids.pop()
        fixture.metadata.State.Running = false
        await saveFixture()
        await assert.rejects(remoteRuntime.locate(), /not_running/)
        await remoteRuntime.check(store.file('candidate.json'))
        fixture.metadata.State.Running = true
        fixture.ids = ['e'.repeat(64)]
        await saveFixture()
        await assert.rejects(remoteRuntime.restart(), /replaced/)
        fixture.ids = [containerId]
        await saveFixture()
        const previousPath = process.env.PATH
        const previousFixture = process.env.MANAGED_DOCKER_FIXTURE
        process.env.PATH = `${fixtureBin}:${previousPath}`
        process.env.MANAGED_DOCKER_FIXTURE = dockerFixturePath
        fixture.controlName = 'controlled-local-api'
        fixture.control = {
          Config: { Labels: { 'com.docker.compose.project': 'controlled-managed' } },
          Mounts: [{ Source: path.dirname(root), Destination: '/control-data', RW: true }],
          HostConfig: { NetworkMode: 'host' },
        }
        const localDir = `/control-data/${path.basename(root)}`
        const localRuntime = new ManagedEgressDocker({ configDir: localDir, controlContainer: fixture.controlName })
        try {
          fixture.metadata.State.Running = false
          fixture.startOnRestart = true
          await saveFixture()
          await assert.rejects(localRuntime.locate(), /managed_runtime_not_running/)
          await localRuntime.check(`${localDir}/candidate.json`)
          assert.equal(
            JSON.parse(await readFile(dockerFixturePath, 'utf8')).metadata.State.Running,
            false,
            'offline check must not start the stopped service',
          )
          const commandLog = (await readFile(fixture.log, 'utf8'))
            .trim()
            .split('\n')
            .map((line) => JSON.parse(line))
          const localCheck = commandLog.findLast((args) => args[0] === 'run')
          assert.equal(localCheck[localCheck.indexOf('--volume') + 1], `${root}:/var/lib/vm2api-egress:ro`)
          assert.equal(localCheck[localCheck.indexOf('--network') + 1], 'none')
          assert.equal(localCheck.includes(MANAGED_EGRESS_IMAGE), true)
          await localRuntime.restart()
          fixture.metadata.State.Running = true
          assert.deepEqual(await localRuntime.verify({ inbounds: [] }), [])
          fixture.ids = ['b'.repeat(64)]
          await saveFixture()
          await assert.rejects(localRuntime.restart(), /managed_runtime_replaced/)
          fixture.ids = [containerId]
          fixture.metadata.Mounts[0].RW = true
          await saveFixture()
          await assert.rejects(localRuntime.check(`${localDir}/candidate.json`), /managed_runtime_mount_mismatch/)
          await assert.rejects(localRuntime.restart(), /managed_runtime_not_checked/)
          fixture.metadata.Mounts[0].RW = false
          fixture.metadata.HostConfig.Privileged = true
          await saveFixture()
          await assert.rejects(localRuntime.locate(), /managed_runtime_isolation_mismatch/)
          fixture.metadata.HostConfig.Privileged = false
          fixture.metadata.Mounts.push({ Source: '/var/run/docker.sock', Destination: '/docker', RW: false })
          await saveFixture()
          await assert.rejects(localRuntime.locate(), /managed_runtime_isolation_mismatch/)
          fixture.metadata.Mounts.pop()
          fixture.metadata.Config.Labels['com.docker.compose.service'] = 'wrong-service'
          await saveFixture()
          await assert.rejects(localRuntime.locate(), /managed_runtime_identity_mismatch/)
          fixture.metadata.Config.Labels['com.docker.compose.service'] = 'sing-box'
          fixture.inspectRaw = 'private-inspection-marker'
          await saveFixture()
          await assert.rejects(localRuntime.locate(), { message: 'managed_docker_inspect_failed' })
          delete fixture.inspectRaw
          await assert.rejects(localRuntime.check('/different/candidate.json'), /managed_candidate_path_invalid/)
        } finally {
          process.env.PATH = previousPath
          if (previousFixture === undefined) delete process.env.MANAGED_DOCKER_FIXTURE
          else process.env.MANAGED_DOCKER_FIXTURE = previousFixture
          delete fixture.startOnRestart
          await saveFixture()
        }
      }
    } finally {
      if (previousGeoUrl === undefined) delete process.env.KIN_PROXY_GEO_URL
      else process.env.KIN_PROXY_GEO_URL = previousGeoUrl
    }

    assert.equal((await verifyManagedProxyGeo(urlFor(bridge), { endpoint: originUrl })).ok, true)
    setManagedEgressReady(options.id, true)
    assert.equal((await (await makeProxyFetch(urlFor(bridge))(originUrl)).json()).marker, 'controlled-node-route')
    assert.ok(forwards >= 2)
    const largeResponse = await makeProxyFetch(urlFor(bridge))(`${originUrl}large`)
    assert.deepEqual(await largeResponse.buffer(), largeBody)
    await assert.rejects(
      makeProxyFetch(urlFor(bridge).replace('controlled-remote-password', 'wrong-password'))(originUrl),
    )
    assert.equal(managedEgressReady(options.id), true)
    replacement = await startRemoteManagedEgressEndpoint(options)
    assert.equal((await verifyManagedProxyGeo(urlFor(replacement), { endpoint: originUrl })).ok, true)
    setManagedEgressReady(options.id, true)
    await bridge.close()
    assert.equal(managedEgressReady(options.id), true)
    assert.equal(managedEgressIdForUrl(urlFor(replacement)), options.id)
    assert.equal((await (await makeProxyFetch(urlFor(replacement))(originUrl)).json()).marker, 'controlled-node-route')
    if (process.env.KIN_EGRESS_TEST_BIN) {
      const controlDir = path.join(coordinatorDir, 'vms/vm-one/egress-control')
      await mkdir(controlDir, { recursive: true, mode: 0o700 })
      const remotePath = path.join(controlDir, 'drain.sock')
      const localPath = path.join(dir, 'ld.sock')
      allowedControlPaths.add(remotePath)
      const helperConfig = path.join(dir, 'remote-helper.json')
      const slotProxy = {
        id: options.id,
        managed: true,
        scheme: 'hysteria2',
        managed_host_id: options.nodeId,
        managed_listener_port: remotePort,
        host: replacement.host,
        port: replacement.port,
        url: urlFor(replacement),
        username: 'controlled-user',
        password: 'controlled-remote-password',
      }
      const nodeProxyUrl = remoteEgressProxyUrl(slotProxy, options.nodeId)
      assert.equal(new URL(nodeProxyUrl).port, String(remotePort))
      assert.equal(
        remoteEgressProxyUrl({ ...slotProxy, url: 'socks5h://wrong.invalid:1' }, options.nodeId),
        nodeProxyUrl,
      )
      assert.equal(
        (await ensureRemoteEgress({ nodeId: 'other-node' }, { id: 'vm-one', proxy: slotProxy }, { imageRef: 'unused' }))
          .code,
        'managed_host_mismatch',
      )
      assert.equal(
        (
          await ensureRemoteEgress(
            { nodeId: options.nodeId },
            { id: 'vm-one', proxy: { ...slotProxy, managed_listener_port: null } },
            { imageRef: 'unused' },
          )
        ).code,
        'managed_host_mismatch',
      )
      assert.equal(remoteEgressProxyUrl({ url: urlFor(replacement) }, options.nodeId), urlFor(replacement))
      const dnsReserve = dgram.createSocket('udp4')
      await new Promise((resolve) => dnsReserve.bind(0, '127.0.0.1', resolve))
      const dnsPort = dnsReserve.address().port
      await new Promise((resolve) => dnsReserve.close(resolve))
      await writeFile(
        helperConfig,
        JSON.stringify({
          proxy_id: options.id,
          proxy_url: nodeProxyUrl,
          listen_tcp: '127.0.0.1:0',
          listen_dns: `127.0.0.1:${dnsPort}`,
          dns_upstream: `${originUrl}slot-dns`,
          control_socket: remotePath,
        }),
        { mode: 0o600 },
      )
      const launchHelper = async () => {
        helperChannel = await new Promise((resolve, reject) =>
          client.exec(
            `exec ${shellQuote(process.env.KIN_EGRESS_TEST_BIN)} -config ${shellQuote(helperConfig)}`,
            (error, channel) => (error ? reject(error) : resolve(channel)),
          ),
        )
        helperRunning = true
        helperChannel.once('close', () => {
          helperRunning = false
        })
        helperChannel.on('data', () => {})
        helperChannel.stderr.on('data', () => {})
        helperChannel.on('error', () => {})
        for (let i = 0; i < 100; i++) {
          try {
            await stat(remotePath)
            return
          } catch {
            await delay(10)
          }
        }
        assert.fail('remote helper did not create its socket')
      }
      await launchHelper()
      const forwardsBeforeDns = forwards
      const udp = dgram.createSocket('udp4')
      try {
        const query = Buffer.from([0x44, 0x55, 0x01, 0x00, 0, 1, 0, 0, 0, 0, 0, 0, 0, 0, 1, 0, 1])
        const received = await new Promise((resolve, reject) => {
          const timeout = setTimeout(() => reject(new Error('controlled slot DNS timeout')), 2000)
          udp.once('message', (message) => {
            clearTimeout(timeout)
            resolve(message)
          })
          udp.once('error', (error) => {
            clearTimeout(timeout)
            reject(error)
          })
          udp.send(query, dnsPort, '127.0.0.1')
        })
        const expected = Buffer.from(query)
        expected[2] |= 0x80
        assert.deepEqual(received, expected)
        assert.equal(dnsRequests, 1)
        assert.equal(forwards, forwardsBeforeDns, 'node-side helper must not dial the control-plane bridge')
      } finally {
        udp.close()
      }
      remoteDrain = await startRemoteEgressDrain({
        id: options.id,
        nodeId: options.nodeId,
        remotePath,
        socketPath: localPath,
        getClient: (node) => {
          assert.equal(node, options.nodeId)
          return linkReady ? client : null
        },
      })
      assert.equal((await stat(localPath)).mode & 0o777, 0o600)
      const pinned = await remoteDrain.pause(1000)
      assert.equal((await remoteDrain.status()).paused, true)
      await remoteDrain.resume()
      assert.equal((await remoteDrain.status()).paused, false)
      await new Promise((resolve) => {
        helperChannel.once('close', resolve)
        helperChannel.close()
      })
      for (let i = 0; i < 100 && existsSync(remotePath); i++) await delay(10)
      assert.equal(existsSync(remotePath), false, 'previous helper must remove its socket before replacement')
      await launchHelper()
      await assert.rejects(remoteDrain.resume(), /managed_helper_control_failed/)
      const fresh = await startRemoteEgressDrain({
        id: options.id,
        nodeId: options.nodeId,
        remotePath,
        socketPath: path.join(dir, 'fd.sock'),
        getClient: () => client,
      })
      try {
        const replacementState = await fresh.pause(1000)
        assert.notEqual(replacementState.instance, pinned.instance)
        await fresh.resume()
      } finally {
        await fresh.close()
      }

      if (sftpBinary) {
        let clusterClient = client
        const row = { id: options.id, managed_host_id: options.nodeId, bound_vm_ids: ['vm-one'] }
        coordinatorDb = createDatabase({ dbPath: path.join(coordinatorDir, 'host.db') })
        const relayDir = path.join(coordinatorDir, 's')
        coordinator = new RemoteManagedEgressHosts({
          db: coordinatorDb,
          socketDir: relayDir,
          rowsFor: (nodeId) => (nodeId === options.nodeId ? [row] : []),
          cluster: {
            client(nodeId) {
              assert.equal(nodeId, options.nodeId)
              return clusterClient
            },
            async remoteHost() {
              return { platform: 'linux', root: coordinatorDir, uid: 0, gid: 0 }
            },
          },
        })
        const coordinatorRoot = path.join(coordinatorDir, 'managed-egress')
        const commandCount = remoteCommands.length
        const host = await coordinator.get(options.nodeId)
        assert.equal(await coordinator.get(options.nodeId), host)
        assert.equal(remoteCommands.length, commandCount, 'lookup must not provision or run commands')
        fixture.root = coordinatorRoot
        fixture.metadata.Mounts[0].Source = coordinatorRoot
        fixture.metadata.Config.Labels['com.docker.compose.project'] =
          `vm2api-egress-${createHash('sha256').update(options.nodeId).digest('hex').slice(0, 16)}`
        fixture.helperIds = ['f'.repeat(64)]
        fixture.helpers = [
          {
            Id: fixture.helperIds[0],
            Config: { Labels: { 'kin.egress': '1', 'kin.egress.proxy': options.id, 'kin.egress.vm': 'vm-one' } },
            HostConfig: { NetworkMode: 'host' },
            State: { Running: true, Restarting: false },
            Mounts: [{ Source: controlDir, Destination: '/run/kin-egress', RW: true }],
          },
        ]
        const routingNames = slotEgressNames('vm-one')
        fixture.networks = [{ Name: routingNames.network, Driver: 'bridge',
          Labels: { 'kin.egress.vm': 'vm-one' },
          Options: { 'com.docker.network.bridge.name': routingNames.bridge,
            'com.docker.network.bridge.enable_ip_masquerade': 'false' },
          IPAM: { Config: [{ Subnet: '172.29.0.0/24' }] } }]
        fixture.controlSocket = remotePath
        fixture.ids = []
        await saveFixture()
        await coordinator.ensureProvisioned(options.nodeId)
        // Reload the fixture after the simulated Compose command creates its instance.
        fixture.ids = [containerId]
        const provisionCommands = () =>
          readFile(fixture.log, 'utf8').then(
            (text) =>
              text
                .trim()
                .split('\n')
                .filter((line) => {
                  const args = JSON.parse(line)
                  return args[0] === 'compose' && args.includes('up')
                }).length,
          )
        const provisions = await provisionCommands()
        await coordinator.ensureProvisioned(options.nodeId)
        assert.equal(await provisionCommands(), provisions)
        fixture.metadata.State.Running = false
        await saveFixture()
        await coordinator.ensureProvisioned(options.nodeId)
        assert.equal(await provisionCommands(), provisions, 'a stopped instance must not start before drain')
        fixture.metadata.State.Running = true
        fixture.ids.push('a'.repeat(64))
        await saveFixture()
        await assert.rejects(coordinator.ensureProvisioned(options.nodeId), /missing_or_ambiguous/)
        assert.equal(await provisionCommands(), provisions, 'an ambiguous instance must not trigger deployment')
        fixture.ids.pop()
        await saveFixture()
        const beforeApply = (await readFile(fixture.log, 'utf8'))
          .trim()
          .split('\n')
          .filter((line) => JSON.parse(line)[0] === 'restart').length
        const response = await makeProxyFetch(urlFor(replacement))(`${originUrl}held`)
        const body = response.text()
        void body.catch(() => {})
        assert.equal((await host.apply([], { drainTimeoutMs: 40 })).error, 'managed_drain_timeout')
        assert.equal(await coordinator.helperStatus(row), true)
        let applied = false
        const applying = host.apply([]).then((state) => {
          applied = true
          return state
        })
        await delay(200)
        assert.equal(applied, false, 'host response must finish before remote helper drain')
        releaseHeld()
        assert.equal(await body, 'partialfinished')
        assert.equal((await applying).status, 'ready')
        assert.equal(
          (await readFile(fixture.log, 'utf8'))
            .trim()
            .split('\n')
            .filter((line) => JSON.parse(line)[0] === 'restart').length,
          beforeApply + 1,
        )
        assert.equal(await coordinator.helperStatus(row), true)
        assert.deepEqual(await readdir(relayDir), [], 'successful apply must remove temporary drain relays')
        fixture.helpers[0].Mounts[0].RW = false
        await saveFixture()
        assert.equal(await coordinator.helperStatus(row), false)
        fixture.helpers[0].Mounts[0].RW = true
        fixture.helperIds.push('a'.repeat(64))
        fixture.helpers.push({ ...fixture.helpers[0], Id: fixture.helperIds[1] })
        await saveFixture()
        assert.equal(await coordinator.helperStatus(row), false)
        assert.deepEqual(await readdir(relayDir), [], 'failed discovery must remove partial relays')
        fixture.helperIds.pop()
        fixture.helpers.pop()
        row.bound_vm_ids = ['vm-other']
        await saveFixture()
        assert.equal(await coordinator.helperStatus(row), false)
        row.bound_vm_ids = ['vm-one']
        fixture.helperIds = []
        await saveFixture()
        assert.equal(await coordinator.helperStatus(row), false)
        fixture.helperIds = [fixture.helpers[0].Id]
        fixture.failRestart = true
        row.bound_vm_ids = []
        await saveFixture()
        const failedApply = await host.apply([])
        assert.equal(failedApply.status, 'unavailable')
        assert.equal(failedApply.error, 'managed_rollback_failed')
        assert.equal(await coordinator.helperStatus(row), false, 'failed rollback must retain the helper pause')
        assert.deepEqual(await readdir(relayDir), [], 'failed rollback must close temporary controls')
        fixture.failRestart = false
        await saveFixture()
        assert.equal((await host.recover()).status, 'ready')
        assert.equal(await coordinator.helperStatus(row), true, 'verified recovery must resume the helper')
        row.bound_vm_ids = ['vm-one']
        const nativeListener = {
          inbounds: [
            {
              type: 'socks',
              tag: `in-${options.id}`,
              listen: '127.0.0.1',
              listen_port: remotePort,
              users: [{ username: 'controlled-user', password: 'controlled-remote-password' }],
            },
          ],
        }
        const geoUrl = process.env.KIN_PROXY_GEO_URL
        process.env.KIN_PROXY_GEO_URL = originUrl
        try {
          assert.equal((await host.runtime.verify(nativeListener)).length, 1)
          const importingPool = new ProxyPool({ db: coordinatorDb })
          importingPool.managedPortsFor = (nodeId) => coordinator.occupiedPorts(nodeId)
          importingPool.managedHostFor = (nodeId) => coordinator.get(nodeId)
          importingPool.managedPrepareHost = (nodeId) => coordinator.ensureProvisioned(nodeId)
          fixture.busyPorts = [24000, 24002]
          await saveFixture()
          const imported = await Promise.all(
            [0, 1].map((index) =>
              importingPool.importManaged(
                {
                  host_id: options.nodeId,
                  link: `hy2://controlled-import-${index}@controlled.invalid:443`,
                  label: `Remote ${index}`,
                },
                { ownerUserId: 'controlled-owner' },
              ),
            ),
          )
          assert.ok(imported.every((result) => result.ok))
          const importedRows = importingPool.state.proxies
          assert.deepEqual(
            importedRows.map((proxy) => proxy.port),
            [24001, 24003],
          )
          assert.ok(importedRows.every((proxy) => proxy.managed_host_id === options.nodeId))
          const hostView = importingPool.panelSnapshot({
            role: 'admin',
            nodes: [{ id: options.nodeId, label: 'Controlled host' }],
          })
          assert.ok(
            hostView.proxies.every(
              (proxy) => proxy.managed_host_id === options.nodeId && proxy.managed_host_name === 'Controlled host',
            ),
          )
          const tenantView = importingPool.panelSnapshot({ role: 'user', ownerUserId: 'controlled-owner' })
          assert.equal(tenantView.proxies.length, 2)
          assert.ok(
            tenantView.proxies.every(
              (proxy) => !Object.hasOwn(proxy, 'managed_host_id') && !Object.hasOwn(proxy, 'managed_host_name'),
            ),
          )
          assert.equal(managedEgressIdForUrl('socks5h://127.0.0.1:24001'), null)
          const persistedImports = new ProxiesRepo(coordinatorDb).loadAll()
          assert.deepEqual(
            persistedImports.map((proxy) => [proxy.id, proxy.managed_host_id, proxy.port]),
            importedRows.map((proxy) => [proxy.id, proxy.managed_host_id, proxy.port]),
          )
          fixture.ssRaw = 'invalid-private-command-output'
          await saveFixture()
          assert.equal(
            (
              await importingPool.importManaged({
                host_id: options.nodeId,
                link: 'hy2://controlled@controlled.invalid',
              })
            ).error,
            'managed_remote_host_unavailable',
          )
          delete fixture.ssRaw
          fixture.ids = []
          fixture.failProvision = true
          await saveFixture()
          assert.equal((await importingPool.applyManaged({ hostId: options.nodeId })).ok, false)
          assert.deepEqual(
            new ProxiesRepo(coordinatorDb).loadAll().map((proxy) => proxy.id),
            importedRows.map((proxy) => proxy.id),
            'failed provisioning must retain desired rows',
          )
          fixture.failProvision = false
          fixture.ids = [containerId]
          await saveFixture()
          new ProxiesRepo(coordinatorDb).replaceAll([
            {
              ...row,
              host: '127.0.0.1',
              port: remotePort,
              username: 'controlled-user',
              password: 'controlled-remote-password',
              scheme: 'hysteria2',
              enabled: true,
              status: 'unknown',
              managed_config: {
                server: 'controlled.invalid',
                server_port: 443,
                password: 'controlled-fixture-upstream',
              },
            },
          ])
          let geoCalls = 0
          const pool = new ProxyPool({
            db: coordinatorDb,
            geoLookup: (url, opts) => {
              geoCalls++
              return lookupProxyGeo(url, { ...opts, endpoint: originUrl })
            },
            geoV6Lookup: async () => ({ ok: false, error: 'controlled-v6-unavailable' }),
          })
          pool.managedEndpointFor = (proxy) => coordinator.addressFor(proxy)
          setManagedEgressReady(options.id, true)
          const resolved = pool.getProxyByIdWithAuth(options.id)
          await writeFile(
            path.join(coordinatorDir, 'vms/vm-snapshot.json'),
            JSON.stringify({ id: 'vm-snapshot', node_id: options.nodeId, status: 'stopped' }),
          )
          const publicVm = bindVmProxy(coordinatorDir, 'vm-snapshot', resolved)
          assert.deepEqual(publicVm.proxy, { id: options.id, managed: true, scheme: 'hysteria2' })
          const persistedVm = JSON.parse(await readFile(path.join(coordinatorDir, 'vms/vm-snapshot.json'), 'utf8'))
          assert.equal(persistedVm.proxy.managed_host_id, options.nodeId)
          assert.equal(persistedVm.proxy.managed_listener_port, remotePort)
          assert.equal(remoteEgressProxyUrl(persistedVm.proxy, options.nodeId), nodeProxyUrl)
          assert.equal(
            pool.getProxyForVm('vm-one'),
            null,
            'remote slot routing remains guarded, including restored bindings',
          )
          assert.equal(pool.bind(options.id, 'vm-two').error, 'managed_host_unsupported')
          assert.equal(pool.allocateForVm('vm-two'), null)
          assert.equal(resolved.host, '127.0.0.1')
          assert.notEqual(
            resolved.port,
            remotePort,
            'control-plane callers must use the bridge, not the remote listener port',
          )
          assert.equal((await (await makeProxyFetch(resolved.url)(originUrl)).json()).marker, 'controlled-node-route')
          pool.reload()
          assert.equal(managedEgressIdForUrl(resolved.url), null)
          assert.equal(managedEgressReady(options.id), false)
          await host.runtime.verify(nativeListener)
          assert.equal(managedEgressIdForUrl(resolved.url), options.id)
          setManagedEgressReady(options.id, true)
          assert.equal((await pool.detectGeo(options.id, { force: true })).ok, true)
          assert.equal(geoCalls, 1)
          pool.managedEndpointFor = null
          assert.throws(() => pool.getProxyByIdWithAuth(options.id), { code: 'managed_remote_endpoint_unavailable' })
          setManagedEgressReady(options.id, true)
          assert.equal((await pool.detectGeo(options.id, { force: true })).error, 'managed_remote_endpoint_unavailable')
          assert.equal(geoCalls, 1, 'missing managed bridge must not trigger direct geo lookup')
          setManagedEgressReady(options.id, true)
          assert.equal((await pool.probeOne(pool.state.proxies[0])).error, 'managed_remote_endpoint_unavailable')
          assert.equal(coordinator.addressFor({ ...pool.state.proxies[0], port: remotePort + 1 }), null)
          pool.managedEndpointFor = (proxy) => coordinator.addressFor(proxy)
          setManagedEgressReady(options.id, true)
          secondClient = new Client()
          secondClient.on('error', () => {})
          await new Promise((resolve, reject) => {
            secondClient.once('ready', resolve)
            secondClient.once('error', reject)
            secondClient.connect({
              host: '127.0.0.1',
              port: ssh.address().port,
              username: 'controlled',
              password: 'controlled-ssh-password',
              hostHash: 'sha256',
              hostVerifier: (hash) => hash === pinnedHash,
            })
          })
          clusterClient = secondClient
          assert.throws(() => pool.getProxyByIdWithAuth(options.id), { code: 'managed_remote_endpoint_unavailable' })
          const nextHost = await coordinator.get(options.nodeId)
          assert.notEqual(nextHost, host)
          assert.equal(nextHost.state().applied_version, host.state().applied_version)
          coordinationVersions = nextHost.state()
          await assert.rejects(
            host.runtime.check(path.join(coordinatorRoot, 'config.json')),
            /managed_remote_docker_failed/,
          )
          assert.equal(managedEgressReady(options.id), false)
          await nextHost.runtime.check(path.join(coordinatorRoot, 'config.json'))
          assert.equal((await nextHost.runtime.verify(nativeListener)).length, 1)
          setManagedEgressReady(options.id, true)
          const reconnected = pool.getProxyByIdWithAuth(options.id)
          assert.notEqual(reconnected.port, resolved.port)
          assert.equal(
            (await (await makeProxyFetch(reconnected.url)(originUrl)).json()).marker,
            'controlled-node-route',
          )
          assert.equal(await coordinator.helperStatus(row), true)
        } finally {
          if (geoUrl === undefined) delete process.env.KIN_PROXY_GEO_URL
          else process.env.KIN_PROXY_GEO_URL = geoUrl
          await coordinator.close()
          assert.deepEqual(await readdir(relayDir), [])
          secondClient?.end()
        }
        // Restore the original fixture bridge after testing coordinator-owned replacements.
        registerManagedEgressEndpoint(options.id, replacement.host, replacement.port)
        setManagedEgressReady(options.id, true)
      }
    }
    const heldResponse = await makeProxyFetch(urlFor(replacement))(`${originUrl}held`)
    const interruptedBody = heldResponse.text().then(
      () => true,
      () => false,
    )
    linkReady = false
    await new Promise((resolve) => {
      client.once('close', resolve)
      client.end()
    })
    assert.equal(managedEgressReady(options.id), false)
    assert.equal(await interruptedBody, false)
    if (remoteDrain) {
      await assert.rejects(remoteDrain.status(), /managed_helper_control_failed/)
      await remoteDrain.close()
      await assert.rejects(stat(path.join(dir, 'ld.sock')), { code: 'ENOENT' })
    }
    await assert.rejects(makeProxyFetch(urlFor(replacement))(originUrl), { code: 'managed_egress_not_ready' })
    await replacement.close()
    assert.equal(managedEgressIdForUrl(urlFor(replacement)), null)
    await mkdir('.tmp/managed-egress-e2e', { recursive: true })
    const files = [
      'src/lib/cluster/managed-egress-hosts.mjs',
      'src/server.mjs',
      'src/lib/cluster/socket-relay.mjs',
      'src/lib/vm/managed-egress-drain.mjs',
      'src/lib/vm/managed-egress-admission.mjs',
      'src/lib/vm/managed-egress-docker.mjs',
      'src/lib/vm/proxy-pool.mjs',
      'src/lib/vm/vm-registry.mjs',
      'src/lib/cluster/remote-egress-proxy.mjs',
      'src/lib/cluster/managed-egress-drain.mjs',
      'src/lib/cluster/remote-slot.mjs',
      'src/lib/cluster/managed-egress-runtime.mjs',
      'src/lib/vm/managed-egress-host.mjs',
      'src/lib/cluster/remote-fs.mjs',
      'src/lib/cluster/ssh-link.mjs',
      'src/lib/cluster/managed-egress-files.mjs',
      'src/lib/cluster/managed-egress-endpoint.mjs',
      'test/e2e/managed-egress-remote-endpoint.e2e.test.mjs',
    ]
    await writeFile(
      '.tmp/managed-egress-e2e/remote-endpoint-receipt.json',
      JSON.stringify(
        {
          command:
            'KIN_EGRESS_TEST_BIN=/path/to/kin-egress SING_BOX_BIN=/path/to/sing-box node --test test/e2e/managed-egress-remote-endpoint.e2e.test.mjs',
          environment: `${process.platform}/${process.arch}`,
          source_revision: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
          sing_box_sha256: createHash('sha256')
            .update(await readFile(binary))
            .digest('hex'),
          kin_egress_sha256: process.env.KIN_EGRESS_TEST_BIN
            ? createHash('sha256')
                .update(await readFile(process.env.KIN_EGRESS_TEST_BIN))
                .digest('hex')
            : null,
          sftp_server_sha256: sftpBinary
            ? createHash('sha256')
                .update(await readFile(sftpBinary))
                .digest('hex')
            : null,
          scope:
            'real SSH/SFTP, authenticated SOCKS, and HTTP over loopback; no remote deployment or separate Linux host',
          coordination_versions: coordinationVersions,
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
          results: {
            slot_endpoint_resolution: process.env.KIN_EGRESS_TEST_BIN
              ? 'real helper DNS through node-local SOCKS; control bridge not dialed; wrong-host/missing reservation rejected before remote setup; binding metadata persisted and public summary redacted; NOT Linux transparent slot acceptance'
              : 'NOT RUN: helper binary unavailable',
            local_stopped_runtime: sftpBinary
              ? 'local Docker command fixture with real sing-box check; stopped offline validation, host mount translation, conditional restart, replacement/mount/isolation/identity/path rejection and error redaction; NOT live Docker recovery'
              : 'NOT RUN: OpenSSH SFTP server unavailable',
            remote_import_deployment:
              process.env.KIN_EGRESS_TEST_BIN && sftpBinary
                ? 'real SSH/SFTP and database; ss/Docker command fixtures verify concurrent per-host port allocation, persisted host/IDs, missing/stopped/ambiguous deployment handling, failed provisioning preserves desired rows; NOT live Linux listener discovery or Docker'
                : 'NOT RUN: helper binary or OpenSSH SFTP server unavailable',
            control_plane_resolution:
              process.env.KIN_EGRESS_TEST_BIN && sftpBinary
                ? 'real pool credential lookup and geo through SSH bridge; missing bridge rejects credential lookup, geo and probe; changed client/port rejected; reconnect uses new bridge; no local fallback'
                : 'NOT RUN: helper binary or OpenSSH SFTP server unavailable',
            remote_coordination:
              process.env.KIN_EGRESS_TEST_BIN && sftpBinary
                ? 'real SSH/SFTP and helper; explicit provisioning command fixture, host-response drain/timeout, checked helper mount/binding/ambiguity, rollback failure retains pause, verified recovery, persisted versions, client replacement and relay cleanup passed; NOT live Docker'
                : 'NOT RUN: helper binary or OpenSSH SFTP server unavailable',
            remote_drain: process.env.KIN_EGRESS_TEST_BIN
              ? 'real compiled helper over SSH streamlocal; pause/resume, process replacement, disconnect and private relay cleanup passed'
              : 'NOT RUN: helper binary missing',
            docker_command_contract: sftpBinary
              ? 'SSH command fixture and real config check; identity, writable mount, privilege, ambiguity, stopped/replaced instance rejection; NOT a live Docker acceptance'
              : 'NOT RUN: SFTP server unavailable',
            remote_lifecycle: sftpBinary
              ? 'shared host lifecycle over real SFTP and SSH process; candidate rejection, drain timeout, port-conflict rollback and reopened-state recovery passed'
              : 'NOT RUN: OpenSSH sftp-server unavailable',
            configuration_storage: sftpBinary
              ? 'real OpenSSH SFTP atomic write/read; multi-batch byte identity; rejected replacement preserves destination and removes temporary data; symlink refusal; mode checks; secrets absent from exec arguments'
              : 'NOT RUN: OpenSSH sftp-server unavailable',
            remote_listener: 'reached only via selected SSH channel',
            authentication: 'wrong SOCKS credentials rejected',
            body_transfer: '1 MiB preserved through SSH',
            live_disconnect: 'partial response fails when SSH closes',
            replacement: 'stale bridge does not revoke new endpoint',
            disconnect: 'readiness revoked without local fallback',
            close: 'registration removed',
          },
        },
        null,
        2,
      ),
    )
  } finally {
    releaseHeld?.()
    await coordinator?.close()
    coordinatorDb?.close()
    secondClient?.destroy()
    await remoteDrain?.close()
    if (helperChannel && helperRunning) helperChannel.close()
    await bridge?.close()
    await replacement?.close()
    client.destroy()
    for (const child of subprocesses) if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM')
    for (const peer of peers) peer.end()
    for (const stream of streams) stream.destroy()
    if (ssh) await new Promise((resolve) => ssh.close(resolve))
    if (socks && socks.exitCode === null && socks.signalCode === null)
      await new Promise((resolve) => {
        socks.once('exit', resolve)
        socks.kill('SIGTERM')
      })
    origin.closeAllConnections()
    await new Promise((resolve) => origin.close(resolve))
    await rm(dir, { recursive: true, force: true })
    await rm(coordinatorDir, { recursive: true, force: true })
  }
})
