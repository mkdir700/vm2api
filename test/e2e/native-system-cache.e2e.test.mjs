import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { startGateway, seedVm, api, readTrace, REPO_ROOT } from '../harness.mjs'

// Failure inventory is written before the fix in docs/operations/native-system-cache-e2e.md.
// The transport is synthetic; this suite proves HTTP policy, not provider cache hits.
test('native cache prefix survives growing system context across model and transport boundaries', {
  timeout: 120000,
}, async () => {
  const out = path.resolve(process.env.NATIVE_SYSTEM_CACHE_OUT || `.tmp/native-system-cache-${Date.now()}`)
  fs.mkdirSync(out, { recursive: true })
  const checks = []
  const failures = []
  const check = (name, ok) => {
    checks.push({ name, result: ok ? 'PASS' : 'FAIL' })
    if (!ok) failures.push(name)
  }
  const sources = [
    'src/lib/protocol/anthropic-policy.mjs',
    'src/lib/transport/go-worker-client.mjs',
    'src/lib/protocol/handle-protocol.mjs',
    'src/lib/protocol/outbound-attempt.mjs',
    'src/lib/protocol/claude-code-betas.mjs',
    'src/lib/identity/crs-persona.mjs',
    'src/lib/identity/official-303.mjs',
    'test/e2e/native-system-cache.e2e.test.mjs',
  ]
  const sourceHashes = Object.fromEntries(
    sources.map((name) => [
      name,
      createHash('sha256')
        .update(fs.readFileSync(path.join(REPO_ROOT, name)))
        .digest('hex'),
    ]),
  )
  let error
  try {
    for (const [dataplane, preset] of ['hermit', 'wrap'].flatMap((transport) =>
      ['zero', 'official_full', 'official_303'].map((preset) => [transport, preset]),
    )) {
      const project = fs.mkdtempSync(path.join(os.tmpdir(), 'native-cache-http-'))
      const vm = seedVm({ project })
      vm.dataplane = dataplane
      vm.claude.account_tier = 'max'
      fs.writeFileSync(path.join(project, 'vms', `${vm.id}.json`), JSON.stringify(vm))
      let gw
      try {
        gw = await startGateway({ project, env: { KIN_KERNEL_BIN: process.execPath, KIN_RATE_CAP: '1000' } })
        const routing = (await api(gw, 'GET', '/api/panel/routing')).json.data
        await api(gw, 'PUT', '/api/panel/routing', {
          body: {
            ...routing,
            compatibility: {
              ...routing.compatibility,
              persona_preset: preset,
              official_cc_passthrough: true,
              tool_name_rewrite: false,
            },
          },
        })
        for (const model of [
          'claude-sonnet-4-5',
          'claude-sonnet-4-6',
          'claude-sonnet-5',
          'claude-sonnet-5-5',
          'claude-opus-4-6',
          'claude-opus-4-8',
          'claude-opus-5-5',
          'claude-fable-5-1',
          'claude-haiku-4-5',
          'claude-haiku-5-5',
        ]) {
          for (const ttl of ['5m', '1h']) {
            const current = (await api(gw, 'GET', '/api/panel/routing')).json.data
            const saved = await api(gw, 'PUT', '/api/panel/routing', {
              body: { ...current, compatibility: { ...current.compatibility, cache_ttl: ttl } },
            })
            check(`${dataplane}/${model}/${ttl}/setting`, saved.status === 200)
            const messages = [{ role: 'user', content: 'SYNTHETIC_INITIAL' }]
            let fixedSystem, fixedTools
            for (let round = 0; round < 3; round++) {
              if (round)
                messages.push(
                  { role: 'assistant', content: 'pong' },
                  { role: 'user', content: `SYNTHETIC_CONTINUE_${round}` },
                )
              messages.push({
                role: round === 2 ? 'developer' : 'system',
                content: [
                  {
                    type: 'text',
                    text: `SYNTHETIC_CONTEXT_${round}\n<system-reminder>\n<total_tokens>${9000 - round} tokens left</total_tokens>\n</system-reminder>`,
                    cache_control: { type: 'ephemeral', ttl },
                  },
                ],
              })
              const response = await api(gw, 'POST', '/v1/messages', {
                body: {
                  model,
                  max_tokens: 64,
                  stream: round === 1,
                  system: [{ type: 'text', text: 'SYNTHETIC_FIXED_INSTRUCTIONS' }],
                  tools: [{ name: 'Probe', input_schema: { type: 'object', properties: {} } }],
                  messages,
                },
              })
              const label = `${dataplane}/${preset}/${model}/${ttl}/${round}`
              check(label + '/http', response.status === 200)
              if (response.status !== 200) {
                throw new Error(`${label}: ${response.text}`)
              }
              const wire = readTrace(gw)?.body
              if (!wire) {
                check(label + '/dispatch', false)
                continue
              }
              const rows = wire.messages.filter(
                (m) =>
                  ['system', 'developer'].includes(m.role) && JSON.stringify(m.content).includes('SYNTHETIC_CONTEXT_'),
              )
              check(label + '/system_boundary', rows.length === round + 1)
              if (model === 'claude-sonnet-5' && ttl === '5m' && round === 0)
                fs.writeFileSync(path.join(out, `${dataplane}-${preset}-sample.json`), JSON.stringify(wire, null, 2))
              check(
                label + '/system_beta',
                readTrace(gw).headers['anthropic-beta']?.split(',').includes('mid-conversation-system-2026-04-07'),
              )
              if (round === 0) {
                fixedSystem = JSON.stringify(wire.system)
                fixedTools = JSON.stringify(wire.tools)
              }
              {
                check(label + '/fixed_system', JSON.stringify(wire.system) === fixedSystem)
                check(
                  label + '/context_order',
                  rows.every((row, i) => JSON.stringify(row.content).includes(`SYNTHETIC_CONTEXT_${i}`)),
                )
                check(
                  label + '/literal_context',
                  rows.every(
                    (row, i) =>
                      (typeof row.content === 'string'
                        ? row.content
                        : row.content.find((block) => block.text?.includes(`SYNTHETIC_CONTEXT_${i}`))?.text) ===
                      messages.filter((m) => ['system', 'developer'].includes(m.role))[i].content[0].text,
                  ),
                )
                check(
                  label + '/no_placeholder',
                  !JSON.stringify(wire.messages).includes('\\u200b') &&
                    !JSON.stringify(wire.messages).includes('\u200b'),
                )
              }
              const markers = []
              JSON.stringify(wire, (key, value) => {
                if (key === 'cache_control') markers.push(value)
                return value
              })
              check(label + '/cache_ttl', markers.length > 0 && markers.every((marker) => (marker.ttl || '5m') === ttl))
              check(label + '/fixed_tools', JSON.stringify(wire.tools) === fixedTools)
              check(label + '/history', wire.messages.filter((m) => m.role === 'assistant').length === round)
            }
          }
        }
      } finally {
        await gw?.stop()
        check(dataplane + '/gateway_stopped', !gw || gw.child.exitCode != null || gw.child.signalCode != null)
        fs.rmSync(project, { recursive: true, force: true })
      }
    }
    assert.deepEqual(failures, [], failures.join('\n'))
  } catch (caught) {
    error = caught
  } finally {
    fs.writeFileSync(
      path.join(out, 'summary.json'),
      JSON.stringify(
        {
          result: error ? 'FAIL' : 'PASS',
          checks,
          error: error?.message,
          sourceHashes,
          real_provider: 'NOT RUN',
          real_native: 'NOT RUN',
        },
        null,
        2,
      ) + '\n',
    )
    console.log(`Native system cache evidence: ${out}`)
  }
  if (error) throw error
})
