import { getDb } from '../database.mjs'

const FIELDS = [
  'id',
  'created_at',
  'request_id',
  'provider',
  'config_id',
  'config_revision',
  'requested_model',
  'response_model',
  'result',
  'action',
  'safety_threshold',
  'block_if_below',
  'reason',
  'categories',
  'cache_hit',
  'source_review_id',
  'duration_ms',
  'attempt_count',
  'input_tokens',
  'output_tokens',
  'estimated_cost_nano_usd',
  'known_cost_nano_usd',
  'unknown_cost_attempts',
]
const decode = (row) =>
  row ? { ...row, categories: JSON.parse(row.categories), cache_hit: Boolean(row.cache_hit) } : null
const ID = /^[a-f0-9-]{36}$/
export class ModerationReviewsRepo {
  constructor(db = getDb()) {
    this.db = db
    this.nextPruneAt = 0
  }
  record(event) {
    this.db
      .prepare(`INSERT INTO moderation_reviews (${FIELDS.join(',')}) VALUES (${FIELDS.map(() => '?').join(',')})`)
      .run(...FIELDS.map((field) => event[field]))
    const now = Date.now()
    if (now < this.nextPruneAt) return
    this.nextPruneAt = now + 60000
    this.db
      .prepare(
        'DELETE FROM moderation_reviews WHERE id IN (SELECT id FROM moderation_reviews WHERE created_at < ? ORDER BY created_at,id LIMIT 500)',
      )
      .run(new Date(Date.now() - 30 * 86400000).toISOString())
  }
  list({ limit = 50, provider = '', model = '', result = '', cursor_created_at = '', cursor_id = '' } = {}) {
    const conditions = [],
      args = []
    for (const [column, value] of [
      ['provider', provider],
      ['requested_model', model],
      ['result', result],
    ]) {
      if (!value) continue
      if (typeof value !== 'string' || value.length > 120 || !/^[a-zA-Z0-9_.:/-]+$/.test(value))
        throw new TypeError('筛选值无效')
      if (column === 'result' && !['pass', 'block', 'unavailable', 'skipped'].includes(value))
        throw new TypeError('结果无效')
      conditions.push(`${column}=?`)
      args.push(value)
    }
    const filterWhere = conditions.length ? `WHERE ${conditions.join(' AND ')}` : ''
    const totals = this.db
      .prepare(`SELECT provider,requested_model,COUNT(*) AS reviews,
      SUM(cache_hit) AS cache_hits,SUM(attempt_count) AS attempts,
      SUM(COALESCE(known_cost_nano_usd,0)) AS known_cost_nano_usd,
      SUM(CASE WHEN estimated_cost_nano_usd IS NULL THEN 1 ELSE 0 END) AS unknown_cost_reviews
      FROM moderation_reviews ${filterWhere} GROUP BY provider,requested_model`)
      .all(...args)
    if (cursor_created_at || cursor_id) {
      if (
        !ID.test(cursor_id) ||
        !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(cursor_created_at) ||
        !Number.isFinite(Date.parse(cursor_created_at))
      )
        throw new TypeError('游标无效')
      conditions.push('(created_at,id) < (?,?)')
      args.push(cursor_created_at, cursor_id)
    }
    const size = Math.min(100, Math.max(1, Math.trunc(Number(limit) || 50)))
    const rows = this.db
      .prepare(
        `SELECT * FROM moderation_reviews ${conditions.length ? `WHERE ${conditions.join(' AND ')}` : ''} ORDER BY created_at DESC,id DESC LIMIT ?`,
      )
      .all(...args, size + 1)
    const more = rows.length > size
    if (more) rows.pop()
    const last = rows.at(-1)
    return {
      rows: rows.map(decode),
      totals,
      has_more: more,
      next_cursor: more && last ? { created_at: last.created_at, id: last.id } : null,
      detail_retention_days: 30,
    }
  }
  detail(id) {
    if (!ID.test(id)) throw new TypeError('审查 ID 无效')
    const review = decode(this.db.prepare('SELECT * FROM moderation_reviews WHERE id=?').get(id))
    if (!review) return null
    const attempts = this.db.prepare('SELECT * FROM jev_usage_events WHERE review_id=? ORDER BY created_at,id').all(id)
    return { review, attempts }
  }
}
