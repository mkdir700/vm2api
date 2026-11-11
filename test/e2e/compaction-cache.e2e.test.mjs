import assert from 'node:assert/strict'
import fs from 'node:fs'
import test from 'node:test'
import { api, readTrace, startGateway } from '../harness.mjs'

const fixture = JSON.parse(fs.readFileSync(new URL('../fixtures/claude-compaction-2.1.319.json', import.meta.url)))
const ua = 'claude-cli/2.1.319 (external, cli)'
const { template, customTail, retryTail, manual, autoHistory, lookalikeHistory, post, marker } = fixture
const text = (value, cache = false) => ({ type: 'text', text: value, ...(cache ? { cache_control: marker } : {}) })
const user = (content) => ({ role: 'user', content })
const hasMarker = (body) =>
  [body, ...body.system, ...(body.tools || []), ...body.messages.flatMap((m) => m.content)].some(
    (block) => block?.cache_control != null,
  )

test('only compact requests reach the worker without cache controls', async () => {
  const gateway = await startGateway({ scenario: 'text', env: { KIN_KERNEL_BIN: process.execPath } })
  try {
    const requests = [
      ['manual', [...manual.messages, user(template)], false],
      ['manual 2.1.318', [...manual.messages, user(template)], false, ua.replace('2.1.319', '2.1.318')],
      ['retry', [...manual.messages, user(template + retryTail)], false],
      ['custom', [...manual.messages, user(template.replace('REMINDER:', customTail + 'REMINDER:'))], false],
      ['auto', [...autoHistory, user([text('Synthetic previous turn.'), text(template)])], false, ua, {}, true],
      ['identical user text', [...lookalikeHistory, user([text(template, true)])], true],
      ['post-compaction', post.messages, true],
      ['post-compaction hint', post.messages, true, ua, { 'x-claude-code-context-compacted': 'manual' }],
      ['private header on ordinary turn', post.messages, true, ua, { 'x-hermit-no-prompt-cache': '1' }],
      ['explicit compaction hint', post.messages, false, ua, { 'x-claude-code-request-class': 'compaction' }],
      ['unknown client version', [...manual.messages, user(template)], true, ua.replace('2.1.319', '2.1.999')],
    ]
    const checks = []
    for (const [name, messages, expectedCache, userAgent = ua, hints = {}, stream = false] of requests) {
      const reply = await api(gateway, 'POST', '/v1/messages', {
        headers: { 'user-agent': userAgent, ...hints },
        body: {
          ...manual,
          stream,
          messages,
          cache_control: marker,
          tools: [
            {
              name: 'fixture',
              description: 'Synthetic tool',
              cache_control: marker,
              input_schema: { type: 'object', properties: { cache_control: { type: 'string' } } },
            },
          ],
        },
      })
      assert.equal(reply.status, 200, name + ': ' + reply.text)
      const sent = readTrace(gateway).body
      assert.equal(hasMarker(sent), expectedCache, name)
      assert.equal(
        sent.tools.find((tool) => tool.name.endsWith('fixture')).input_schema.properties.cache_control.type,
        'string',
      )
      checks.push({ name, cache_controls_present: expectedCache, status: reply.status })
    }
    if (process.env.COMPACTION_E2E_REPORT) {
      fs.writeFileSync(process.env.COMPACTION_E2E_REPORT, JSON.stringify({ result: 'PASS', checks }, null, 2) + '\n')
    }
  } finally {
    await gateway.stop()
  }
})
