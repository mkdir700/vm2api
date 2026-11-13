import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'
import { api, startGateway, takeTrace, GATEWAY_ROOT } from '../harness.mjs'

// Failure inventory: normalization hides invalid blocks; account switching or
// repair retries accept them; partial fingerprints accept modified blocks;
// missing ownership storage fails open; genuine round trips stop working.
test('HTTP rejects unverified thinking before upstream execution', async () => {
  const out = process.env.KIN_THINKING_EVIDENCE_DIR || fs.mkdtempSync(path.join(os.tmpdir(), 'thinking-rejection-'))
  fs.mkdirSync(out, { recursive: true })
  const checks = []
  const project = fs.mkdtempSync(path.join(os.tmpdir(), 'thinking-rejection-gateway-'))
  fs.mkdirSync(path.join(project, 'config'), { recursive: true })
  const routing = JSON.parse(fs.readFileSync(path.join(GATEWAY_ROOT, 'config', 'routing.json'), 'utf8'))
  routing.failover.signature_repair = true
  fs.writeFileSync(path.join(project, 'config', 'routing.json'), JSON.stringify(routing))
  let gw = await startGateway({
    project,
    scenario: 'signed_thinking',
    env: { KIN_KERNEL_BIN: process.execPath, KIN_REQUEST_LOG_MODE: 'debug' },
  })
  const body = (content, stream = false) => ({
    model: 'claude-opus-5-5',
    max_tokens: 2048,
    thinking: { type: 'adaptive' },
    stream,
    messages: [
      { role: 'user', content: 'SYNTHETIC_SIGNATURE_PROBE' },
      { role: 'assistant', content },
      { role: 'user', content: 'Continue.' },
    ],
  })
  const reject = async (name, request, status = 400, code = 'invalid_thinking_signature') => {
    takeTrace(gw)
    const response = await api(gw, 'POST', '/v1/messages', { body: request })
    const trace = takeTrace(gw)
    checks.push({ name, status: response.status, code: response.json?.error?.code, upstreamCalled: !!trace })
    assert.equal(response.status, status, `${name}: ${response.text}`)
    assert.equal(response.json?.error?.type, status === 400 ? 'invalid_request_error' : 'api_error', name)
    assert.equal(response.json?.error?.code, code, name)
    assert.equal(trace, null, `${name}: must not call upstream`)
    const logs = await api(gw, 'GET', '/api/panel/usage-logs?limit=100')
    const row = logs.json.data.logs.find((row) => row.requestId === response.headers.get('x-request-id'))
    assert.ok(row, `${name}: missing usage log`)
    assert.equal(row.errorCode, code, name)
    if (status === 400) assert.equal(row.errorClass, 'signature', name)
  }
  try {
    for (const stream of [false, true]) {
      await reject(
        `unknown-${stream}`,
        body(
          [
            {
              type: 'thinking',
              thinking: 'Record the requested value.',
              signature: 'bW9kZWwtY2hlY2staW52YWxpZC1zaWduYXR1cmU=',
            },
            { type: 'text', text: 'PONG' },
          ],
          stream,
        ),
      )
      await reject(`missing-${stream}`, body([{ type: 'thinking', thinking: 'unsigned' }], stream))
      await reject(`short-${stream}`, body([{ type: 'thinking', thinking: 'short', signature: 'x' }], stream))
      await reject(
        `redacted-${stream}`,
        body([{ type: 'redacted_thinking', data: 'unknown-redacted-block-0123456789' }], stream),
      )
      const disabled = body([{ type: 'thinking', thinking: 'hidden', signature: 'x' }], stream)
      disabled.thinking = { type: 'disabled' }
      await reject(`disabled-${stream}`, disabled)
    }
    const initial = await api(gw, 'POST', '/v1/messages', {
      body: {
        model: 'claude-opus-5-5',
        max_tokens: 2048,
        thinking: { type: 'adaptive' },
        messages: [{ role: 'user', content: 'Generate a signed fixture.' }],
      },
    })
    assert.equal(initial.status, 200, initial.text)
    const signed = initial.json.content.filter((block) => ['thinking', 'redacted_thinking'].includes(block.type))
    assert.equal(signed.length, 2)
    for (const stream of [false, true]) {
      takeTrace(gw)
      const continued = await api(gw, 'POST', '/v1/messages', { body: body(initial.json.content, stream) })
      assert.equal(continued.status, 200, continued.text)
      const sent = takeTrace(gw)
      const blocks = sent.body.messages.flatMap((message) => (Array.isArray(message.content) ? message.content : []))
      for (const block of signed) assert.ok(blocks.some((item) => JSON.stringify(item) === JSON.stringify(block)))
      checks.push({ name: `recorded-roundtrip-${stream}`, status: continued.status, upstreamCalled: true })
    }
    const changed = structuredClone(signed[0])
    changed.signature = changed.signature.slice(0, 120) + 'TAMPERED' + changed.signature.slice(128)
    assert.equal(changed.signature.length, signed[0].signature.length)
    await reject('signature-middle-modified', body([changed]))
    await reject('thinking-text-modified', body([{ ...signed[0], thinking: 'modified reasoning' }]))
    const db = new DatabaseSync(path.join(gw.project, 'data', 'kin.db'))
    try {
      db.exec("UPDATE thinking_signature_owners SET account_id = 'another-account'")
      await reject('account-mismatch', body(initial.json.content))
      db.exec('DELETE FROM thinking_signature_owners')
      // A legacy partial key cannot establish the exact signed payload.
      const signature = signed[0].signature
      const legacyKey = createHash('sha256')
        .update(`${signature.length}:${signature.slice(0, 100)}${signature.slice(-100)}`)
        .digest('hex')
        .slice(0, 32)
      db.prepare('INSERT INTO thinking_signature_owners VALUES (?, ?, ?)').run(legacyKey, 'acct-seed', Date.now())
      await reject('legacy-record-does-not-authorize', body(initial.json.content))
      db.exec('DROP TABLE thinking_signature_owners')
      await reject('store-unavailable', body(initial.json.content), 503, 'thinking_signature_store_unavailable')
    } finally {
      db.close()
    }
    await gw.stop()
    gw = await startGateway({
      project,
      scenario: 'invalid_thinking_signature',
      env: { KIN_KERNEL_BIN: process.execPath },
    })
    for (const stream of [false, true]) {
      const request = {
        model: 'claude-opus-5-5',
        max_tokens: 2048,
        thinking: { type: 'adaptive' },
        stream,
        messages: [{ role: 'user', content: `SYNTHETIC_UPSTREAM_SIGNATURE_REJECTION_${stream}` }],
      }
      const response = await api(gw, 'POST', '/v1/messages', { body: request })
      assert.equal(response.status, 400, response.text)
      assert.match(response.json.error.message, /Invalid signature/)
      const logs = await api(gw, 'GET', '/api/panel/usage-logs?limit=100')
      const row = logs.json.data.logs.find((row) => row.requestId === response.headers.get('x-request-id'))
      assert.equal(row.attemptCount, 1, 'legacy repair switch must not retry signature errors')
      checks.push({
        name: `upstream-rejection-no-repair-${stream}`,
        status: response.status,
        attempts: row.attemptCount,
      })
    }
    fs.writeFileSync(
      path.join(out, 'receipt.json'),
      JSON.stringify({ result: 'PASS', upstream: 'in-process mock', checks }, null, 2) + '\n',
    )
  } catch (error) {
    fs.writeFileSync(
      path.join(out, 'receipt.json'),
      JSON.stringify({ result: 'FAIL', checks, error: error.message }, null, 2) + '\n',
    )
    throw error
  } finally {
    await gw.stop()
    fs.rmSync(gw.project, { recursive: true, force: true })
    console.log('thinking signature evidence: ' + out)
  }
})
