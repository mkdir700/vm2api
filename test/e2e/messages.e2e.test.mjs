import test from 'node:test'
import assert from 'node:assert/strict'
import { startGateway, api, readTrace } from '../harness.mjs'

const MODEL = 'claude-haiku-4-5-20251001'

// Cache-breakpoint injection promotes the last (and second-to-last user) turn's
// bare-string content into a [{ type:'text', text, cache_control }] block so the
// marker has somewhere to live. History stays native and in order — this reads
// the text back out regardless of which shape a given turn ended up in.
const msgText = (m) => {
  const c = m?.content
  if (typeof c === 'string') return c
  if (Array.isArray(c)) return c.map((b) => (typeof b === 'string' ? b : (b?.text ?? ''))).join('')
  return ''
}

test('POST /v1/messages non-stream returns mock text', async () => {
  const gw = await startGateway({ scenario: 'text', mockText: 'pong' })
  try {
    const r = await api(gw, 'POST', '/v1/messages', {
      body: {
        model: MODEL,
        max_tokens: 64,
        messages: [{ role: 'user', content: 'ping' }],
      },
    })
    assert.equal(r.status, 200, r.text)
    assert.equal(r.json.type, 'message')
    const text = (r.json.content || [])
      .filter((b) => b.type === 'text')
      .map((b) => b.text)
      .join('')
    assert.match(text, /pong/)
    const tr = readTrace(gw)
    assert.equal(tr.body.stream, true)
    assert.notEqual(r.headers.get('content-type'), 'text/event-stream')
  } finally {
    await gw.stop()
  }
})

test('POST /v1/messages stream emits SSE event+data', async () => {
  const gw = await startGateway({ scenario: 'text', mockText: 'pong' })
  try {
    const res = await fetch(gw.baseUrl + '/v1/messages', {
      method: 'POST',
      headers: {
        authorization: `Bearer ${gw.apiKey}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model: MODEL,
        stream: true,
        max_tokens: 32,
        messages: [{ role: 'user', content: 'ping' }],
      }),
    })
    assert.equal(res.status, 200)
    const body = await res.text()
    assert.match(body, /event:/)
    assert.match(body, /data:/)
    assert.match(body, /pong|text_delta|message_stop/)
  } finally {
    await gw.stop()
  }
})

test('tools → tool_use stop, name prefix stripped', async () => {
  const gw = await startGateway({ scenario: 'tool_use' })
  try {
    const r = await api(gw, 'POST', '/v1/messages', {
      body: {
        model: MODEL,
        max_tokens: 64,
        tools: [
          {
            name: 'read_file',
            description: 'read',
            input_schema: { type: 'object', properties: { path: { type: 'string' } } },
          },
        ],
        messages: [{ role: 'user', content: 'read /tmp/x' }],
      },
    })
    assert.equal(r.status, 200, r.text)
    assert.equal(r.json.stop_reason, 'tool_use')
    const tu = (r.json.content || []).find((b) => b.type === 'tool_use')
    assert.ok(tu)
    assert.equal(tu.name, 'read_file')
    assert.doesNotMatch(tu.name, /mcp__/)
  } finally {
    await gw.stop()
  }
})

test('legacy x-kin-forward: cli cannot re-enable CLI execution', async () => {
  const gw = await startGateway({ scenario: 'text' })
  try {
    await api(gw, 'POST', '/v1/messages', {
      headers: { 'x-kin-forward': 'cli' },
      body: { model: MODEL, max_tokens: 16, messages: [{ role: 'user', content: 'hi' }] },
    })
    const tr = readTrace(gw)
    assert.ok(tr, 'mock trace written')
    assert.equal(tr.via, 'go-worker')
    assert.equal(tr.argv, undefined)
    assert.match(String(tr.body.model || ''), /^claude-haiku-4-5/)
  } finally {
    await gw.stop()
  }
})

test('HTTP worker preserves thinking, sampling and max_tokens', async () => {
  const gw = await startGateway({ scenario: 'thinking' })
  try {
    const r = await api(gw, 'POST', '/v1/messages', {
      headers: { 'x-kin-forward': 'cli' },
      body: {
        model: MODEL,
        max_tokens: 99,
        temperature: 0.2,
        thinking: { type: 'enabled', budget_tokens: 1234 },
        messages: [{ role: 'user', content: 'think' }],
      },
    })
    assert.equal(r.status, 200, r.text)
    const tr = readTrace(gw)
    assert.deepEqual(tr.body.thinking, { type: 'enabled', budget_tokens: 1234, display: 'omitted' })
    assert.equal(tr.body.max_tokens, 99)
    assert.equal(tr.body.temperature, 1)
  } finally {
    await gw.stop()
  }
})

test('multi-turn Messages remain native and unflattened', async () => {
  const gw = await startGateway({ scenario: 'text' })
  try {
    await api(gw, 'POST', '/v1/messages', {
      headers: { 'x-kin-forward': 'cli' },
      body: {
        model: MODEL,
        max_tokens: 16,
        messages: [
          { role: 'user', content: 'first question' },
          { role: 'assistant', content: 'first answer' },
          { role: 'user', content: 'second question' },
        ],
      },
    })
    const tr = readTrace(gw)
    const dialogue = tr.body.messages.filter((message) => message.role !== 'system')
    assert.equal(dialogue.length, 3)
    assert.ok(msgText(dialogue[0]).endsWith('first question'))
    assert.equal(msgText(dialogue[1]), 'first answer')
    assert.ok(msgText(dialogue[2]).endsWith('second question'))
  } finally {
    await gw.stop()
  }
})

test('image block reaches Go relay envelope as Anthropic image', async () => {
  const gw = await startGateway({ scenario: 'text' })
  try {
    await api(gw, 'POST', '/v1/messages', {
      headers: { 'x-kin-forward': 'cli' },
      body: {
        model: MODEL,
        max_tokens: 16,
        messages: [
          {
            role: 'user',
            content: [
              { type: 'text', text: 'see' },
              { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAAA' } },
            ],
          },
        ],
      },
    })
    const tr = readTrace(gw)
    const image = tr.body.messages[0].content.find((block) => block?.type === 'image')
    assert.equal(image?.source?.media_type, 'image/png')
  } finally {
    await gw.stop()
  }
})

test('HTTP path preserves long system without CLI argv truncation', async () => {
  const gw = await startGateway({ scenario: 'text' })
  try {
    const sys = 'S'.repeat(30000)
    await api(gw, 'POST', '/v1/messages', {
      headers: { 'x-kin-forward': 'cli' },
      body: {
        model: MODEL,
        max_tokens: 8,
        system: sys,
        messages: [{ role: 'user', content: 'x' }],
      },
    })
    const tr = readTrace(gw)
    // Every model keeps environment instructions at their message boundary.
    assert.equal(tr.body.system.length, 4)
    assert.equal(tr.body.messages[0].role, 'user')
    assert.equal(tr.body.messages.length, 2)
    assert.equal(tr.body.messages[1].role, 'system')
    assert.match(msgText(tr.body.messages[1]), /# Environment/)
    assert.ok(!String(tr.body.system[2].text || '').includes(sys))
    assert.ok(!String(tr.body.system[3].text || '').includes(sys))
    assert.equal(tr.body.system.at(-1).text, sys)
    assert.ok(msgText(tr.body.messages[0]).endsWith('x'))
    assert.equal(tr.argv, undefined)
  } finally {
    await gw.stop()
  }
})
