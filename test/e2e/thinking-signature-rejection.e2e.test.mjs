import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'
import { api, startGateway, seedVm, takeTrace, GATEWAY_ROOT } from '../harness.mjs'

// 失败清单：未知来源、旧记录和账号变化被本地拒绝；数据库故障阻断请求；
// 空思考文本和短签名被过滤；旧修复开关改写历史；上游签名错误触发重试。
// 验收使用真实 HTTP 网关和模拟上游，不证明真实 Anthropic 验签结果。
test('HTTP delegates thinking signature validation to upstream', async () => {
  const out = process.env.KIN_THINKING_EVIDENCE_DIR || fs.mkdtempSync(path.join(os.tmpdir(), 'thinking-rejection-'))
  fs.mkdirSync(out, { recursive: true })
  const checks = []
  const project = fs.mkdtempSync(path.join(os.tmpdir(), 'thinking-rejection-gateway-'))
  fs.mkdirSync(path.join(project, 'config'), { recursive: true })
  const routing = JSON.parse(fs.readFileSync(path.join(GATEWAY_ROOT, 'config', 'routing.json'), 'utf8'))
  routing.failover.signature_repair = true
  fs.writeFileSync(path.join(project, 'config', 'routing.json'), JSON.stringify(routing))
  const vm = seedVm({ project })
  vm.dataplane = 'hermit'
  fs.writeFileSync(path.join(project, 'vms', `${vm.id}.json`), JSON.stringify(vm))
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
  const forward = async (name, request, status = 200) => {
    takeTrace(gw)
    const response = await api(gw, 'POST', '/v1/messages', { body: request })
    const trace = takeTrace(gw)
    checks.push({ name, status: response.status, upstreamCalled: !!trace })
    assert.equal(response.status, status, `${name}: ${response.text}`)
    assert.ok(trace, `${name}: must call upstream`)
    const thinking = (messages) =>
      messages
        .flatMap((m) => (Array.isArray(m.content) ? m.content : []))
        .filter((b) => ['thinking', 'redacted_thinking'].includes(b.type))
    assert.deepEqual(thinking(trace.body.messages), thinking(request.messages), `${name}: signed history changed`)
    checks.at(-1).thinkingFingerprint = createHash('sha256')
      .update(JSON.stringify(thinking(trace.body.messages)))
      .digest('hex')
    const logs = await api(gw, 'GET', '/api/panel/usage-logs?limit=100')
    const row = logs.json.data.logs.find((row) => row.requestId === response.headers.get('x-request-id'))
    assert.ok(row, `${name}: missing usage log`)
    assert.equal(row.attemptCount, 1, `${name}: expected one upstream attempt`)
    checks.at(-1).attempts = row.attemptCount
    if (status === 400) assert.match(response.json.error.message, /Invalid signature/)
    return response
  }
  const malformed = async (name, block, field, role = 'assistant') => {
    takeTrace(gw)
    const request = body([block])
    request.messages[1].role = role
    const response = await api(gw, 'POST', '/v1/messages', { body: request })
    checks.push({ name, status: response.status, upstreamCalled: !!takeTrace(gw) })
    assert.equal(response.status, 400, `${name}: ${response.text}`)
    assert.equal(response.json.error.code, 'invalid_field', name)
    assert.equal(response.json.error.param, field, name)
    assert.equal(checks.at(-1).upstreamCalled, false, name)
  }
  try {
    for (const stream of [false, true]) {
      await forward(
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
      await forward(`short-${stream}`, body([{ type: 'thinking', thinking: '', signature: 'x' }], stream))
      await forward(
        `redacted-${stream}`,
        body([{ type: 'redacted_thinking', data: 'unknown-redacted-block-0123456789' }], stream),
      )
      const disabled = body([{ type: 'thinking', thinking: 'hidden', signature: 'x' }], stream)
      disabled.thinking = { type: 'disabled' }
      await forward(`disabled-${stream}`, disabled)
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
      await forward(`recorded-roundtrip-${stream}`, body(initial.json.content, stream))
    }
    for (const [name, block, field] of [
      ['missing-signature', { type: 'thinking', thinking: 'reason' }, 'signature'],
      ['empty-signature', { type: 'thinking', thinking: 'reason', signature: '' }, 'signature'],
      ['wrong-signature-type', { type: 'thinking', thinking: 'reason', signature: 123 }, 'signature'],
      ['missing-thinking', { type: 'thinking', signature: 'opaque' }, 'thinking'],
      ['wrong-thinking-type', { type: 'thinking', thinking: 123, signature: 'opaque' }, 'thinking'],
      ['missing-block-type', { thinking: 'reason', signature: 'opaque' }, 'type'],
      ['empty-redacted-data', { type: 'redacted_thinking', data: '' }, 'data'],
      ['wrong-redacted-type', { type: 'redacted_thinking', data: 123 }, 'data'],
    ]) {
      await malformed(name, block, `messages.1.content.0.${field}`)
    }
    await malformed('wrong-role', { type: 'thinking', thinking: '', signature: 'opaque' }, 'messages.1.role', 'user')
    const changed = structuredClone(signed[0])
    changed.signature = changed.signature.slice(0, 120) + 'TAMPERED' + changed.signature.slice(128)
    assert.equal(changed.signature.length, signed[0].signature.length)
    await forward('signature-middle-modified', body([changed]))
    await forward('thinking-text-modified', body([{ ...signed[0], thinking: 'modified reasoning' }]))
    const db = new DatabaseSync(path.join(gw.project, 'data', 'kin.db'))
    try {
      db.exec("UPDATE thinking_signature_owners SET account_id = 'another-account'")
      await forward('account-mismatch', body(initial.json.content))
      db.exec('DELETE FROM thinking_signature_owners')
      // 旧版记录不是本地准入条件。
      const signature = signed[0].signature
      const legacyKey = createHash('sha256')
        .update(`${signature.length}:${signature.slice(0, 100)}${signature.slice(-100)}`)
        .digest('hex')
        .slice(0, 32)
      db.prepare('INSERT INTO thinking_signature_owners VALUES (?, ?, ?)').run(legacyKey, 'acct-seed', Date.now())
      await forward('legacy-record-does-not-block', body(initial.json.content))
      db.exec('ALTER TABLE thinking_signature_owners RENAME TO unavailable_owners')
      db.exec('CREATE TABLE thinking_signature_owners (unavailable TEXT)')
      await forward('store-unavailable', body(initial.json.content))
    } finally {
      db.close()
    }
    for (const [persona, inference] of [
      ['official_full', 'http'],
      ['official_full', 'cli-hop'],
      ['native_server', 'http'],
    ]) {
      const current = (await api(gw, 'GET', '/api/panel/routing')).json.data
      const saved = await api(gw, 'PUT', '/api/panel/routing', {
        body: {
          ...current,
          compatibility: { ...current.compatibility, persona_preset: persona },
          official_cc: { ...current.official_cc, inference },
        },
      })
      assert.equal(saved.status, 200, saved.text)
      for (const stream of [false, true]) {
        await forward(`path-${persona}-${inference}-${stream}`, body(initial.json.content, stream))
      }
    }
    await gw.stop()
    gw = await startGateway({
      project,
      scenario: 'invalid_thinking_signature',
      env: { KIN_KERNEL_BIN: process.execPath },
    })
    for (const stream of [false, true]) {
      await forward(`upstream-rejection-no-repair-${stream}`, body(initial.json.content, stream), 400)
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
