import test from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'
import { api, seedVm, startGateway } from '../harness.mjs'

// Experiment only. Failure inventory: first-request races, queue bypass,
// cross-slot fallback, cross-principal identity and lost restart bindings.
// This proxy is not part of production routing or cache acceptance evidence.
test('durable request binding pins real HTTP gateway dispatch to one slot', async () => {
  const out = process.env.KIN_SLOT_EVIDENCE_DIR || fs.mkdtempSync(path.join(os.tmpdir(), 'slot-affinity-evidence-'))
  fs.mkdirSync(out, { recursive: true })
  const project = fs.mkdtempSync(path.join(os.tmpdir(), 'slot-affinity-prototype-'))
  const slots = ['vm-sim-01', 'vm-sim-02']
  for (const id of slots) {
    const vm = seedVm({ project, id })
    vm.claude.account_uuid = `account-${id}`
    fs.writeFileSync(path.join(project, 'vms', `${id}.json`), JSON.stringify(vm))
  }
  const gw = await startGateway({ project, env: { KIN_KERNEL_BIN: process.execPath } })
  const checks = [],
    available = new Set(slots),
    locks = new Map()
  let server,
    db,
    base,
    sequence = 0
  const stable = (value) =>
    Array.isArray(value)
      ? value.map(stable)
      : value && typeof value === 'object'
        ? Object.fromEntries(
            Object.keys(value)
              .sort()
              .map((key) => [key, stable(value[key])]),
          )
        : value
  const keyOf = (principal, body) => {
    const { stream, ...inference } = body
    return crypto
      .createHmac('sha256', 'synthetic-persisted-experiment-secret')
      .update(JSON.stringify([principal, stable(inference)]))
      .digest('hex')
  }
  const acquire = (slot, timeout) =>
    new Promise((resolve, reject) => {
      const lock = locks.get(slot) || { busy: false, waiting: [] }
      locks.set(slot, lock)
      const grant = () => {
        lock.busy = true
        resolve(() => {
          const next = lock.waiting.shift()
          if (next) {
            clearTimeout(next.timer)
            next.grant()
          } else lock.busy = false
        })
      }
      if (!lock.busy) return grant()
      const waiter = { grant, timer: null }
      waiter.timer = setTimeout(() => {
        lock.waiting.splice(lock.waiting.indexOf(waiter), 1)
        reject(new Error('slot_queue_timeout'))
      }, timeout)
      lock.waiting.push(waiter)
    })
  const start = async () => {
    db = new DatabaseSync(path.join(project, 'request-bindings.db'))
    db.exec('CREATE TABLE IF NOT EXISTS bindings (key TEXT PRIMARY KEY, slot TEXT NOT NULL)')
    server = http.createServer(async (req, res) => {
      let release
      const reply = (status, body) => {
        res.writeHead(status, { 'content-type': 'application/json' })
        res.end(JSON.stringify(body))
      }
      try {
        const principal = req.headers.authorization
        if (!['Bearer tenant-a', 'Bearer tenant-b'].includes(principal)) return reply(401, { error: 'unauthorized' })
        const chunks = []
        for await (const chunk of req) chunks.push(chunk)
        const body = JSON.parse(Buffer.concat(chunks))
        const key = keyOf(principal, body)
        // Single SQLite writer finishes this transaction before any await.
        db.exec('BEGIN IMMEDIATE')
        let row
        try {
          row = db.prepare('SELECT slot FROM bindings WHERE key = ?').get(key)
          if (!row) {
            const count = db.prepare('SELECT COUNT(*) n FROM bindings').get().n
            const slot = slots[count % slots.length]
            db.prepare('INSERT INTO bindings VALUES (?, ?)').run(key, slot)
            row = { slot }
          }
          db.exec('COMMIT')
        } catch (error) {
          db.exec('ROLLBACK')
          throw error
        }
        if (!available.has(row.slot)) return reply(503, { error: 'bound_slot_unavailable', slot: row.slot })
        release = await acquire(row.slot, Number(req.headers['x-fixture-wait-ms'] || 2000))
        if (!available.has(row.slot)) return reply(503, { error: 'bound_slot_unavailable', slot: row.slot })
        const delay = Number(req.headers['x-fixture-hold-ms'] || 0)
        if (delay) await new Promise((resolve) => setTimeout(resolve, delay))
        const forwarded = await api(gw, 'POST', '/v1/messages', {
          headers: { 'x-kin-vm': row.slot, 'x-claude-code-session-id': `isolated-execution-${++sequence}` },
          body,
        })
        res.writeHead(forwarded.status, {
          'content-type': forwarded.headers.get('content-type'),
          'x-request-id': forwarded.headers.get('x-request-id'),
          'x-fixture-slot': row.slot,
        })
        res.end(forwarded.text)
      } catch (error) {
        reply(error.message === 'slot_queue_timeout' ? 529 : 500, { error: error.message })
      } finally {
        release?.()
      }
    })
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
    base = `http://127.0.0.1:${server.address().port}`
  }
  const stop = async () => {
    await new Promise((resolve) => server.close(resolve))
    db.close()
  }
  const body = {
    model: 'claude-opus-5-5',
    max_tokens: 32,
    messages: [{ role: 'user', content: 'SYNTHETIC_REPEATED_SLOT_AFFINITY' }],
  }
  const send = async (principal = 'tenant-a', headers = {}, value = body) => {
    const response = await fetch(base + '/v1/messages', {
      method: 'POST',
      headers: { authorization: `Bearer ${principal}`, 'content-type': 'application/json', ...headers },
      body: JSON.stringify(value),
    })
    const text = await response.text()
    return {
      status: response.status,
      slot: response.headers.get('x-fixture-slot'),
      requestId: response.headers.get('x-request-id'),
      text,
    }
  }
  try {
    await start()
    const concurrent = await Promise.all(Array.from({ length: 6 }, () => send()))
    assert.ok(concurrent.every((row) => row.status === 200 && row.slot === slots[0]))
    assert.equal(db.prepare('SELECT COUNT(*) n FROM bindings').get().n, 1)
    const logs = await api(gw, 'GET', '/api/panel/usage-logs?limit=100')
    for (const row of concurrent)
      assert.equal(logs.json.data.logs.find((item) => item.requestId === row.requestId).vmId, slots[0])
    checks.push({
      name: 'concurrent_first_requests_one_binding_one_actual_slot',
      result: 'PASS',
      requests: concurrent.length,
      slot: slots[0],
    })
    const reordered = await send(
      'tenant-a',
      {},
      { messages: body.messages, max_tokens: 32, model: body.model, stream: true },
    )
    assert.equal(reordered.status, 200)
    assert.equal(reordered.slot, slots[0])
    assert.equal(db.prepare('SELECT COUNT(*) n FROM bindings').get().n, 1)
    checks.push({ name: 'canonical_input_and_stream_delivery_preserve_binding', result: 'PASS' })
    const second = await send('tenant-b')
    assert.equal(second.status, 200)
    assert.equal(second.slot, slots[1])
    checks.push({ name: 'different_principal_separate_binding', result: 'PASS' })
    const held = send('tenant-a', { 'x-fixture-hold-ms': '250' })
    while (!locks.get(slots[0])?.busy) await new Promise((resolve) => setTimeout(resolve, 5))
    const timed = await send('tenant-a', { 'x-fixture-wait-ms': '40' })
    assert.equal(timed.status, 529)
    assert.match(timed.text, /slot_queue_timeout/)
    assert.equal((await held).slot, slots[0])
    checks.push({ name: 'busy_slot_waits_then_times_out_without_fallback', result: 'PASS' })
    available.delete(slots[0])
    const before = sequence
    const unavailable = await send()
    assert.equal(unavailable.status, 503)
    assert.equal(sequence, before)
    assert.match(unavailable.text, /bound_slot_unavailable/)
    checks.push({ name: 'unavailable_bound_slot_no_dispatch_to_idle_alternative', result: 'PASS' })
    await stop()
    available.add(slots[0])
    await start()
    const restored = await send()
    assert.equal(restored.status, 200)
    assert.equal(restored.slot, slots[0])
    assert.equal(db.prepare('SELECT COUNT(*) n FROM bindings').get().n, 2)
    checks.push({ name: 'restart_restores_same_slot_binding', result: 'PASS' })
    fs.writeFileSync(
      path.join(out, 'receipt.json'),
      JSON.stringify(
        {
          result: 'PASS',
          boundary: 'experimental proxy -> real vm2api HTTP scheduler -> mock upstream; not production implementation',
          checks,
        },
        null,
        2,
      ) + '\n',
    )
  } catch (error) {
    fs.writeFileSync(
      path.join(out, 'receipt.json'),
      JSON.stringify({ result: 'FAIL', checks, error: error.stack }, null, 2) + '\n',
    )
    throw error
  } finally {
    if (server?.listening) await stop()
    await gw.stop()
    fs.rmSync(project, { recursive: true, force: true })
    console.log('slot affinity prototype evidence: ' + out)
  }
})
