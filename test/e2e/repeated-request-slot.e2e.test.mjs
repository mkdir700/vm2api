import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { api, seedVm, startGateway, readTrace } from '../harness.mjs'

// Failure inventory: same completed session, cross-slot fallback, diagnostic
// eligibility bypass, race, lost restart state and changed cacheable input.
test('production HTTP binds repeated input to one eligible slot and regenerates', async () => {
  const out =
    process.env.KIN_REQUEST_SLOT_EVIDENCE_DIR || fs.mkdtempSync(path.join(os.tmpdir(), 'request-slot-evidence-'))
  fs.mkdirSync(out, { recursive: true })
  const project = fs.mkdtempSync(path.join(os.tmpdir(), 'request-slot-http-'))
  for (const id of ['vm-sim-01', 'vm-sim-02']) {
    const vm = seedVm({ project, id })
    vm.claude.account_uuid = `account-${id}`
    fs.writeFileSync(path.join(project, 'vms', `${id}.json`), JSON.stringify(vm))
  }
  const checks = []
  const start = () =>
    startGateway({ project, env: { KIN_KERNEL_BIN: process.execPath, KIN_REQUEST_LOG_MODE: 'debug' } })
  let gw = await start()
  const body = {
    model: 'claude-opus-5-5',
    max_tokens: 128,
    system: [{ type: 'text', text: 'SYNTHETIC_STABLE_PREFIX', cache_control: { type: 'ephemeral' } }],
    messages: [{ role: 'user', content: 'SYNTHETIC_REGENERATE' }],
  }
  const send = async (value = body) => {
    const response = await api(gw, 'POST', '/v1/messages', { body: value })
    const logs = await api(gw, 'GET', '/api/panel/usage-logs?limit=100')
    const row = logs.json.data.logs.find((row) => row.requestId === response.headers.get('x-request-id'))
    return { response, row, trace: readTrace(gw) }
  }
  try {
    const first = await send()
    const second = await send()
    assert.equal(first.response.status, 200, first.response.text)
    assert.equal(second.response.status, 200, second.response.text)
    assert.equal(second.row.vmId, first.row.vmId)
    assert.ok(first.row.sessionId, 'must observe outbound session identity')
    assert.notEqual(second.row.sessionId, first.row.sessionId, 'same input must create a fresh completed generation')
    for (const key of ['tools', 'system', 'messages']) assert.deepEqual(second.trace.body[key], first.trace.body[key])
    checks.push({ name: 'same_slot_new_execution_stable_prefix', result: 'PASS', slot: first.row.vmId })
    const concurrent = await Promise.all(Array.from({ length: 6 }, () => send()))
    assert.ok(concurrent.every((item) => item.response.status === 200 && item.row.vmId === first.row.vmId))
    assert.equal(new Set(concurrent.map((item) => item.row.sessionId)).size, 6)
    checks.push({ name: 'six_concurrent_repeats_one_slot_distinct_generations', result: 'PASS' })
    const reordered = await send({
      messages: body.messages,
      system: body.system,
      max_tokens: 128,
      model: body.model,
      stream: true,
    })
    assert.equal(reordered.response.status, 200, reordered.response.text)
    assert.equal(reordered.row.vmId, first.row.vmId)
    checks.push({ name: 'canonical_keys_and_stream_share_binding', result: 'PASS' })
    await gw.stop()
    gw = await start()
    const restarted = await send()
    assert.equal(restarted.response.status, 200, restarted.response.text)
    assert.equal(restarted.row.vmId, first.row.vmId)
    assert.notEqual(restarted.row.sessionId, reordered.row.sessionId)
    checks.push({ name: 'restart_keeps_binding_and_regenerates', result: 'PASS' })
    const keys = []
    for (const id of ['vm-sim-01', 'vm-sim-02']) {
      const created = await api(gw, 'POST', '/api/panel/api-keys', {
        body: { name: `isolated-${id}`, group_type: 'anthropic', allowed_vms: [id] },
      })
      assert.equal(created.status, 201, created.text)
      keys.push(created.json.item)
    }
    for (const [index, key] of keys.entries()) {
      const response = await api(gw, 'POST', '/v1/messages', { headers: { authorization: `Bearer ${key.key}` }, body })
      assert.equal(response.status, 200, response.text)
      const logs = await api(gw, 'GET', '/api/panel/usage-logs?limit=100')
      assert.equal(
        logs.json.data.logs.find((row) => row.requestId === response.headers.get('x-request-id')).vmId,
        `vm-sim-0${index + 1}`,
      )
    }
    const changed = await api(gw, 'PATCH', `/api/panel/api-keys/${keys[0].id}`, {
      body: { allowed_vms: ['vm-sim-02'] },
    })
    assert.equal(changed.status, 200, changed.text)
    const forbidden = await api(gw, 'POST', '/v1/messages', {
      headers: { authorization: `Bearer ${keys[0].key}` },
      body,
    })
    assert.equal(forbidden.status, 503, forbidden.text)
    assert.equal(forbidden.json.error.code, 'bound_slot_unavailable')
    checks.push({ name: 'key_scope_isolation_and_revocation_never_rebind', result: 'PASS' })
    const disabled = await api(gw, 'POST', `/api/panel/vms/${first.row.vmId}/schedulable`, {
      body: { schedulable: false },
    })
    assert.equal(disabled.status, 200, disabled.text)
    const stopped = await send()
    assert.equal(stopped.response.status, 503, stopped.response.text)
    assert.equal(stopped.response.json.error.code, 'bound_slot_unavailable')
    checks.push({ name: 'disabled_bound_slot_not_bypassed_or_replaced', result: 'PASS' })
    fs.writeFileSync(
      path.join(out, 'receipt.json'),
      JSON.stringify({ result: 'PASS', checks, boundary: 'production HTTP scheduler with mock upstream' }, null, 2) +
        '\n',
    )
  } catch (error) {
    fs.writeFileSync(
      path.join(out, 'receipt.json'),
      JSON.stringify({ result: 'FAIL', checks, error: error.stack }, null, 2) + '\n',
    )
    throw error
  } finally {
    await gw.stop()
    fs.rmSync(project, { recursive: true, force: true })
    console.log('request slot evidence: ' + out)
  }
})

test('same request queue has a deadline and cancellation does not poison later execution', async () => {
  const project = fs.mkdtempSync(path.join(os.tmpdir(), 'request-slot-queue-'))
  seedVm({ project })
  const routing = JSON.parse(fs.readFileSync(new URL('../../src/config/routing.json', import.meta.url)))
  routing.failover.session_queue_timeout_ms = 50
  fs.mkdirSync(path.join(project, 'config'), { recursive: true })
  fs.writeFileSync(path.join(project, 'config/routing.json'), JSON.stringify(routing))
  const gw = await startGateway({ project, env: { KIN_KERNEL_BIN: process.execPath, KIN_MOCK_DELAY_MS: '200' } })
  const body = { model: 'claude-opus-5-5', messages: [{ role: 'user', content: 'SYNTHETIC_QUEUE_DEADLINE' }] }
  try {
    const held = api(gw, 'POST', '/v1/messages', { body })
    while (!fs.existsSync(gw.traceFile)) await new Promise((resolve) => setTimeout(resolve, 5))
    const controller = new AbortController()
    const cancelled = fetch(gw.baseUrl + '/v1/messages', {
      method: 'POST',
      headers: { authorization: `Bearer ${gw.apiKey}`, 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: controller.signal,
    }).catch((error) => error)
    await new Promise((resolve) => setTimeout(resolve, 10))
    controller.abort()
    assert.equal((await cancelled).name, 'AbortError')
    const queued = await api(gw, 'POST', '/v1/messages', { body })
    assert.equal(queued.status, 529, queued.text)
    assert.equal((await held).status, 200)
    assert.equal((await api(gw, 'POST', '/v1/messages', { body })).status, 200)
  } finally {
    await gw.stop()
    fs.rmSync(project, { recursive: true, force: true })
  }
})

test('bound request upstream failures never retry another slot', async () => {
  const project = fs.mkdtempSync(path.join(os.tmpdir(), 'request-slot-failure-'))
  for (const id of ['vm-sim-01', 'vm-sim-02']) {
    const vm = seedVm({ project, id })
    vm.claude.account_uuid = `account-${id}`
    fs.writeFileSync(path.join(project, 'vms', `${id}.json`), JSON.stringify(vm))
  }
  const gw = await startGateway({ project, scenario: 'error', env: { KIN_KERNEL_BIN: process.execPath } })
  try {
    const response = await api(gw, 'POST', '/v1/messages', {
      body: { model: 'claude-opus-5-5', messages: [{ role: 'user', content: 'SYNTHETIC_NO_HOP' }] },
    })
    assert.ok(response.status >= 400, response.text)
    const logs = await api(gw, 'GET', '/api/panel/usage-logs?limit=100')
    assert.equal(logs.json.data.logs[0].attemptCount, 1)
  } finally {
    await gw.stop()
    fs.rmSync(project, { recursive: true, force: true })
  }
})

test('tool wait preserves execution and completed tool history permits regeneration', async () => {
  const gw = await startGateway({ scenario: 'tool_cycle', env: { KIN_KERNEL_BIN: process.execPath } })
  const headers = { 'x-claude-code-session-id': 'synthetic-tool-conversation' }
  const body = {
    model: 'claude-opus-5-5',
    messages: [{ role: 'user', content: 'SYNTHETIC_TOOL_LIFECYCLE' }],
    tools: [
      {
        name: 'read_file',
        description: 'synthetic',
        input_schema: { type: 'object', properties: { path: { type: 'string' } } },
      },
    ],
  }
  try {
    const send = async (value, session = headers['x-claude-code-session-id']) => {
      const response = await api(gw, 'POST', '/v1/messages', {
        headers: { ...headers, 'x-claude-code-session-id': session },
        body: value,
      })
      assert.equal(response.status, 200, response.text)
      const logs = await api(gw, 'GET', '/api/panel/usage-logs?limit=100')
      return {
        response,
        trace: readTrace(gw),
        session: logs.json.data.logs.find((row) => row.requestId === response.headers.get('x-request-id')).sessionId,
      }
    }
    const first = await send(body),
      pending = await send(body)
    assert.equal(first.response.json.stop_reason, 'tool_use')
    assert.equal(pending.session, first.session)
    const independent = await send(body, 'synthetic-independent-conversation')
    assert.notEqual(independent.session, first.session)
    const completed = await send({
      ...body,
      messages: [
        ...body.messages,
        { role: 'assistant', content: first.response.json.content },
        {
          role: 'user',
          content: [
            { type: 'tool_result', tool_use_id: first.response.json.content[0].id, content: 'SYNTHETIC_TOOL_DONE' },
          ],
        },
      ],
    })
    assert.equal(completed.response.json.stop_reason, 'end_turn')
    assert.equal(completed.session, first.session)
    const billingId = (item) => JSON.stringify(item.trace.body.system).match(/cc_prompt_id=([^;]+)/)?.[1]
    assert.ok(billingId(first))
    assert.equal(billingId(completed), billingId(first), 'continuation inherits stable cache identity')
    const regenerated = await send(body)
    assert.notEqual(regenerated.session, first.session)
  } finally {
    await gw.stop()
    fs.rmSync(gw.project, { recursive: true, force: true })
  }
})

test('binding storage failure rejects HTTP without dispatch or fallback', async () => {
  const gw = await startGateway({ env: { KIN_KERNEL_BIN: process.execPath } })
  const body = { model: 'claude-opus-5-5', messages: [{ role: 'user', content: 'SYNTHETIC_SLOT_STORAGE' }] }
  try {
    assert.equal((await api(gw, 'POST', '/v1/messages', { body })).status, 200)
    const db = new DatabaseSync(path.join(gw.project, 'data', 'kin.db'))
    assert.doesNotMatch(
      JSON.stringify(db.prepare('SELECT * FROM request_slot_bindings').all()),
      /SYNTHETIC_SLOT_STORAGE/,
    )
    db.exec('DROP TABLE request_slot_executions')
    db.close()
    fs.unlinkSync(gw.traceFile)
    const response = await api(gw, 'POST', '/v1/messages', { body })
    assert.equal(response.status, 503, response.text)
    assert.equal(response.json.error.code, 'request_slot_store_unavailable')
    assert.equal(fs.existsSync(gw.traceFile), false)
  } finally {
    await gw.stop()
    fs.rmSync(gw.project, { recursive: true, force: true })
  }
})
