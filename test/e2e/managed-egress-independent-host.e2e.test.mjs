import test from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createHash, randomBytes } from 'node:crypto'
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises'
import path from 'node:path'
import { connectSshAlias } from '../helpers/ssh-alias.mjs'
import { execCollect } from '../../src/lib/cluster/ssh-link.mjs'
import { openSftp, readRemoteFileNoFollow, writeRemoteFile, shellQuote } from '../../src/lib/cluster/remote-fs.mjs'
import { sshDocker } from '../../src/lib/cluster/docker-remote.mjs'
import { ensureRemoteEgress, releaseRemoteEgress, slotEgressNames } from '../../src/lib/cluster/remote-slot.mjs'
import { RemoteManagedEgressHosts } from '../../src/lib/cluster/managed-egress-hosts.mjs'
import { MANAGED_EGRESS_IMAGE } from '../../src/lib/vm/managed-egress-docker.mjs'
import { ProxyPool } from '../../src/lib/vm/proxy-pool.mjs'
import { createDatabase } from '../../src/lib/db/database.mjs'
import { makeProxyFetch } from '../../src/lib/protocol/codex-models.mjs'
import { resolveImportProxy } from '../../src/lib/vm/proxy-resolve.mjs'

const artifact = path.resolve('.tmp/managed-egress-e2e/independent-host-receipt.json')
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
async function receipt(value) {
  await mkdir(path.dirname(artifact), { recursive: true })
  await writeFile(
    value.status === 'NOT RUN' ? artifact.replace('-receipt.json', '-not-run-receipt.json') : artifact,
    JSON.stringify(value, null, 2),
  )
}

test('a pinned real SSH host preserves two managed exits and existing services', { timeout: 600000 }, async (t) => {
  const alias = process.env.MANAGED_EGRESS_REMOTE_ALIAS
  if (!alias) {
    await receipt({ status: 'NOT RUN', reason: 'an explicitly selected SSH alias is required' })
    t.skip('an explicitly selected SSH alias is required')
    return
  }
  const helper = process.env.KIN_EGRESS_REMOTE_TEST_BIN
  assert.ok(helper, 'a current Linux AMD64 helper is required')
  const helperBytes = await readFile(helper)
  assert.equal(helperBytes.readUInt16LE(18), 62, 'the real host uses AMD64')
  const helperDigest = createHash('sha256').update(helperBytes).digest('hex')
  const nonce = randomBytes(5).toString('hex')
  const root = `/tmp/me-primary-${nonce}`
  const local = await mkdtemp('/tmp/me-physical-')
  const nodeId = `physical-${nonce}`
  const guestImage = 'ghcr.io/dofastted/kin-os-ubuntu:24.04'
  let client
  let db
  let hosts
  let pool
  let host
  let session
  let rootOwned = false
  let before = []
  let result
  const containers = []
  const networks = []
  const vmHosts = new Map()
  const previousGeo = process.env.KIN_PROXY_GEO_URL
  const run = async (args, { timeoutMs = 45000 } = {}) => {
    const response = await execCollect(client, args.map(shellQuote).join(' '), { timeoutMs, maxBytes: 4 * 1024 * 1024 })
    if (response.code !== 0) throw new Error('controlled_remote_command_failed')
    return response.stdout.trim()
  }
  const docker = (args, options) => run(['docker', ...args], options)
  const snapshot = async () => {
    const ids = (await docker(['ps', '-q', '--no-trunc'])).split(/\s+/).filter(Boolean)
    if (!ids.length) return []
    return JSON.parse(await docker(['inspect', ...ids])).map((item) => ({
      id: item.Id,
      started: item.State.StartedAt,
      running: item.State.Running,
      restarts: item.RestartCount,
    }))
  }
  const inspect = async (name) => JSON.parse(await docker(['inspect', name]))[0]
  const put = async (name, value) =>
    writeRemoteFile(await openSftp(client), `${root}/${name}`, Buffer.isBuffer(value) ? value : Buffer.from(value), {
      mode: 0o600,
    })
  try {
    client = await connectSshAlias(alias)
    assert.equal(await run(['uname', '-s']), 'Linux')
    assert.equal(await run(['uname', '-m']), 'x86_64')
    assert.equal(await run(['id', '-u']), '0')
    before = await snapshot()
    await run(['mkdir', '-m', '700', root])
    rootOwned = true
    await put('.owner', nonce)
    const dockerVersion = await docker(['version', '--format', '{{.Server.Version}}'])
    await docker(['image', 'inspect', guestImage])
    // Pull only the immutable official service image; never replace a running service.
    await docker(['pull', MANAGED_EGRESS_IMAGE], { timeoutMs: 240000 })
    const serviceImage = (await inspect(MANAGED_EGRESS_IMAGE)).Id
    const guestImageId = (await inspect(guestImage)).Id
    const gateway = await docker(['network', 'inspect', 'bridge', '--format', '{{(index .IPAM.Config 0).Gateway}}'])
    assert.match(gateway, /^172\.|^10\.|^192\.168\./)
    const originCode = `import http.server,json,socket,time\nclass H(http.server.BaseHTTPRequestHandler):\n def do_GET(self):\n  value={'query':self.client_address[0]} if self.path=='/geo' else self.client_address[0]\n  data=(json.dumps(value) if isinstance(value,dict) else value).encode()\n  self.send_response(200);self.send_header('Content-Length',str(len(data)));self.end_headers();self.wfile.write(data)\n def do_POST(self):\n  self.rfile.read(int(self.headers.get('Content-Length','0')))\n  data=json.dumps({'source':self.client_address[0],'received':True}).encode()\n  self.send_response(200);self.send_header('Content-Length',str(len(data)));self.end_headers();self.wfile.write(data)\n def log_message(self,*args):pass\ns=http.server.ThreadingHTTPServer(('${gateway}',0),H)\nopen('/fixture/origin-port','w').write(str(s.server_port))\ns.serve_forever()\n`
    await put('origin.py', originCode)
    const origin = `me-primary-${nonce}-origin`
    await docker([
      'run',
      '-d',
      '--pull=never',
      '--name',
      origin,
      '--label',
      `vm2api.e2e.owner=${nonce}`,
      '--network',
      'host',
      '--read-only',
      '--user',
      '0:0',
      '--volume',
      `${root}:/fixture:rw`,
      '--entrypoint',
      'python3',
      guestImage,
      '/fixture/origin.py',
    ])
    containers.push(origin)
    let portBytes
    for (let attempt = 0; attempt < 60; attempt++) {
      portBytes = await readRemoteFileNoFollow(client, `${root}/origin-port`)
      if (portBytes?.length) break
      await delay(100)
    }
    const originPort = Number(portBytes?.toString())
    assert.ok(originPort > 0 && originPort < 65536)
    const originUrl = `http://${gateway}:${originPort}`
    process.env.KIN_PROXY_GEO_URL = `${originUrl}/geo`
    execFileSync(
      'openssl',
      [
        'req',
        '-x509',
        '-newkey',
        'rsa:2048',
        '-nodes',
        '-keyout',
        `${local}/key.pem`,
        '-out',
        `${local}/cert.pem`,
        '-days',
        '1',
        '-subj',
        '/CN=localhost',
      ],
      { stdio: 'ignore' },
    )
    await put('key.pem', await readFile(`${local}/key.pem`))
    await put('cert.pem', await readFile(`${local}/cert.pem`))
    const upstreams = []
    const configs = []
    for (let index = 0; index < 2; index++) {
      const port = Number(
        await run([
          'python3',
          '-c',
          "import socket;s=socket.socket(socket.AF_INET,socket.SOCK_DGRAM);s.bind(('127.0.0.1',0));print(s.getsockname()[1]);s.close() ",
        ]),
      )
      const password = `controlled-${nonce}-${index}`
      const config = {
        log: { disabled: true },
        inbounds: [
          {
            type: 'hysteria2',
            listen: '127.0.0.1',
            listen_port: port,
            users: [{ password }],
            tls: { enabled: true, certificate_path: '/fixture/cert.pem', key_path: '/fixture/key.pem' },
          },
        ],
        outbounds: [{ type: 'direct', inet4_bind_address: `127.0.0.${index + 2}` }],
      }
      await put(`upstream-${index}.json`, JSON.stringify(config))
      const name = `me-primary-${nonce}-upstream-${index}`
      await docker([
        'run',
        '-d',
        '--pull=never',
        '--name',
        name,
        '--label',
        `vm2api.e2e.owner=${nonce}`,
        '--network',
        'host',
        '--cap-drop',
        'ALL',
        '--read-only',
        '--volume',
        `${root}:/fixture:ro`,
        MANAGED_EGRESS_IMAGE,
        'run',
        '-c',
        `/fixture/upstream-${index}.json`,
      ])
      containers.push(name)
      upstreams.push(name)
      configs.push({
        server: '127.0.0.1',
        server_port: port,
        password,
        server_name: 'localhost',
        insecure: true,
      })
    }
    t.diagnostic('real remote upstreams and origin started; existing containers preserved')
    db = createDatabase({ dbPath: `${local}/host.db` })
    pool = new ProxyPool({ db, vmNodeOf: (vmId) => vmHosts.get(vmId) })
    const facts = { platform: 'linux', root, uid: 0, gid: 0, sudo: false }
    hosts = new RemoteManagedEgressHosts({
      db,
      socketDir: `${local}/controls`,
      rowsFor: (id) => pool.managedRows(id),
      cluster: {
        client: (id) => {
          assert.equal(id, nodeId)
          return client
        },
        remoteHost: async (id) => {
          assert.equal(id, nodeId)
          return facts
        },
      },
    })
    pool.managedPortsFor = (id) => hosts.occupiedPorts(id)
    pool.managedHostFor = (id) => hosts.get(id)
    pool.managedPrepareHost = (id) => hosts.ensureProvisioned(id)
    pool.managedEndpointFor = (proxy) => hosts.addressFor(proxy)
    pool.managedHelperStatus = (proxy) => hosts.helperStatus(proxy)
    pool.managedRepairHelper = (proxy) => hosts.repairRouting(proxy)
    pool.managedPlacementSupported = (proxy, id) => hosts.supportsPlacement(proxy, id)
    const imported = []
    for (const config of configs) {
      const added = await pool.importManaged({ host_id: nodeId, config })
      assert.equal(added.ok, true)
      imported.push(added.items[0].id)
    }
    host = await hosts.get(nodeId)
    assert.equal((await pool.applyManaged({ hostId: nodeId })).ok, true)
    session = { nodeId, client, host: facts, docker: sshDocker(client) }
    const traffic = []
    const observed = []
    for (let index = 0; index < 2; index++) {
      const vmId = `vm-me-${nonce}-${index}`
      vmHosts.set(vmId, nodeId)
      const names = slotEgressNames(vmId)
      assert.equal(await docker(['ps', '-aq', '--filter', `name=^${names.egress}$`]), '')
      assert.equal(await docker(['network', 'ls', '--filter', `name=^${names.network}$`, '--format', '{{.Name}}']), '')
      await run(['mkdir', '-p', `${root}/vms/${vmId}/slot-bin`])
      await writeRemoteFile(await openSftp(client), `${root}/vms/${vmId}/slot-bin/kin-egress`, helperBytes, {
        mode: 0o755,
      })
      const bound = await pool.bindManaged(imported[index], vmId, async (proxy) => {
        const setup = await ensureRemoteEgress(
          session,
          { id: vmId, node_id: nodeId, proxy },
          { imageRef: guestImage, binaryDigest: helperDigest },
        )
        if (setup.ok) networks.push({ name: setup.network, vmId })
        return setup
      })
      assert.equal(bound.ok, true, 'real remote binding and helper verification must succeed')
      const name = `me-primary-${nonce}-traffic-${index}`
      await docker([
        'run',
        '-d',
        '--pull=never',
        '--name',
        name,
        '--label',
        `vm2api.e2e.owner=${nonce}`,
        '--network',
        names.network,
        '--entrypoint',
        'sleep',
        guestImage,
        '600',
      ])
      containers.push(name)
      traffic.push(name)
      const source = await docker([
        'exec',
        name,
        'curl',
        '--silent',
        '--show-error',
        '--fail',
        '--noproxy',
        '*',
        '--max-time',
        '15',
        `${originUrl}/source`,
      ])
      assert.equal(source, `127.0.0.${index + 2}`)
      observed.push(source)
      const proxy = pool.getProxyForVm(vmId)
      const credential = resolveImportProxy({
        vm: { id: vmId, node_id: nodeId, proxy: { ...proxy, url: 'socks5h://127.0.0.1:9' } },
        proxyPool: pool,
      })
      assert.equal(credential.ok, true)
      const exchanged = await (
        await makeProxyFetch(credential.proxyUrl)(`${originUrl}/credential`, {
          method: 'POST',
          body: 'controlled-credential-fixture',
          signal: AbortSignal.timeout(10000),
        })
      ).json()
      assert.deepEqual(exchanged, { source, received: true })
    }
    t.diagnostic('both real remote helper routes and control-plane credential POSTs verified')
    // Reproduce OS loss of ephemeral rules without rebooting unrelated workloads.
    const missingRules = slotEgressNames(`vm-me-${nonce}-0`)
    await docker(['network', 'inspect', missingRules.network])
    await run(['iptables', '-t', 'nat', '-F', missingRules.chain])
    await pool.inspectManaged()
    for (let index = 0; index < 2; index++) {
      assert.ok(pool.getProxyForVm(`vm-me-${nonce}-${index}`))
      assert.equal(await docker(['exec', traffic[index], 'curl', '--silent', '--show-error', '--fail',
        '--noproxy', '*', '--max-time', '5', `${originUrl}/source`]), observed[index],
        'inspection must restore a bound slot route after its ephemeral NAT rules are lost')
    }

    const shared = await host.runtime.locate()
    await docker(['stop', shared])
    await pool.inspectManaged()
    assert.equal(pool.getProxyForVm(`vm-me-${nonce}-0`), null)
    assert.equal((await pool.recoverManaged({ hostId: nodeId })).ok, true)
    client.end()
    client = await connectSshAlias(alias)
    session = { ...session, client, docker: sshDocker(client) }
    assert.equal(pool.getProxyForVm(`vm-me-${nonce}-0`), null, 'a new SSH connection must revoke the old bridge')
    host = await hosts.get(nodeId)
    await pool.inspectManaged()
    for (let index = 0; index < 2; index++) {
      const proxy = pool.getProxyForVm(`vm-me-${nonce}-${index}`)
      assert.ok(proxy)
      assert.equal(
        await (await makeProxyFetch(proxy.url)(`${originUrl}/source`, { signal: AbortSignal.timeout(10000) })).text(),
        observed[index],
      )
    }
    await docker(['stop', upstreams[1]])
    const broken = pool.getProxyForVm(`vm-me-${nonce}-1`)
    await assert.rejects(
      async () => {
        const response = await makeProxyFetch(broken.url)(`${originUrl}/source`, { signal: AbortSignal.timeout(5000) })
        if (!response.ok) throw new Error('controlled_upstream_unavailable')
        assert.fail('unavailable upstream must not fall back to another exit')
      },
      (error) => error.code !== 'ERR_ASSERTION',
    )
    const unaffected = pool.getProxyForVm(`vm-me-${nonce}-0`)
    assert.equal(
      await (
        await makeProxyFetch(unaffected.url)(`${originUrl}/source`, { signal: AbortSignal.timeout(10000) })
      ).text(),
      observed[0],
    )
    result = {
      status: 'PASS',
      alias,
      environment: 'macOS control plane to independent Linux AMD64 host',
      ssh_host_key_verified: true,
      docker_version: dockerVersion,
      sing_box_image: MANAGED_EGRESS_IMAGE,
      sing_box_image_id: serviceImage,
      traffic_image_id: guestImageId,
      helper_sha256: helperDigest,
      observed_exits: observed,
      existing_containers_preserved: true,
      results: [
        'real remote import apply bind and transparent helper traffic',
        'authoritative SSH bridge credential POST for both exits',
        'lost bound-slot NAT rules repaired during verified inspection without restarting another slot',
        'stopped shared-service recovery',
        'SSH reconnect revokes stale admission and restores both routes',
        'isolated upstream failure without alternate-exit fallback',
      ],
      scope:
        'real independent host and production SSH/SFTP/Compose/helper paths; isolated test directory/project; no production deployment, full remote gateway VM, host reboot, real Claude, or visual acceptance',
    }
  } catch (error) {
    await receipt({
      status: 'FAIL',
      alias,
      reason: 'inspect the independent-host test assertion; no success inferred from partial execution',
    })
    throw error
  } finally {
    try {
      if (client) {
        for (const name of [...containers].reverse()) {
          const info = await inspect(name).catch(() => null)
          if (info?.Config?.Labels?.['vm2api.e2e.owner'] === nonce) await docker(['rm', '-f', info.Id])
        }
        for (const network of networks) {
          const info = JSON.parse(await docker(['network', 'inspect', network.name]))[0]
          assert.equal(info.Labels?.['kin.egress.vm'], network.vmId)
          const helperInfo = await inspect(slotEgressNames(network.vmId).egress).catch(() => null)
          assert.ok(
            !helperInfo ||
              (helperInfo.Config?.Labels?.['kin.egress.vm'] === network.vmId &&
                helperInfo.Mounts?.some((mount) => mount.Source === `${root}/vms/${network.vmId}/egress`)),
          )
          await releaseRemoteEgress(session, network.name)
        }
        if (host) {
          const id = await host.runtime.locate({ requireRunning: false }).catch(() => null)
          if (id) {
            const info = await inspect(id)
            assert.equal(info.Config.Labels['vm2api.managed-egress.node'], nodeId)
            assert.ok(info.Mounts.some((mount) => mount.Source === `${root}/managed-egress`))
            await docker(['rm', '-f', id])
          }
        }
        if (rootOwned) {
          assert.equal((await readRemoteFileNoFollow(client, `${root}/.owner`)).toString(), nonce)
          await run(['rm', '-rf', root])
        }
        const after = await snapshot()
        for (const existing of before)
          assert.deepEqual(
            after.find((item) => item.id === existing.id),
            existing,
            'pre-existing services must remain unchanged',
          )
      }
    } finally {
      await hosts?.close()
      client?.end()
      db?.close()
      if (previousGeo === undefined) delete process.env.KIN_PROXY_GEO_URL
      else process.env.KIN_PROXY_GEO_URL = previousGeo
      await rm(local, { recursive: true, force: true })
    }
  }
  const files = [
    'test/e2e/managed-egress-independent-host.e2e.test.mjs',
    'test/helpers/ssh-alias.mjs',
    'src/lib/cluster/ssh-link.mjs',
    'src/lib/cluster/remote-fs.mjs',
    'src/lib/cluster/ssh-auth.mjs',
    'src/lib/cluster/managed-egress-hosts.mjs',
    'src/lib/cluster/managed-egress-runtime.mjs',
    'src/lib/cluster/managed-egress-files.mjs',
    'src/lib/cluster/managed-egress-endpoint.mjs',
    'src/lib/cluster/managed-egress-drain.mjs',
    'src/lib/cluster/remote-slot.mjs',
    'src/lib/cluster/remote-egress-proxy.mjs',
    'src/lib/vm/proxy-pool.mjs',
    'src/lib/vm/proxy-resolve.mjs',
    'src/lib/vm/managed-egress-host.mjs',
    'src/lib/vm/managed-egress-config.mjs',
    'worker/internal/egress/drain.go',
    'worker/internal/egress/server.go',
  ]
  result.source_files = Object.fromEntries(
    await Promise.all(
      files.map(async (file) => [
        file,
        createHash('sha256')
          .update(await readFile(file))
          .digest('hex'),
      ]),
    ),
  )
  await receipt(result)
})
