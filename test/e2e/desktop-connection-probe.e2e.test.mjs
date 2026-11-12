import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { startGateway, api, readTrace } from '../harness.mjs'

// Failure inventory: probes forwarded when the switch is absent/off; account
// dependency; duplicate dispatch; nonzero usage/attempts; auth bypass; broad
// prompt interception; synthetic pinned diagnostics; changed strict admission.
const HEADERS = {
  'user-agent':
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Claude/5.1231.2 Chrome/156.0.8078.75 Electron/45.2.1 Safari/537.36 MSIX',
  'anthropic-version': '2023-06-01',
}
const PROBE = { model: 'claude-sonnet-5-5', max_tokens: 1, messages: [{ role: 'user', content: '.' }] }

test('Desktop sign-in probes stay local for every admission setting', async () => {
  const out = process.env.DESKTOP_PROBE_E2E_OUT || fs.mkdtempSync(path.join(os.tmpdir(), 'desktop-probe-e2e-'))
  fs.mkdirSync(out, { recursive: true })
  const checks = []
  const save = (name, value) => fs.writeFileSync(path.join(out, name), JSON.stringify(value, null, 2) + '\n')
  const root = fileURLToPath(new URL('../../', import.meta.url))
  save(
    'source-pins.json',
    Object.fromEntries(
      [
        'src/lib/protocol/handle-protocol.mjs',
        'src/lib/identity/claude-code-only.mjs',
        'test/e2e/desktop-connection-probe.e2e.test.mjs',
      ].map((name) => [
        name,
        crypto
          .createHash('sha256')
          .update(fs.readFileSync(path.join(root, name)))
          .digest('hex'),
      ]),
    ),
  )
  const startWithSetting = async (setting, oauth = true) => {
    const project = fs.mkdtempSync(path.join(os.tmpdir(), 'desktop-probe-gateway-'))
    const routing = JSON.parse(fs.readFileSync(path.join(root, 'src/config/routing.json'), 'utf8'))
    routing.compatibility ||= {}
    if (setting === 'absent') delete routing.compatibility.claude_code_only
    else routing.compatibility.claude_code_only = setting
    fs.mkdirSync(path.join(project, 'config'), { recursive: true })
    fs.writeFileSync(path.join(project, 'config/routing.json'), JSON.stringify(routing))
    return startGateway({
      project,
      oauth,
      scenario: 'completed_request_duplicate',
      env: { KIN_KERNEL_BIN: process.execPath, KIN_REQUEST_LOG_MODE: 'normal' },
    })
  }
  try {
    for (const setting of ['absent', false, true]) {
      const gw = await startWithSetting(setting, false)
      try {
        const created = await api(gw, 'POST', '/api/panel/api-keys', { body: { name: 'desktop-probe' } })
        assert.equal(created.status, 201, created.text)
        const key = created.json.item.key
        const ids = []
        for (const kind of ['master', 'managed']) {
          const headers = { ...HEADERS, ...(kind === 'managed' ? { authorization: 'Bearer ' + key } : {}) }
          for (const body of [PROBE, { ...PROBE, max_tokens: 16, stream: false }]) {
            for (let attempt = 0; attempt < 2; attempt++) {
              const response = await api(gw, 'POST', '/v1/messages', { headers, body })
              assert.equal(response.status, 200, response.text)
              assert.equal(response.json.content[0].text, 'OK')
              assert.equal(response.json.stop_reason, 'end_turn')
              assert.deepEqual(response.json.usage, { input_tokens: 0, output_tokens: 0 })
              ids.push(response.headers.get('x-request-id'))
            }
          }
        }
        assert.equal(new Set(ids).size, ids.length)
        assert.equal(readTrace(gw), null, 'probe must not reach the mock upstream')
        const logs = await api(gw, 'GET', '/api/panel/usage-logs?limit=100')
        assert.equal(logs.status, 200)
        const rows = logs.json.data.logs.filter((row) => ids.includes(row.requestId))
        save('probes-' + setting + '.json', rows)
        assert.equal(rows.length, ids.length)
        for (const row of rows) {
          assert.equal(row.attemptCount, 0)
          assert.equal(row.vmId, null)
          assert.equal(row.sessionId, null)
          assert.equal(row.via, 'desktop-connection-probe')
          assert.equal(row.inputTokens, 0)
          assert.equal(row.outputTokens, 0)
          assert.equal(row.costUsd, 0)
          assert.equal(row.actualCostUsd, 0)
        }
        const denied = await api(gw, 'POST', '/v1/messages', {
          headers: { ...HEADERS, authorization: 'Bearer invalid-probe-key' },
          body: PROBE,
        })
        assert.equal(denied.status, 401)
        checks.push({
          setting,
          result: 'PASS',
          repeatedProbes: ids.length,
          attempts: 0,
          modelCalls: 0,
          invalidAuthStatus: denied.status,
        })
      } finally {
        await gw.stop()
      }
    }
    const gw = await startWithSetting(false)
    try {
      const cases = [
        ['ordinary', { ...PROBE, messages: [{ role: 'user', content: 'hello' }] }, HEADERS],
        ['tokens', { ...PROBE, max_tokens: 2 }, HEADERS],
        ['stream', { ...PROBE, stream: true }, HEADERS],
        ['system', { ...PROBE, system: 'Synthetic ordinary context' }, HEADERS],
        ['metadata', { ...PROBE, metadata: { user_id: 'synthetic-context' } }, HEADERS],
        ['browser', PROBE, { ...HEADERS, 'user-agent': 'Mozilla/5.0 Chrome/156.0.0.0 Safari/537.36' }],
        ['pinned', PROBE, { ...HEADERS, 'x-kin-vm': 'vm-sim-01' }],
      ]
      for (const [name, body, headers] of cases) {
        const response = await api(gw, 'POST', '/v1/messages', { body, headers })
        save('boundary-' + name + '.json', { status: response.status, body: response.json })
        assert.equal(response.status, 400, name + ': ' + response.text)
        assert.equal(response.json.error.code, 'completed_request_duplicate', name)
        assert.ok(readTrace(gw), name + ' must reach the upstream')
        fs.unlinkSync(gw.traceFile)
        checks.push({ name, result: 'PASS', preservedUpstreamCode: response.json.error.code })
      }
      const strictConfig = await api(gw, 'PUT', '/api/panel/routing', {
        body: { compatibility: { claude_code_only: true } },
      })
      assert.equal(strictConfig.status, 200, strictConfig.text)
      const strict = await api(gw, 'POST', '/v1/messages', {
        headers: HEADERS,
        body: { ...PROBE, messages: [{ role: 'user', content: 'hello' }] },
      })
      assert.equal(strict.status, 403)
      assert.equal(strict.json.error.code, 'claude_code_only')
      assert.equal(readTrace(gw), null)
      checks.push({ name: 'strict-admission', result: 'PASS', status: strict.status })
    } finally {
      await gw.stop()
    }
    save('summary.json', {
      result: 'PASS',
      checks,
      command: 'node --test test/e2e/desktop-connection-probe.e2e.test.mjs',
      realProvider: 'NOT RUN',
    })
  } catch (error) {
    save('summary.json', { result: 'FAIL', checks, error: error.message })
    throw error
  } finally {
    console.log('Desktop probe evidence: ' + out)
  }
})
