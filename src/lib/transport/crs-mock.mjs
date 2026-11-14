/**
 * In-process Anthropic mock for e2e (KIN_CRS_MOCK=1).
 * Never touches the network or credential files.
 */
import fs from 'node:fs'
import path from 'node:path'

export function isCrsMock() {
  return process.env.KIN_CRS_MOCK === '1'
}

export function writeCrsTrace({ body, headers, stream = false }) {
  const dest = process.env.KIN_CRS_TRACE_FILE || process.env.KIN_MOCK_TRACE_FILE
  if (!dest) return
  try {
    fs.mkdirSync(path.dirname(dest), { recursive: true })
  } catch {}
  fs.writeFileSync(
    dest,
    JSON.stringify(
      {
        via: 'go-worker',
        stream: !!stream,
        body,
        headers: redact(headers),
        system: body?.system ?? null,
        thinking: body?.thinking ?? null,
        tools: (body?.tools || []).map((t) => t?.name).filter(Boolean),
        metadata: body?.metadata || null,
      },
      null,
      2,
    ),
  )
}

function redact(h = {}) {
  const out = { ...(h || {}) }
  if (out.authorization) out.authorization = 'Bearer <redacted>'
  delete out['x-api-key']
  return out
}

function message({ text, stop = 'end_turn', content = null }) {
  return {
    type: 'message',
    id: 'msg_crs_mock',
    role: 'assistant',
    model: process.env.KIN_MOCK_MODEL || 'claude-haiku-4-5-20251001',
    content: content || [{ type: 'text', text }],
    stop_reason: stop,
    usage: {
      input_tokens: 12,
      output_tokens: 4,
      cache_read_input_tokens: 3,
      cache_creation_input_tokens: 5,
      cache_creation: {
        ephemeral_5m_input_tokens: 5,
        ephemeral_1h_input_tokens: 0,
      },
    },
  }
}

export function mockCrsPayload(options = {}) {
  let scenario = options.scenario || process.env.KIN_MOCK_SCENARIO || 'text'
  if (scenario === 'tool_cycle') {
    scenario = options.body?.messages?.some(
      (message) => Array.isArray(message.content) && message.content.some((block) => block.type === 'tool_result'),
    )
      ? 'text'
      : 'tool_use'
  }
  const text = process.env.KIN_MOCK_TEXT || 'pong'
  if (scenario === 'invalid_thinking_signature') {
    return {
      ok: false,
      status: 400,
      via: 'go-worker',
      headers: {},
      body: { error: { type: 'invalid_request_error', message: 'Invalid signature in thinking block' } },
    }
  }
  if (scenario === 'signed_thinking') {
    return {
      ok: true,
      status: 200,
      via: 'go-worker',
      body: message({
        content: [
          { type: 'thinking', thinking: 'Synthetic signed reasoning.', signature: 'synthetic-signature-'.repeat(20) },
          { type: 'redacted_thinking', data: 'synthetic-redacted-'.repeat(20) },
          { type: 'text', text: 'PONG' },
        ],
      }),
      headers: {},
    }
  }
  if (scenario === 'completed_request_duplicate') {
    return {
      ok: false,
      status: 409,
      via: 'go-worker',
      transportError: false,
      headers: {},
      body: {
        type: 'error',
        error: {
          type: 'invalid_request_error',
          code: scenario,
          message:
            '请求与已完成请求重复。当前请求与本会话上一条已完成请求的内容相同。系统已拒绝重复执行。继续对话时，请提交包含上一轮回复和新消息的完整历史。重新生成时，请发起新会话。',
          details: { retryable: false },
        },
      },
    }
  }
  if (scenario === 'native_operation_unsupported') {
    return {
      ok: false,
      status: 501,
      via: 'go-worker',
      transportError: false,
      headers: {},
      body: {
        type: 'error',
        error: { type: 'worker_error', code: scenario, message: 'Cache override is not supported' },
      },
    }
  }
  if (
    [
      'native_preparation_failed',
      'native_control_unavailable',
      'native_generation_failed',
      'native_preparation_outcome_unknown',
      'native_resume_outcome_unknown',
      'native_tool_delivery_unknown',
    ].includes(scenario)
  ) {
    return {
      ok: false,
      status: ['native_resume_outcome_unknown', 'native_tool_delivery_unknown'].includes(scenario) ? 409 : 502,
      via: 'go-worker',
      transportError: false,
      body: {
        type: 'error',
        error: {
          type: ['native_resume_outcome_unknown', 'native_tool_delivery_unknown'].includes(scenario)
            ? 'invalid_request_error'
            : 'api_error',
          code: scenario,
          message: scenario,
          details: { retryable: false },
        },
      },
      headers: {},
    }
  }
  if (scenario === 'error') {
    return {
      ok: false,
      status: 500,
      via: 'go-worker',
      transportError: false,
      body: { type: 'error', error: { type: 'api_error', message: 'crs-mock simulated failure' } },
      headers: {},
    }
  }
  if (scenario === 'rate_limit') {
    return {
      ok: false,
      status: 429,
      via: 'go-worker',
      transportError: false,
      body: { type: 'error', error: { type: 'rate_limit_error', message: '5h account quota exhausted' } },
      headers: {
        'anthropic-ratelimit-unified-5h-status': 'rejected',
        'anthropic-ratelimit-unified-5h-reset': String(Date.now() + 60_000),
      },
    }
  }
  if (scenario === 'tool_use') {
    return {
      ok: true,
      status: 200,
      via: 'go-worker',
      body: message({
        text: '',
        stop: 'tool_use',
        content: [{ type: 'tool_use', id: 'toolu_mock1', name: 'read_file', input: { path: '/tmp/x' } }],
      }),
      headers: {},
    }
  }
  if (scenario === 'thinking') {
    return {
      ok: true,
      status: 200,
      via: 'go-worker',
      body: message({
        text: 'thoughtful-pong',
        content: [
          { type: 'thinking', thinking: 'hmm' },
          { type: 'text', text: 'thoughtful-pong' },
        ],
      }),
      headers: {},
    }
  }
  return {
    ok: true,
    status: 200,
    via: 'go-worker',
    body: message({ text }),
    headers: { 'anthropic-ratelimit-requests-remaining': '99' },
  }
}

export async function emitMockSse(onEvent, payload) {
  const delay = Number(process.env.KIN_MOCK_DELAY_MS || 0)
  if (delay > 0) await new Promise((resolve) => setTimeout(resolve, delay))
  const msg = payload.body
  const lines = []
  const push = (event, data) => {
    lines.push(`event: ${event}`)
    lines.push(`data: ${JSON.stringify(data)}`)
    lines.push('')
  }
  if (payload.ok) {
    push('message_start', { type: 'message_start', message: { ...msg, content: [], stop_reason: null } })
    const blocks = msg.content || []
    blocks.forEach((b, i) => {
      push('content_block_start', {
        type: 'content_block_start',
        index: i,
        content_block: { ...b, text: b.type === 'text' ? '' : b.text },
      })
      if (b.type === 'text') {
        push('content_block_delta', {
          type: 'content_block_delta',
          index: i,
          delta: { type: 'text_delta', text: b.text },
        })
      }
      push('content_block_stop', { type: 'content_block_stop', index: i })
    })
    push('message_delta', { type: 'message_delta', delta: { stop_reason: msg.stop_reason }, usage: msg.usage })
    push('message_stop', { type: 'message_stop' })
  } else {
    push('error', payload.body)
  }
  if (onEvent) {
    for (const line of lines) await onEvent(line)
  }
  return payload
}
