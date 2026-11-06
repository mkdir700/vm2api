import { EgressDrainClient, acquireManagedDrain } from '../../src/lib/vm/managed-egress-drain.mjs'
import { withManagedEgressOperation } from '../../src/lib/vm/managed-egress-admission.mjs'
import { setManagedEgressReady } from '../../src/lib/vm/managed-egress-readiness.mjs'
import test from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import http from 'node:http'
import net from 'node:net'
import dgram from 'node:dgram'
import path from 'node:path'
import { tmpdir } from 'node:os'
import { mkdtemp, writeFile, readFile, rm, stat, mkdir } from 'node:fs/promises'
import { createHash } from 'node:crypto'

const binary = process.env.KIN_EGRESS_TEST_BIN
const singBox = process.env.SING_BOX_BIN
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
async function port() {
  const server = net.createServer()
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const value = server.address().port
  await new Promise((resolve) => server.close(resolve))
  return value
}

test('compiled kin-egress pauses DNS admission while live DNS finishes', {
  skip: !binary || !singBox,
  timeout: 20000,
}, async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'egress-drain-'))
  const children = []
  let release
  let received
  const upstreamStarted = new Promise((resolve) => {
    received = resolve
  })
  let requests = 0
  const upstream = http.createServer(async (req, res) => {
    requests++
    const chunks = []
    for await (const chunk of req) chunks.push(chunk)
    const reply = Buffer.concat(chunks)
    reply[2] |= 0x80
    release = () => res.end(reply)
    received()
  })
  await new Promise((resolve) => upstream.listen(0, '127.0.0.1', resolve))
  const udp = dgram.createSocket('udp4')
  const control = path.join(dir, 'drain.sock')
  let dnsClient
  let joint
  let releaseHost
  async function command(method, route) {
    return new Promise((resolve, reject) => {
      const request = http.request({ socketPath: control, path: route, method, timeout: 1000 }, (res) => {
        let text = ''
        res.on('data', (chunk) => {
          text += chunk
        })
        res.on('end', () => resolve({ status: res.statusCode, body: res.statusCode === 200 ? JSON.parse(text) : null }))
      })
      request.on('error', reject)
      request.on('timeout', () => request.destroy(new Error('control timeout')))
      request.end()
    })
  }
  async function waitActive(expected) {
    for (let i = 0; i < 100; i++) {
      if ((await command('GET', '/status')).body.active === expected) return
      await delay(10)
    }
    assert.fail(`active flow count did not reach ${expected}`)
  }
  try {
    const socksPort = await port()
    const socksConfig = path.join(dir, 'socks.json')
    await writeFile(
      socksConfig,
      JSON.stringify({
        log: { disabled: true },
        inbounds: [{ type: 'socks', listen: '127.0.0.1', listen_port: socksPort }],
        outbounds: [{ type: 'direct' }],
      }),
      { mode: 0o600 },
    )
    children.push(spawn(singBox, ['run', '-c', socksConfig], { stdio: 'ignore' }))
    await delay(300)
    const dnsPort = await port()
    const cfg = path.join(dir, 'egress.json')
    await writeFile(
      cfg,
      JSON.stringify({
        proxy_id: 'controlled-helper',
        proxy_url: `socks5h://127.0.0.1:${socksPort}`,
        listen_tcp: '127.0.0.1:0',
        listen_dns: `127.0.0.1:${dnsPort}`,
        dns_upstream: `http://127.0.0.1:${upstream.address().port}/dns-query`,
        control_socket: control,
      }),
      { mode: 0o600 },
    )
    const helper = spawn(binary, ['-config', cfg], { stdio: ['ignore', 'ignore', 'pipe'] })
    let stderr = ''
    helper.stderr.on('data', (chunk) => {
      stderr += chunk
    })
    children.push(helper)
    for (let i = 0; i < 150; i++) {
      try {
        await command('GET', '/status')
        break
      } catch {
        await delay(10)
      }
    }
    assert.equal((await stat(control)).mode & 0o777, 0o600)
    assert.equal((await command('GET', '/status')).body.version, 1)
    assert.equal((await command('GET', '/pause')).status, 404)
    const query = Buffer.from([0x12, 0x34, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0])
    const response = new Promise((resolve) => udp.once('message', resolve))
    udp.send(query, dnsPort, '127.0.0.1')
    await upstreamStarted
    setManagedEgressReady('controlled-helper', true)
    const hostOperation = withManagedEgressOperation(
      { id: 'controlled-helper', managed: true },
      () =>
        new Promise((resolve) => {
          releaseHost = resolve
        }),
    )
    const helperControl = new EgressDrainClient({ id: 'controlled-helper', socketPath: control })
    joint = await acquireManagedDrain({
      ids: ['controlled-helper'],
      helpers: async () => {
        assert.equal((await command('GET', '/status')).body.paused, false)
        return [helperControl]
      },
    })
    assert.equal((await command('GET', '/status')).body.paused, false)
    assert.equal(await joint.wait(20), false)
    releaseHost()
    await hostOperation
    assert.equal(await joint.wait(50), false)
    const paused = await command('GET', '/status')
    assert.equal(await joint.wait(20), false)
    await assert.rejects(
      withManagedEgressOperation({ id: 'controlled-helper', managed: true }, async () => {}),
      { code: 'managed_egress_not_ready' },
    )

    assert.equal(paused.body.paused, true)
    assert.equal(paused.body.active, 1)
    udp.send(query, dnsPort, '127.0.0.1')
    await delay(50)
    assert.equal(requests, 1)
    release()
    assert.equal((await response).readUInt16BE(0), 0x1234)
    await waitActive(0)
    assert.equal(await joint.wait(100), true)
    await joint.release()

    dnsClient = net.connect({ host: '127.0.0.1', port: dnsPort })
    await new Promise((resolve) => dnsClient.once('connect', resolve))
    // A partially received TCP DNS frame is a live flow even before lookup.
    dnsClient.write(Buffer.from([0, query.length]))
    await waitActive(1)
    await command('POST', '/pause')
    const refused = net.connect({ host: '127.0.0.1', port: dnsPort })
    await new Promise((resolve) => {
      refused.on('error', resolve)
      refused.on('close', resolve)
    })
    assert.equal((await command('GET', '/status')).body.active, 1)
    dnsClient.end()
    await waitActive(0)
    await command('POST', '/resume')
    const oldControl = new EgressDrainClient({ id: 'controlled-helper', socketPath: control })
    await oldControl.pause()
    await new Promise((resolve) => {
      helper.once('exit', resolve)
      helper.kill('SIGTERM')
    })
    const replacement = spawn(binary, ['-config', cfg], { stdio: ['ignore', 'ignore', 'pipe'] })
    replacement.stderr.on('data', (chunk) => {
      stderr += chunk
    })
    children.push(replacement)
    for (let i = 0; i < 150; i++) {
      try {
        if ((await command('GET', '/status')).body.instance !== oldControl.instance) break
      } catch {}
      await delay(10)
    }
    await assert.rejects(oldControl.resume(), /managed_helper_control_failed/)
    assert.equal((await command('GET', '/status')).body.paused, false)
    const replacementControl = new EgressDrainClient({ id: 'controlled-helper', socketPath: control })
    joint = await acquireManagedDrain({ ids: ['controlled-helper'], helpers: [replacementControl] })
    assert.equal(await joint.wait(100), true)
    await joint.release({ unavailable: true })
    assert.equal((await command('GET', '/status')).body.paused, true)
    assert.ok(!stderr.includes('DATA RACE'))
    await mkdir('.tmp/managed-egress-e2e', { recursive: true })
    const files = [
      'src/lib/vm/managed-egress-drain.mjs',
      'src/lib/vm/egress.mjs',
      'worker/internal/egress/server.go',
      'worker/internal/egress/drain.go',
      'test/e2e/managed-egress-helper.e2e.test.mjs',
    ]
    await writeFile(
      '.tmp/managed-egress-e2e/helper-receipt.json',
      JSON.stringify(
        {
          command:
            'KIN_EGRESS_TEST_BIN=/path/to/kin-egress SING_BOX_BIN=/path/to/sing-box node --test test/e2e/managed-egress-helper.e2e.test.mjs',
          build_command: 'cd worker && go build -race -o ../.tmp/managed-egress-helper/kin-egress ./cmd/kin-egress',
          environment: `${process.platform}/${process.arch}`,
          scope: 'compiled helper and real SOCKS/DoH/DNS; transparent TCP needs Linux acceptance',
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
          binary_sha256: createHash('sha256')
            .update(await readFile(binary))
            .digest('hex'),
          results: {
            joint_drain: 'control-plane requests finish before helper pause; both sides awaited',
            replacement: 'old client cannot resume replacement process',
            failed_runtime: 'helper remains paused',
            private_control: 'mode 0600',
            udp_dns: 'live query completed; new query rejected',
            tcp_dns: 'partial frame counted; new connection rejected; closing releases flow',
          },
        },
        null,
        2,
      ),
    )
  } finally {
    releaseHost?.()
    await joint?.release()
    setManagedEgressReady('controlled-helper', false)
    release?.()
    dnsClient?.destroy()
    try {
      udp.close()
    } catch {}
    for (const child of children.reverse())
      if (child.exitCode === null && child.signalCode === null)
        await new Promise((resolve) => {
          child.once('exit', resolve)
          child.kill('SIGTERM')
        })
    upstream.closeAllConnections()
    await new Promise((resolve) => upstream.close(resolve))
    await rm(dir, { recursive: true, force: true })
  }
})
