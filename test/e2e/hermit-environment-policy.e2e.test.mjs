import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { startGateway, api, readTrace } from '../harness.mjs'

// Failure inventory: the page switch does not change the outbound envelope;
// caller macOS facts disappear; disabling injection removes caller instructions;
// Hermit re-injects Linux after consuming these gateway-owned envelopes.
// Export the real HTTP gateway envelopes for the pinned CLI E2E consumer.
test('system page environment policy owns the envelopes consumed by Hermit', async () => {
  const out = process.env.HERMIT_ENV_POLICY_OUT || fs.mkdtempSync(path.join(os.tmpdir(), 'hermit-env-policy-'))
  fs.mkdirSync(out, { recursive: true })
  const gw = await startGateway({ env: { KIN_KERNEL_BIN: process.execPath, KIN_AUTO_SYNC_WRAP: '0' } })
  const checks = [],
    envelopes = []
  try {
    const settings = await api(gw, 'GET', '/api/panel/routing')
    assert.equal(settings.status, 200)
    const routing = settings.json.data
    for (const enabled of [true, false]) {
      const compat = {
        ...routing.compatibility,
        official_cc_passthrough: false,
        persona_preset: 'zero',
        tool_name_rewrite: false,
        persona_env_presets: { zero: enabled },
        persona_templates: {
          zero: [
            { id: 'harness', type: 'text', text: 'SYNTHETIC_GATEWAY_POLICY_SYSTEM' },
            { id: 'caller_system', type: 'text', text: '{{caller_system}}' },
            { id: 'env', type: 'text', role: 'system', text: 'SYNTHETIC_GATEWAY_ENV_ENABLED\n{{env_303}}' },
          ],
        },
      }
      const saved = await api(gw, 'PUT', '/api/panel/routing', { body: { ...routing, compatibility: compat } })
      assert.equal(saved.status, 200, saved.text)
      const response = await api(gw, 'POST', '/v1/messages', {
        body: {
          model: 'claude-sonnet-5-5',
          max_tokens: 64,
          system:
            'SYNTHETIC_CALLER_INSTRUCTION\n# Environment\nYou have been invoked in the following environment: \n - Primary working directory: /Users/synthetic/project\n - Is a git repository: true\n - Platform: darwin\n - Shell: zsh\n - OS Version: Darwin SYNTHETIC',
          tools: [
            {
              name: 'Bash',
              description: 'Synthetic Bash',
              eager_input_streaming: true,
              input_schema: { type: 'object', properties: { label: { type: 'string' } } },
            },
          ],
          messages: [
            { role: 'user', content: 'SYNTHETIC_PRIOR_REQUEST' },
            {
              role: 'assistant',
              content: [{ type: 'tool_use', id: 'caller_env_bash', name: 'Bash', input: { label: 'SYNTHETIC_CWD' } }],
            },
            {
              role: 'user',
              content: [
                { type: 'tool_result', tool_use_id: 'caller_env_bash', content: '/Users/synthetic/project\nDarwin' },
              ],
            },
          ],
        },
      })
      assert.equal(response.status, 200, response.text)
      const body = readTrace(gw)?.body
      assert.ok(body)
      const wire = JSON.stringify(body)
      assert.equal(wire.includes('SYNTHETIC_GATEWAY_ENV_ENABLED'), enabled)
      assert.ok(wire.includes('SYNTHETIC_CALLER_INSTRUCTION'))
      assert.ok(wire.includes('/Users/synthetic/project') && wire.includes('darwin'))
      envelopes.push({ enabled, body })
      checks.push({ enabled, result: 'PASS' })
    }
    fs.writeFileSync(path.join(out, 'gateway-envelopes.json'), JSON.stringify(envelopes, null, 2))
    fs.writeFileSync(path.join(out, 'summary.json'), JSON.stringify({ result: 'PASS', checks }, null, 2))
  } catch (error) {
    fs.writeFileSync(
      path.join(out, 'summary.json'),
      JSON.stringify({ result: 'FAIL', checks, error: error.message }, null, 2),
    )
    throw error
  } finally {
    await gw.stop()
    console.log('gateway environment policy evidence: ' + out)
  }
})
