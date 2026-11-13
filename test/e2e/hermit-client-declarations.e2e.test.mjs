import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { startGateway, seedVm, api, readTrace, REPO_ROOT } from '../harness.mjs'
import { claudeCodeInboundHeaders } from '../../src/lib/protocol/claude-code-inbound.mjs'
import { writeWorkerCredentialFile } from '../../src/lib/oauth/oauth-credentials.mjs'

// Failure inventory: synthetic or inbound implementation headers reach Hermit;
// filtering drops protocol/session controls; streaming or API-key mode bypasses
// filtering; other dataplanes change; envelope evidence claims provider wire.
// Real HTTP gateway and scheduler, synthetic kernel transport. No paid provider.
test('Hermit delegates client implementation declarations to its bundled Claude Code', { timeout: 60000 }, async () => {
  const out = path.resolve(process.env.HERMIT_DECLARATIONS_OUT || '.tmp/hermit-client-declarations')
  fs.mkdirSync(out, { recursive: true })
  const checks = [],
    envelopes = [],
    failures = []
  let error
  const check = (name, ok) => {
    checks.push({ name, result: ok ? 'PASS' : 'FAIL' })
    if (!ok) failures.push(name)
  }
  const isDeclaration = (name) => /^(user-agent|x-app|x-stainless-.*)$/i.test(name)
  try {
    for (const dataplane of ['hermit', 'wrap']) {
      for (const mode of ['oauth', 'apikey']) {
        const project = fs.mkdtempSync(path.join(os.tmpdir(), 'client-decl-'))
        const vm = seedVm({ project })
        vm.dataplane = dataplane
        if (mode === 'apikey') {
          vm.claude.mode = 'apikey'
          writeWorkerCredentialFile(path.join(project, 'vms', vm.id, 'cli-home'), {
            type: 'apikey',
            api_key: 'sk-ant-api03-synthetic-declarations',
          })
        }
        fs.writeFileSync(path.join(project, 'vms', `${vm.id}.json`), JSON.stringify(vm))
        let gw
        try {
          gw = await startGateway({ project, env: { KIN_KERNEL_BIN: process.execPath, KIN_RATE_CAP: '1000' } })
          const routing = (await api(gw, 'GET', '/api/panel/routing')).json.data
          const saved = await api(gw, 'PUT', '/api/panel/routing', {
            body: {
              ...routing,
              compatibility: { ...routing.compatibility, persona_preset: 'zero', official_cc_passthrough: true },
            },
          })
          check(`${dataplane}/${mode}/settings`, saved.status === 200)
          for (const official of [false, true]) {
            for (const stream of [false, true]) {
              const label = `${dataplane}/${mode}/${official ? 'official' : 'harness'}/${stream ? 'sse' : 'json'}`
              const session = '10101010-1010-4010-8010-101010101010'
              const response = await api(gw, 'POST', '/v1/messages', {
                headers: {
                  ...(official
                    ? claudeCodeInboundHeaders({ sessionId: session })
                    : { 'user-agent': 'deepseek-harness/0.2.2-rc.2', 'x-claude-code-session-id': session }),
                  'x-app': 'caller-app',
                  'x-stainless-runtime-version': 'caller-runtime',
                  'x-stainless-custom': 'caller-extension',
                },
                body: {
                  model: 'claude-sonnet-5-5',
                  max_tokens: 64,
                  stream,
                  metadata: { user_id: JSON.stringify({ device_id: 'ab'.repeat(32), session_id: session }) },
                  messages: [{ role: 'user', content: 'SYNTHETIC_CLIENT_DECLARATIONS' }],
                },
              })
              check(label + '/http', response.status === 200)
              const envelope = readTrace(gw)
              check(label + '/dispatch', !!envelope)
              if (!envelope || response.status !== 200) {
                throw new Error(`${label}: ${response.status} ${response.text}`)
              }
              envelopes.push({ label, headers: envelope.headers, metadata: envelope.metadata })
              const declarations = Object.keys(envelope.headers).filter(isDeclaration)
              check(
                label + '/implementation_declarations',
                dataplane === 'hermit' ? declarations.length === 0 : declarations.includes('user-agent'),
              )
              check(label + '/protocol_version', envelope.headers['anthropic-version'] === '2023-06-01')
              check(
                label + '/protocol_betas',
                typeof envelope.headers['anthropic-beta'] === 'string' && envelope.headers['anthropic-beta'].length > 0,
              )
              const identity = JSON.parse(envelope.metadata.user_id)
              check(label + '/session_identity', !!identity.session_id)
              if (mode === 'oauth') {
                if (envelope.headers['x-claude-code-session-id'])
                  check(label + '/session_header', envelope.headers['x-claude-code-session-id'] === identity.session_id)
                if (dataplane === 'wrap') {
                  check(
                    label + '/legacy_version',
                    envelope.headers['user-agent'] === 'claude-cli/2.1.303 (external, sdk-cli)',
                  )
                  check(
                    label + '/legacy_sdk',
                    envelope.headers['x-stainless-runtime'] === 'node' && envelope.headers['x-app'] === 'cli',
                  )
                }
              }
            }
          }
        } finally {
          await gw?.stop()
          check(`${dataplane}/${mode}/gateway_stopped`, !gw || gw.child.exitCode != null || gw.child.signalCode != null)
          fs.rmSync(project, { recursive: true, force: true })
        }
      }
    }
    assert.deepEqual(failures, [], failures.join('\n'))
  } catch (caught) {
    error = caught
  } finally {
    const sources = ['src/lib/transport/go-worker-client.mjs', 'test/e2e/hermit-client-declarations.e2e.test.mjs']
    fs.writeFileSync(path.join(out, 'gateway-envelopes.json'), JSON.stringify(envelopes, null, 2) + '\n')
    fs.writeFileSync(
      path.join(out, 'summary.json'),
      JSON.stringify(
        {
          result: error ? 'FAIL' : 'PASS',
          checks,
          error: error?.message,
          source_sha256: Object.fromEntries(
            sources.map((name) => [
              name,
              createHash('sha256')
                .update(fs.readFileSync(path.join(REPO_ROOT, name)))
                .digest('hex'),
            ]),
          ),
          boundary: 'HTTP gateway to synthetic kernel transport',
          real_hermit_provider_wire: 'NOT RUN',
          production: 'NOT RUN',
        },
        null,
        2,
      ) + '\n',
    )
    console.log(`Hermit client declaration evidence: ${out}`)
  }
  if (error) throw error
})
