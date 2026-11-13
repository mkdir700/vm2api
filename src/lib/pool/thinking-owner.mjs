/**
 * Record the exact thinking blocks returned by each account. Unknown,
 * modified, or differently owned blocks must never be repaired into text.
 */
import crypto from 'node:crypto'
import { getDb } from '../db/database.mjs'
import { ErrorCode, ErrorType, makeError } from '../core/errors.mjs'

const MIN_SIGNATURE = 24
const TTL_MS = 30 * 24 * 60 * 60 * 1000
const PURGE_EVERY_MS = 60 * 60 * 1000
const REFRESH_AFTER_MS = 24 * 60 * 60 * 1000

/** Stable key for one signed thinking block, or null when it carries no usable signature. */
export function thinkingSignatureKey(block) {
  const raw = block?.type === 'thinking' ? block.signature : block?.type === 'redacted_thinking' ? block.data : null
  if (typeof raw !== 'string' || raw.trim().length < MIN_SIGNATURE || raw === 'skip_thought_signature_validator')
    return null
  if (block.type === 'thinking' && typeof block.thinking !== 'string') return null
  // A signature-only fingerprint cannot detect modified thinking text. Use
  // the complete signed payload; old partial keys do not establish provenance.
  const material = block.type === 'thinking' ? [block.type, block.thinking, raw] : [block.type, raw]
  return 'v2:' + crypto.createHash('sha256').update(JSON.stringify(material)).digest('hex')
}

export class ThinkingOwnerStore {
  /** `db` pins a connection (tests); otherwise the process database, re-read so a restore rebinds. */
  constructor({ db = null, ttlMs = TTL_MS } = {}) {
    this.pinned = db
    this.ttlMs = ttlMs
    this.boundDb = null
    this.lastPurge = 0
  }

  statements() {
    let db
    try {
      db = this.pinned || getDb()
    } catch {
      return null
    }
    if (this.boundDb === db) return this.sql
    db.exec(`CREATE TABLE IF NOT EXISTS thinking_signature_owners (
      key TEXT PRIMARY KEY,
      account_id TEXT NOT NULL,
      created_at INTEGER NOT NULL
    )`)
    db.exec('CREATE INDEX IF NOT EXISTS idx_thinking_owner_created ON thinking_signature_owners(created_at)')
    this.sql = {
      owners: db.prepare(
        'SELECT key, account_id FROM thinking_signature_owners WHERE key IN (SELECT value FROM json_each(?))',
      ),
      refresh: db.prepare(
        'UPDATE thinking_signature_owners SET created_at = ? WHERE key IN (SELECT value FROM json_each(?)) AND created_at < ?',
      ),
      insert: db.prepare(
        'INSERT OR IGNORE INTO thinking_signature_owners (key, account_id, created_at) VALUES (?, ?, ?)',
      ),
      purge: db.prepare('DELETE FROM thinking_signature_owners WHERE created_at < ?'),
    }
    this.boundDb = db
    return this.sql
  }

  /**
   * key → account for the keys that have a record; null when no database is
   * reachable. Validation must reject rather than guess.
   */
  ownersOf(keys, now = Date.now()) {
    const sql = this.statements()
    if (!sql) return null
    const found = new Map()
    if (!keys.length) return found
    const list = JSON.stringify(keys)
    for (const row of sql.owners.all(list)) found.set(row.key, row.account_id)
    if (found.size) sql.refresh.run(now, list, now - REFRESH_AFTER_MS)
    return found
  }

  /** First writer wins: a signature belongs to the account that returned it. */
  record(keys, accountId, now = Date.now()) {
    const account = String(accountId || '')
    const sql = keys.length && account ? this.statements() : null
    if (!sql) return
    for (const key of keys) sql.insert.run(key, account, now)
    if (now - this.lastPurge >= PURGE_EVERY_MS) {
      this.lastPurge = now
      sql.purge.run(now - this.ttlMs)
    }
  }
}

export const thinkingOwners = new ThinkingOwnerStore()

function thinkingBlocks(body) {
  const blocks = []
  for (const [messageIndex, message] of (Array.isArray(body?.messages) ? body.messages : []).entries()) {
    if (!Array.isArray(message?.content)) continue
    for (const [blockIndex, block] of message.content.entries()) {
      if (
        block?.type === 'thinking' ||
        block?.type === 'redacted_thinking' ||
        (block && typeof block === 'object' && Object.hasOwn(block, 'thinking'))
      ) {
        blocks.push({ block, role: message.role, param: `messages.${messageIndex}.content.${blockIndex}` })
      }
    }
  }
  return blocks
}

function signatureError(param, unavailable = false) {
  const code = unavailable ? ErrorCode.THINKING_SIGNATURE_STORE_UNAVAILABLE : ErrorCode.INVALID_THINKING_SIGNATURE
  const message = unavailable
    ? '思考签名来源记录不可用。请稍后重试。'
    : '思考签名无效或来源无法确认。请使用当前账号返回的完整、未修改的思考块。'
  return Object.assign(
    new Error(message),
    makeError({
      type: unavailable ? ErrorType.API : ErrorType.INVALID_REQUEST,
      code,
      message,
      status: unavailable ? 503 : 400,
      param,
      details: { retryable: unavailable },
    }),
    { code },
  )
}

/** Validate caller input before normalization, then check ownership per attempt. */
export function validateThinkingHistory(body, { accountId = null, store = thinkingOwners } = {}) {
  const blocks = thinkingBlocks(body)
  if (!blocks.length) return 0
  const keys = blocks.map(({ block, role, param }) => {
    const key = role === 'assistant' ? thinkingSignatureKey(block) : null
    if (!key) throw signatureError(param)
    return key
  })
  let owners
  try {
    owners = store.ownersOf([...new Set(keys)])
  } catch {
    throw signatureError(blocks[0].param, true)
  }
  if (!owners) throw signatureError(blocks[0].param, true)
  for (const [index, key] of keys.entries()) {
    const owner = owners.get(key)
    if (!owner || (accountId != null && owner !== String(accountId))) throw signatureError(blocks[index].param)
  }
  return blocks.length
}

/** Keep verified thinking unchanged; fail closed instead of converting it. */
export function filterThinkingForAccount(body, accountId, store = thinkingOwners) {
  const kept = validateThinkingHistory(body, { accountId, store })
  return { body, kept, converted: 0, dropped: 0, unknown: 0 }
}

/** Bind the thinking blocks of a served response to the account that produced them. */
export function recordThinkingOwners(message, accountId, store = thinkingOwners) {
  const keys = []
  for (const block of Array.isArray(message?.content) ? message.content : []) {
    const key = thinkingSignatureKey(block)
    if (key) keys.push(key)
  }
  try {
    store.record(keys, accountId)
  } catch {}
  return keys.length
}
