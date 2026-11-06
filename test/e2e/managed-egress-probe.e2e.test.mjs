import test from 'node:test'
import assert from 'node:assert/strict'
import net from 'node:net'
import path from 'node:path'
import { tmpdir } from 'node:os'
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { ProxyPool } from '../../src/lib/vm/proxy-pool.mjs'
import { createDatabase } from '../../src/lib/db/database.mjs'
import { pauseManagedEgress } from '../../src/lib/vm/managed-egress-admission.mjs'
import { setManagedEgressReady } from '../../src/lib/vm/managed-egress-readiness.mjs'

test('SOCKS probe admission retains live sockets and releases timed-out sockets', { timeout: 10000 }, async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'managed-probe-'))
  const db = createDatabase({ dbPath: path.join(dir, 'kin.db') })
  const pool = new ProxyPool({ db })
  let connections = 0
  let greeting
  let releaseGreeting
  const received = new Promise((resolve) => {
    greeting = resolve
  })
  const sockets = new Set()
  const server = net.createServer((socket) => {
    sockets.add(socket)
    connections++
    socket.on('close', () => sockets.delete(socket))
    socket.on('data', () => {
      releaseGreeting = () => socket.write(Buffer.from([5, 0]))
      greeting()
    })
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const proxy = { id: 'controlled-probe', managed: true, host: '127.0.0.1', port: server.address().port }
  setManagedEgressReady(proxy.id, true)
  let drain
  try {
    const active = pool._socksProbe(proxy, proxy.host, 1000)
    await received
    drain = pauseManagedEgress([proxy.id])
    assert.equal(await drain.wait(20), false)
    assert.equal((await pool.probeOne(proxy)).scope, 'pending')
    assert.equal((await pool._socksProbe(proxy, proxy.host, 100)).scope, 'pending')
    assert.equal(connections, 1)
    releaseGreeting()
    assert.equal((await active).ok, true)
    assert.equal(await drain.wait(100), true)
    await drain.release()
    const timeout = await pool._socksProbe(proxy, proxy.host, 30)
    assert.equal(timeout.ok, false)
    drain = pauseManagedEgress([proxy.id])
    assert.equal(await drain.wait(100), true)
    assert.equal(pool._probeSockets.size, 0)
    await mkdir('.tmp/managed-egress-e2e', { recursive: true })
    const files = [
      'src/lib/vm/proxy-pool.mjs',
      'src/lib/vm/managed-egress-admission.mjs',
      'test/e2e/managed-egress-probe.e2e.test.mjs',
    ]
    await writeFile(
      '.tmp/managed-egress-e2e/probe-receipt.json',
      JSON.stringify(
        {
          command: 'node --test test/e2e/managed-egress-probe.e2e.test.mjs',
          scope: 'real TCP SOCKS handshake; controlled probe server; no upstream exit proof',
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
            held_greeting: 'counted',
            paused_probe: 'no new socket',
            timeout: 'socket closed and admission released',
          },
        },
        null,
        2,
      ),
    )
  } finally {
    await drain?.release()
    setManagedEgressReady(proxy.id, false)
    for (const socket of sockets) socket.destroy()
    await new Promise((resolve) => server.close(resolve))
    db.close()
    await rm(dir, { recursive: true, force: true })
  }
})
