import fs from 'node:fs'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { ApiKeyStore } from '../admin/api-keys.mjs'
import { readSecret, equal, verify, digest, readJson, send, failure } from './protocol.mjs'

export class RolloutGroup {
  constructor(project, db) {
    this.id = process.env.KIN_ROLLOUT_GROUP
    this.instance = process.env.KIN_ROLLOUT_INSTANCE
    if (!/^[a-zA-Z0-9_-]{1,64}$/.test(this.id || '') || !/^[a-zA-Z0-9_.-]{1,100}$/.test(this.instance || ''))
      throw failure('group_identity_required', 500)
    this.secret = readSecret(process.env.KIN_ROLLOUT_SECRET_FILE)
    this.authority = new DatabaseSync(process.env.KIN_ROLLOUT_AUTHORITY_DB, { readOnly: true })
    this.keys = new ApiKeyStore({ db: this.authority })
    // 准入与计费仅由网关执行。业务组使用只读权威身份与权限。
    this.keys.acquire = () => ({ ok: true })
    this.keys.release = () => {}
    this.keys.recordUsage = () => null
    this.keys.rebind = () => {} // 组内备份恢复不更换只读身份权威。
    this.db = db
    db.exec('CREATE TABLE IF NOT EXISTS rollout_results(id TEXT PRIMARY KEY,state TEXT NOT NULL,report TEXT)')
    this.active = new Set()
    this.lock = path.join(project, 'data', 'rollout-owner.json')
    fs.mkdirSync(path.dirname(this.lock), { recursive: true })
    if (fs.existsSync(this.lock)) {
      const prior = fs.readFileSync(this.lock, 'utf8'),
        record = JSON.parse(prior)
      let alive = true
      try {
        process.kill(record.pid, 0)
      } catch (error) {
        if (error.code === 'ESRCH') alive = false
      }
      if (alive) throw failure('group_already_owned', 500)
      if (fs.readFileSync(this.lock, 'utf8') !== prior) throw failure('group_owner_changed', 500)
      fs.unlinkSync(this.lock)
    }
    this.owner = JSON.stringify({ pid: process.pid, group: this.id, instance: this.instance })
    fs.writeFileSync(this.lock, this.owner, { flag: 'wx', mode: 0o600 })
  }
  async accept(req, res) {
    const claim = verify(this.secret, req.headers['x-kin-rollout-admission'])
    if (
      claim.group !== this.id ||
      claim.instance !== this.instance ||
      claim.method !== req.method ||
      claim.path !== req.url ||
      !/^[a-zA-Z0-9_-]{10,80}$/.test(claim.request_id || '')
    )
      throw failure('admission_target_mismatch', 401)
    const { raw, body } = req.method === 'GET' ? { raw: Buffer.alloc(0), body: {} } : await readJson(req)
    if (!equal(digest(raw), claim.body_sha256)) throw failure('admission_body_mismatch', 401)
    const key = claim.key_id ? this.keys.getById(claim.key_id) : null
    if (!claim.master && !key) throw failure('invalid_admission_identity', 401)
    try {
      this.db.prepare("INSERT INTO rollout_results(id,state) VALUES(?,'received')").run(claim.request_id)
    } catch {
      throw failure('request_already_received', 409)
    }
    req.rollout = claim
    req.rolloutBody = body
    req.presentedApiKey = claim.key_id || 'rollout-master'
    req.apiKeyKind = claim.master ? 'master' : 'managed'
    req.apiKeyRecord = key
    if (claim.master) {
      req.panelRole = 'admin'
      req.panelUser = 'master'
    }
    req.headers['x-request-id'] = claim.request_id
    delete req.headers['x-kin-rollout-admission']
    this.active.add(claim.request_id)
  }
  complete(req, res) {
    if (!req.rollout) return
    const bag = res._observabilityResult?.() || {}
    const helper = req.rollout.billable === false
    const unknown =
      ['transport_error', 'outcome_unknown', 'unknown', 'incomplete'].includes(bag.final_state) ||
      /unknown|incomplete/.test(bag.error_code || '') ||
      !res.writableFinished
    const success =
      res.statusCode === 200 &&
      !bag.error_code &&
      (helper || ['verified', 'complete', 'completed'].includes(bag.final_state))
    const outcome = unknown ? 'unknown' : success ? 'success' : res.statusCode >= 400 ? 'failure' : 'unknown'
    const usage = {}
    for (const key of [
      'input_tokens',
      'output_tokens',
      'cache_read_input_tokens',
      'cache_creation_input_tokens',
      'cache_read_tokens',
      'cache_creation_tokens',
      'cache_creation_5m_tokens',
      'cache_creation_1h_tokens',
      'web_search_requests',
    ]) {
      const value = Number(bag.usage?.[key])
      if (Number.isFinite(value) && value >= 0) usage[key] = value
    }
    if (bag.usage?.cache_creation && typeof bag.usage.cache_creation === 'object') {
      usage.cache_creation = {}
      for (const key of ['ephemeral_5m_input_tokens', 'ephemeral_1h_input_tokens']) {
        const value = Number(bag.usage.cache_creation[key])
        if (Number.isFinite(value) && value >= 0) usage.cache_creation[key] = value
      }
    }
    for (const key of ['service_tier', 'speed'])
      if (typeof bag.usage?.[key] === 'string')
        usage[key] = ['standard', 'fast', 'flex', 'priority', 'default', 'auto'].includes(bag.usage[key])
          ? bag.usage[key]
          : 'unknown'
    const report = {
      request_id: req.rollout.request_id,
      group: this.id,
      instance: this.instance,
      state: outcome === 'unknown' ? 'unknown' : 'completed',
      outcome,
      usage,
      model: String(bag.upstream_model || bag.model || '').slice(0, 256),
      official_cost:
        typeof bag.total_cost === 'number' && Number.isFinite(bag.total_cost) && bag.total_cost >= 0
          ? bag.total_cost
          : null,
    }
    this.db
      .prepare('UPDATE rollout_results SET state=?,report=? WHERE id=?')
      .run(report.state, JSON.stringify(report), report.request_id)
    this.active.delete(report.request_id)
  }
  async handle(req, res, getStatus) {
    if (!equal(req.headers.authorization, `Bearer ${this.secret}`)) throw failure('unauthorized', 401)
    if (req.method !== 'GET') throw failure('method_not_allowed', 405)
    if (req.url === '/_rollout/status') return send(res, 200, await getStatus())
    if (req.url.startsWith('/_rollout/results/')) {
      const row = this.db.prepare('SELECT state,report FROM rollout_results WHERE id=?').get(req.url.split('/').pop())
      return send(res, 200, row?.report ? JSON.parse(row.report) : { state: row?.state || 'unknown' })
    }
    throw failure('not_found', 404)
  }
  async status(vms, queued, health, exec) {
    // 暂停不代表工具会话已结束。所有保留的槽位都必须提供当前证明。
    const targets = vms.filter((vm) => vm.id && vm.status !== 'deleted')
    const probes = await Promise.all(
      targets.map(async (vm) => {
        try {
          return await health(exec(vm), { timeoutMs: 2000 })
        } catch {
          return null
        }
      }),
    )
    const eligible = targets.some(
      (vm) => vm.status === 'running' && vm.schedulable !== false && vm.schedule_off !== true && !vm.schedule_hold,
    )
    const valid =
      probes.length > 0 &&
      probes.every(
        (p) =>
          p?.healthy === true &&
          p?.runtime_flavor === 'hermit' &&
          p?.admission === 'accepting' &&
          p?.credential_stale !== true,
      )
    const certified =
      valid &&
      probes.every(
        (p) =>
          p.rollout_drain_schema === 1 &&
          Number.isInteger(p.active_requests) &&
          p.active_requests >= 0 &&
          Number.isInteger(p.queued_requests) &&
          p.queued_requests >= 0 &&
          Number.isInteger(p.pending_tool_results) &&
          p.pending_tool_results >= 0 &&
          typeof p.helper_active === 'boolean' &&
          p.recovering === false,
      )
    const pending = certified ? probes.reduce((n, p) => n + p.pending_tool_results, 0) : null
    const totalQueued = certified ? queued + probes.reduce((n, p) => n + p.queued_requests, 0) : null
    const active = this.active.size + (certified ? probes.reduce((n, p) => n + p.active_requests, 0) : 0)
    return {
      schema: 1,
      group: this.id,
      instance: this.instance,
      ready: valid && eligible,
      inventory: {
        accounts: [...new Set(targets.map((vm) => vm.claude?.account_uuid || vm.account_uuid || vm.id))].sort(),
      },
      active_requests: active,
      queued_requests: totalQueued,
      pending_tool_results: pending,
      helper_active: certified ? probes.some((p) => p.helper_active) : null,
      recovering: certified ? probes.some((p) => p.recovering) : null,
      switch_ready: certified && probes.every((p) => p.switch_ready === true) && !active && totalQueued === 0,
      ...(certified && probes.every((p) => p.session_restore_protocol === 'anthropic-full-history-v1')
        ? { session_restore_protocol: 'anthropic-full-history-v1' }
        : {}),
    }
  }
  close() {
    if (fs.existsSync(this.lock) && fs.readFileSync(this.lock, 'utf8') === this.owner) fs.unlinkSync(this.lock)
    this.authority.close()
  }
}
