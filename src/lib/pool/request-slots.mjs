import crypto from 'node:crypto'
import { getDb } from '../db/database.mjs'

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical)
  if (!value || typeof value !== 'object') return value
  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .map((key) => [key, canonical(value[key])]),
  )
}

const digest = (value) =>
  crypto
    .createHash('sha256')
    .update(JSON.stringify(canonical(value)))
    .digest('hex')

/** Fingerprint caller input before persona/session rendering, scoped to authentication. */
export function requestSlotIdentity(req, body, protocol) {
  const { stream, metadata, session_id, conversation_id, thread_id, request_id, trace_id, ...input } = body
  const scope = [
    req.apiKeyKind,
    req.apiKeyRecord?.id || 'master',
    req.apiKeyRecord?.user_id ?? null,
    req.apiKeyRecord?.group_id ?? 1,
    protocol,
    'native',
  ]
  return digest([scope, input])
}

export function requestSlotFailure(code, details = {}) {
  return {
    ok: false,
    status: 503,
    body: {
      error: {
        type: 'api_error',
        code,
        message:
          code === 'bound_slot_unavailable'
            ? '相同请求绑定的 slot 当前不可用。系统不会切换到其他 slot。'
            : '请求的 slot 绑定记录不可用。请稍后重试。',
        details: { ...details, retryable: true },
      },
    },
    attemptCount: 0,
    finalState: 'unavailable',
  }
}

/** Immutable slot affinity and conversation-specific generation state are distinct. */
export class RequestSlotStore {
  constructor() {
    this.boundDb = null
  }

  statements() {
    const db = getDb()
    if (db === this.boundDb) return this.sql
    this.sql = {
      get: db.prepare('SELECT * FROM request_slot_bindings WHERE request_key = ?'),
      claim: db.prepare('INSERT OR IGNORE INTO request_slot_bindings VALUES (?, ?, ?, ?, ?)'),
      cacheIdentity: db.prepare(`SELECT b.cache_session_id FROM request_slot_bindings b
        JOIN request_slot_executions e ON e.request_key = b.request_key
        WHERE e.context_key = ? ORDER BY e.updated_at DESC LIMIT 1`),
      state: db.prepare('SELECT * FROM request_slot_executions WHERE request_key = ? AND context_key = ?'),
      start: db.prepare(`INSERT INTO request_slot_executions VALUES (?, ?, ?, 'running', ?)
        ON CONFLICT(request_key, context_key) DO UPDATE SET session_id = excluded.session_id,
          state = 'running', updated_at = excluded.updated_at`),
      finish: db.prepare(
        'UPDATE request_slot_executions SET state = ?, updated_at = ? WHERE request_key = ? AND context_key = ?',
      ),
      completeTools: db.prepare(`UPDATE request_slot_executions SET state = 'complete', updated_at = ?
        WHERE state IN ('waiting_tools', 'uncertain') AND session_id = ? AND request_key IN
          (SELECT request_key FROM request_slot_bindings WHERE vm_id = ? AND account_id = ?)`),
    }
    this.boundDb = db
    return this.sql
  }

  get(key) {
    return this.statements().get.get(key) || null
  }
  claim(key, selected, context) {
    const sql = this.statements()
    const cacheIdentity = sql.cacheIdentity.get(context)?.cache_session_id || crypto.randomUUID()
    sql.claim.run(key, selected.vmId, selected.accountId, cacheIdentity, Date.now())
    return sql.get.get(key)
  }
  state(key, context) {
    return this.statements().state.get(key, context) || null
  }
  start(key, context, session) {
    try {
      this.statements().start.run(key, context, session, Date.now())
    } catch {
      throw Object.assign(
        new Error('Request execution state unavailable'),
        requestSlotFailure('request_slot_store_unavailable'),
      )
    }
  }
  finish(key, context, result) {
    const sql = this.statements(),
      now = Date.now()
    const verified = result.ok && result.finalState === 'verified'
    const tools = (result.body?.stop_reason || result.stopReason) === 'tool_use'
    const state = verified ? (tools ? 'waiting_tools' : 'complete') : 'uncertain'
    sql.finish.run(state, now, key, context)
    if (state === 'complete') {
      const execution = sql.state.get(key, context)
      sql.completeTools.run(now, execution.session_id, result.vmId, result.accountId)
    }
  }
}

export const requestSlots = new RequestSlotStore()
export const executionContextKey = (value) => digest(value || 'stateless')
