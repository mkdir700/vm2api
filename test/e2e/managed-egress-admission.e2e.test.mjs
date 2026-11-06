import test from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import path from 'node:path'
import { tmpdir } from 'node:os'
import { mkdtemp, mkdir, rm, writeFile, readFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { withManagedEgressOperation, pauseManagedEgress } from '../../src/lib/vm/managed-egress-admission.mjs'
import { setManagedEgressReady } from '../../src/lib/vm/managed-egress-readiness.mjs'
import { callWorkerPost, callGoWorker, streamGoWorker } from '../../src/lib/transport/go-worker-client.mjs'
import { proxyBlockedReason } from '../../src/lib/vm/proxy-policy.mjs'

test('real Unix worker transport retains admission until its response ends', { timeout: 10000 }, async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'managed-admission-'))
  const socket = path.join(directory, 'worker.sock')
  const proxy = { id: 'admission-controlled', managed: true }
  const exec = { vm: { proxy, runtime: { worker_socket: socket } } }
  let complete
  let started
  let calls = 0
  const received = new Promise((resolve) => {
    started = resolve
  })
  const worker = http.createServer((req, res) => {
    calls++
    req.resume()
    res.writeHead(200, { 'content-type': 'application/json' })
    if (req.url === '/held') {
      res.write('{"ok":')
      complete = () => res.end('true}')
      started()
    } else res.end('{"ok":true}')
  })
  await new Promise((resolve) => worker.listen(socket, resolve))
  let drain
  setManagedEgressReady(proxy.id, true)
  try {
    const inflight = callWorkerPost(exec, '/held', {})
    await received
    drain = pauseManagedEgress([proxy.id])
    assert.equal(proxyBlockedReason(proxy), 'managed_egress_not_ready')
    assert.equal(await drain.wait(20), false)
    for (const operation of [
      () => callWorkerPost(exec, '/new', {}),
      () => callGoWorker({ exec }),
      () => streamGoWorker({ exec }),
    ]) {
      await assert.rejects(operation(), { code: 'managed_egress_not_ready' })
    }
    assert.equal(calls, 1)
    assert.equal(
      (
        await callWorkerPost(
          { vm: { proxy: { id: 'external-socks' }, runtime: { worker_socket: socket } } },
          '/external-unchanged',
          {},
        )
      ).ok,
      true,
    )

    complete()
    assert.equal((await inflight).ok, true)
    assert.equal(await drain.wait(100), true)
    await drain.release()
    assert.equal((await callWorkerPost(exec, '/resumed', {})).ok, true)
    assert.equal(proxyBlockedReason(proxy), null)
    const failedTransport = await callWorkerPost(
      { vm: { proxy, runtime: { worker_socket: path.join(directory, 'absent.sock') } } },
      '/transport-error',
      {},
    )
    assert.equal(failedTransport.ok, false)
    drain = pauseManagedEgress([proxy.id])
    assert.equal(await drain.wait(1), true)
    await drain.release()
    await withManagedEgressOperation(proxy, async () => {
      setManagedEgressReady(proxy.id, false)
      assert.equal(proxyBlockedReason(proxy), null)
      assert.equal((await callWorkerPost(exec, '/admitted-during-edit', {})).ok, true)
    })
    await assert.rejects(callWorkerPost(exec, '/new-after-edit', {}), { code: 'managed_egress_not_ready' })
    setManagedEgressReady(proxy.id, true)
    await withManagedEgressOperation(proxy, async () => {
      drain = pauseManagedEgress([proxy.id])
      // This credential call belongs to the already-admitted parent request.
      assert.equal((await callWorkerPost(exec, '/nested-credential', {})).ok, true)
      assert.equal(await drain.wait(1), false)
    })
    assert.equal(await drain.wait(100), true)
    await drain.release({ unavailable: true })
    await assert.rejects(callWorkerPost(exec, '/must-stay-blocked', {}), { code: 'managed_egress_not_ready' })
    await mkdir('.tmp/managed-egress-e2e', { recursive: true })
    const files = [
      'src/lib/vm/managed-egress-admission.mjs',
      'src/lib/transport/go-worker-client.mjs',
      'src/lib/transport/slot-oauth.mjs',
      'src/lib/vm/proxy-policy.mjs',
      'test/e2e/managed-egress-admission.e2e.test.mjs',
    ]
    await writeFile(
      '.tmp/managed-egress-e2e/admission-receipt.json',
      JSON.stringify(
        {
          command: 'node --test test/e2e/managed-egress-admission.e2e.test.mjs',
          scope: 'real Unix HTTP transport; controlled worker; no actual Claude or slot runtime',
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
            partial_body: 'lease retained',
            drain_timeout: 'preserved live request',
            new_transport: 'rejected before worker',
            nested_credential: 'finished during drain',
            unavailable: 'remains blocked after lease release',
          },
        },
        null,
        2,
      ),
    )
  } finally {
    complete?.()
    await drain?.release()
    setManagedEgressReady(proxy.id, false)
    worker.closeAllConnections()
    await new Promise((resolve) => worker.close(resolve))
    await rm(directory, { recursive: true, force: true })
  }
})
