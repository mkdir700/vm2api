import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { startGateway, seedVm, api, readTrace } from '../harness.mjs'
import { claudeCodeInboundHeaders } from '../../src/lib/protocol/claude-code-inbound.mjs'
import { CRS_OFFICIAL_SYSTEM } from '../../src/lib/identity/crs-persona.mjs'
import { renderOfficial303Guidance } from '../../src/lib/identity/official-profiles.mjs'

// Failure inventory: docs/operations/native-server-environment-contract.md.
// Exercise settings and inference through real HTTP, with synthetic upstream.
test('native server policy extracts automatic context and preserves task and tool data', async () => {
  const out = path.resolve(
    process.env.NATIVE_SERVER_E2E_OUT || fs.mkdtempSync(path.join(os.tmpdir(), 'native-server-')),
  )
  fs.mkdirSync(out, { recursive: true })
  const project = fs.mkdtempSync(path.join(os.tmpdir(), 'native-server-gateway-'))
  const vm = seedVm({ project })
  vm.dataplane = 'hermit'
  fs.writeFileSync(path.join(project, 'vms', `${vm.id}.json`), JSON.stringify(vm))
  const checks = [],
    envelopes = []
  let gw, error
  const check = (name, ok) => {
    checks.push({ name, result: ok ? 'PASS' : 'FAIL' })
    assert.ok(ok, name)
  }
  const body = {
    model: 'claude-sonnet-5-5',
    max_tokens: 64,
    system:
      'APP_RULE_KEEP\n# Environment\nYou have been invoked in the following environment: \n - Primary working directory: /external/AUTO_CWD\n - Is a git repository: true\n - Platform: AUTO_PLATFORM\n - Shell: AUTO_SHELL\n - OS Version: AUTO_OS\n - Hostname: AUTO_HOST\n - Memory directory: /external/AUTO_MEMORY\n - Timezone: AUTO_TIMEZONE\n - Locale: AUTO_LOCALE\n - Current date: AUTO_DATE\n\nCUSTOM_RULE_KEEP',
    tools: [
      {
        name: 'Bash',
        description: 'External tool',
        input_schema: { type: 'object', properties: { cwd: { type: 'string' } } },
      },
    ],
    messages: [
      {
        role: 'user',
        content: [
          {
            type: 'text',
            text: '<system-reminder>\nThe current working directory is /external/AUTO_REMINDER_CWD\n</system-reminder>',
          },
          { type: 'text', text: '  TASK_KEEP: inspect /external/AUTO_CWD  ' },
          { type: 'text', text: '<system-reminder>APP_REMINDER_KEEP</system-reminder>' },
          {
            type: 'image',
            source: {
              type: 'base64',
              media_type: 'image/png',
              data: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=',
            },
          },
        ],
      },
      {
        role: 'assistant',
        content: [{ type: 'tool_use', id: 'outer_tool_1', name: 'Bash', input: { cwd: '/external/AUTO_CWD' } }],
      },
      {
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: 'outer_tool_1', content: '/external/AUTO_CWD\nAUTO_PLATFORM' }],
      },
    ],
  }
  body.system = [
    { type: 'text', text: body.system },
    { type: 'text', text: renderOfficial303Guidance({ cwd: '/external/AUTO_GUIDANCE_MEMORY' }) },
  ]
  try {
    gw = await startGateway({ project, env: { KIN_KERNEL_BIN: process.execPath, KIN_AUTO_SYNC_WRAP: '0' } })
    const routing = (await api(gw, 'GET', '/api/panel/routing')).json.data
    const saved = await api(gw, 'PUT', '/api/panel/routing', {
      body: {
        ...routing,
        compatibility: {
          ...routing.compatibility,
          persona_preset: 'native_server',
          official_cc_passthrough: true,
          tool_name_rewrite: false,
        },
      },
    })
    check('new_policy_accepted', saved.status === 200)
    const current = (await api(gw, 'GET', '/api/panel/routing')).json.data
    check('new_policy_roundtrip', current.compatibility.persona_preset === 'native_server')
    const response = await api(gw, 'POST', '/v1/messages', { body })
    fs.writeFileSync(path.join(out, 'initial-response.json'), JSON.stringify(response, null, 2))
    check('hermit_request_completed', response.status === 200)
    const wire = readTrace(gw)?.body
    check('policy_transmitted', wire?.hermit_environment_policy === 'native_server')
    check('automatic_system_context_removed', !JSON.stringify(wire.system).includes('AUTO_'))
    check(
      'application_instructions_preserved',
      JSON.stringify(wire.system).includes('APP_RULE_KEEP') && JSON.stringify(wire.system).includes('CUSTOM_RULE_KEEP'),
    )
    check('automatic_user_envelope_removed', !JSON.stringify(wire.messages).includes('AUTO_REMINDER_CWD'))
    check(
      'retained_blocks_exact',
      JSON.stringify(wire.messages[0].content) === JSON.stringify(body.messages[0].content.slice(1)),
    )
    check('tools_exact', JSON.stringify(wire.tools) === JSON.stringify(body.tools))
    check(
      'opaque_tool_history_exact',
      JSON.stringify(wire.messages.slice(1)) === JSON.stringify(body.messages.slice(1)),
    )
    envelopes.push({ name: 'initial', body: wire })
    // A native serializer owns its beta profile. The gateway must not lift
    // these system rows or insert a cache-only zero-width user placeholder.
    const update = {
      role: 'system',
      content: [
        {
          type: 'text',
          text: '# Environment update\n - Primary working directory: /external/next (was /external/AUTO_CWD)',
          cache_control: { type: 'ephemeral' },
        },
      ],
    }
    const controlled = { ...body, messages: [...body.messages, update] }
    const contextual = await api(gw, 'POST', '/v1/messages', { body: controlled })
    check('native_context_request_completed', contextual.status === 200)
    const contextualWire = readTrace(gw)?.body
    envelopes.push({ name: 'contextual', body: contextualWire })
    check(
      'native_system_turn_preserved',
      contextualWire.messages.at(-1).role === 'system' &&
        JSON.stringify(contextualWire.messages.at(-1).content).includes('/external/next'),
    )
    check(
      'native_context_does_not_change_fixed_system',
      JSON.stringify(contextualWire.system) === JSON.stringify(wire.system),
    )
    check(
      'native_no_zero_width_user_anchor',
      !contextualWire.messages.some(
        (message) =>
          message.role === 'user' &&
          Array.isArray(message.content) &&
          message.content.some((block) => block.type === 'text' && block.text === '\u200b'),
      ),
    )

    const official = await api(gw, 'POST', '/v1/messages', {
      headers: claudeCodeInboundHeaders({ sessionId: 'official-native-server' }),
      body: { ...body, system: [{ type: 'text', text: CRS_OFFICIAL_SYSTEM }, ...body.system] },
    })
    check('official_family_completed', official.status === 200)
    check(
      'official_family_cannot_bypass_policy',
      readTrace(gw)?.body?.hermit_environment_policy === 'native_server' &&
        !JSON.stringify(readTrace(gw).body.system).includes('AUTO_'),
    )
    // Slot override must beat the new global policy.
    const override = JSON.parse(fs.readFileSync(path.join(project, 'vms', `${vm.id}.json`)))
    override.persona_preset = 'zero'
    fs.writeFileSync(path.join(project, 'vms', `${vm.id}.json`), JSON.stringify(override))
    const old = await api(gw, 'POST', '/v1/messages', { body })
    check('existing_slot_policy_completed', old.status === 200)
    check('existing_slot_policy_no_native_marker', !readTrace(gw)?.body?.hermit_environment_policy)
    // Explicit policy must reject an unsupported route, never silently fall back.
    const record = JSON.parse(fs.readFileSync(path.join(project, 'vms', `${vm.id}.json`)))
    record.persona_preset = 'native_server'
    record.dataplane = 'wrap'
    fs.writeFileSync(path.join(project, 'vms', `${vm.id}.json`), JSON.stringify(record))
    const unsupported = await api(gw, 'POST', '/v1/messages', { body })
    check('non_hermit_policy_rejected', unsupported.status >= 400)
    record.dataplane = 'hermit'
    fs.writeFileSync(path.join(project, 'vms', `${vm.id}.json`), JSON.stringify(record))
    await gw.stop()
    fs.rmSync(gw.traceFile, { force: true })
    gw = await startGateway({
      project,
      scenario: 'native_server_unsupported',
      env: { KIN_KERNEL_BIN: process.execPath, KIN_AUTO_SYNC_WRAP: '0' },
    })
    const outdated = await api(gw, 'POST', '/v1/messages', { body })
    check('old_hermit_policy_rejected', outdated.status === 400)
    check('old_hermit_no_upstream_dispatch', !readTrace(gw))
  } catch (caught) {
    error = caught
  } finally {
    if (gw) await gw.stop()
    fs.writeFileSync(path.join(out, 'gateway-envelopes.json'), JSON.stringify(envelopes, null, 2))
    fs.writeFileSync(
      path.join(out, 'summary.json'),
      JSON.stringify(
        {
          result: error ? 'FAIL' : 'PASS',
          checks,
          error: error?.message,
          gateway_stopped: !gw || gw.child.exitCode != null || gw.child.signalCode != null,
          source_sha256: createHash('sha256')
            .update(fs.readFileSync(new URL(import.meta.url)))
            .digest('hex'),
          real_provider: 'NOT RUN',
          production: 'NOT RUN',
        },
        null,
        2,
      ),
    )
    console.log(`Native server evidence: ${out}`)
  }
  if (error) throw error
})
