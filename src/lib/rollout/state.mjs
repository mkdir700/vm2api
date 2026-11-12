import crypto from 'node:crypto'
import { ApiKeyStore } from '../admin/api-keys.mjs'
import { GroupsRepo } from '../db/repos/groups-repo.mjs'
import { createDatabase } from '../db/database.mjs'
import { digest, failure } from './protocol.mjs'

export class RolloutState {
  constructor(directory) {
    this.db = createDatabase({ dataDir: directory })
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS rollout_groups (id TEXT PRIMARY KEY, spec TEXT NOT NULL, mode TEXT NOT NULL DEFAULT 'candidate');
      CREATE TABLE IF NOT EXISTS rollout_policy (id INTEGER PRIMARY KEY CHECK(id=1), generation INTEGER NOT NULL, target TEXT);
      INSERT OR IGNORE INTO rollout_policy VALUES(1,0,NULL);
      CREATE TABLE IF NOT EXISTS rollout_sessions (id TEXT PRIMARY KEY, principal TEXT NOT NULL, group_id TEXT NOT NULL, recovery TEXT NOT NULL, closed INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE IF NOT EXISTS rollout_requests (id TEXT PRIMARY KEY, session_id TEXT NOT NULL, principal TEXT NOT NULL, key_id TEXT, owner_id INTEGER, group_id TEXT NOT NULL, state TEXT NOT NULL, created_at INTEGER NOT NULL, report TEXT, billable INTEGER NOT NULL DEFAULT 1, ephemeral INTEGER NOT NULL DEFAULT 0);
      CREATE INDEX IF NOT EXISTS rollout_request_principal ON rollout_requests(principal,state,created_at);
    `)
    this.keys = new ApiKeyStore({ db: this.db })
    this.groupsRepo = new GroupsRepo(this.db)
  }
  transaction(fn) {
    this.db.exec('BEGIN IMMEDIATE')
    try {
      const value = fn()
      this.db.exec('COMMIT')
      return value
    } catch (error) {
      this.db.exec('ROLLBACK')
      throw error
    }
  }
  policy() {
    return this.db.prepare('SELECT generation,target FROM rollout_policy WHERE id=1').get()
  }
  groups() {
    return this.db
      .prepare('SELECT * FROM rollout_groups')
      .all()
      .map((r) => ({ ...JSON.parse(r.spec), mode: r.mode }))
  }
  group(id) {
    return this.groups().find((g) => g.id === id)
  }
  register(spec) {
    if (!/^[a-zA-Z0-9_-]{1,64}$/.test(spec.id || '') || !spec.instance || !spec.artifact)
      throw failure('invalid_group', 400)
    const url = new URL(spec.url)
    if (
      url.protocol !== 'http:' ||
      !['127.0.0.1', '[::1]'].includes(url.hostname) ||
      url.username ||
      url.password ||
      url.pathname !== '/' ||
      url.search ||
      url.hash
    )
      throw failure('loopback_backend_required', 400)
    const resources = spec.resources
    if (
      !resources ||
      !String(resources.root).startsWith('/') ||
      !Array.isArray(resources.accounts) ||
      !resources.accounts.length ||
      !Array.isArray(resources.containers) ||
      !resources.containers.length
    )
      throw failure('group_resources_required', 400)
    const selected = {
      id: spec.id,
      url: url.origin,
      instance: String(spec.instance),
      artifact: String(spec.artifact),
      resources,
    }
    return this.transaction(() => {
      const existing = this.group(spec.id)
      if (existing) {
        const { mode, ...previous } = existing
        if (JSON.stringify(previous) !== JSON.stringify(selected)) throw failure('immutable_group_identity')
        return existing
      }
      for (const group of this.groups()) {
        if (group.mode === 'retired') continue
        const other = group.resources
        if (
          group.url === selected.url ||
          group.instance === selected.instance ||
          resources.root === other.root ||
          resources.root.startsWith(other.root + '/') ||
          other.root.startsWith(resources.root + '/') ||
          resources.accounts.some((id) => other.accounts.includes(id)) ||
          resources.containers.some((id) => other.containers.includes(id))
        )
          throw failure('group_resource_conflict')
      }
      this.db.prepare('INSERT INTO rollout_groups(id,spec) VALUES(?,?)').run(selected.id, JSON.stringify(selected))
      return this.group(selected.id)
    })
  }
  promote(expected, target) {
    return this.transaction(() => {
      const policy = this.policy()
      if (policy.generation !== expected) throw failure('stale_policy')
      if (!this.group(target)) throw failure('group_not_found', 404)
      this.db.prepare("UPDATE rollout_groups SET mode='continuation' WHERE mode='accepting'").run()
      this.db.prepare("UPDATE rollout_groups SET mode='accepting' WHERE id=?").run(target)
      this.db.prepare('UPDATE rollout_policy SET generation=generation+1,target=? WHERE id=1').run(target)
      return this.policy()
    })
  }
  admit(principal, record, session, recovery, billable = true) {
    return this.transaction(() => {
      const current = record ? this.keys.getById(record.id) : null
      if (record) {
        const gate = this.keys.canAccept(current)
        if (!gate.ok) throw failure(gate.code, gate.status)
        const pending = Number(
          this.db
            .prepare("SELECT count(*) n FROM rollout_requests WHERE principal=? AND state!='settled'")
            .get(principal).n,
        )
        if (current.quota_requests > 0 && (current.quota_requests_used || 0) + pending >= current.quota_requests)
          throw failure('api_key_quota_exhausted', 429)
        const rpm = Number(
          this.db
            .prepare('SELECT count(*) n FROM rollout_requests WHERE principal=? AND created_at>?')
            .get(principal, Date.now() - 60000).n,
        )
        if (current.max_concurrency > 0 && pending >= current.max_concurrency)
          throw failure('api_key_concurrency_limit', 429)
        if (current.rpm > 0 && rpm >= current.rpm) throw failure('api_key_rate_limit', 429)
        if (current.user_id) {
          const cap = this.keys._userConcurrencyCap(current.user_id)
          const total = Number(
            this.db
              .prepare("SELECT count(*) n FROM rollout_requests WHERE owner_id=? AND state!='settled'")
              .get(current.user_id).n,
          )
          if (cap > 0 && total >= cap) throw failure('user_concurrency_limit', 429)
        }
      }
      const ephemeral = !billable && !session
      const id = digest(`${principal}\0${session || (ephemeral ? crypto.randomUUID() : 'conservative-principal')}`)
      let binding = this.db.prepare('SELECT * FROM rollout_sessions WHERE id=?').get(id)
      if (!binding || binding.closed) {
        const group = this.group(this.policy().target)
        if (!group || group.mode !== 'accepting') throw failure('no_accepting_group', 503)
        this.db
          .prepare(
            'INSERT INTO rollout_sessions(id,principal,group_id,recovery,closed) VALUES(?,?,?,?,0) ON CONFLICT(id) DO UPDATE SET group_id=excluded.group_id,recovery=excluded.recovery,closed=0',
          )
          .run(id, principal, group.id, recovery)
        binding = this.db.prepare('SELECT * FROM rollout_sessions WHERE id=?').get(id)
      }
      const group = this.group(binding.group_id)
      if (!group || !['accepting', 'continuation'].includes(group.mode)) throw failure('bound_group_unavailable', 503)
      const requestId = crypto.randomUUID()
      this.db
        .prepare(
          'INSERT INTO rollout_requests(id,session_id,principal,key_id,owner_id,group_id,state,created_at,billable,ephemeral) VALUES(?,?,?,?,?,?,?,?,?,?)',
        )
        .run(
          requestId,
          id,
          principal,
          current?.id || null,
          current?.user_id || null,
          group.id,
          'reserved',
          Date.now(),
          billable ? 1 : 0,
          ephemeral ? 1 : 0,
        )
      return { requestId, binding, group, record: current, generation: this.policy().generation }
    })
  }
  sent(id) {
    this.db.prepare("UPDATE rollout_requests SET state='sent' WHERE id=? AND state='reserved'").run(id)
  }
  pending(group) {
    return this.db
      .prepare("SELECT id FROM rollout_requests WHERE state!='settled'" + (group ? ' AND group_id=?' : ''))
      .all(...(group ? [group] : []))
  }
  settle(id, report) {
    return this.transaction(() => {
      const request = this.db.prepare('SELECT * FROM rollout_requests WHERE id=?').get(id)
      if (
        !request ||
        report.request_id !== id ||
        report.group !== request.group_id ||
        report.instance !== this.group(request.group_id).instance ||
        report.state !== 'completed'
      )
        throw failure('unconfirmed_execution')
      if (request.state === 'settled') return { duplicate: true }
      if (!['success', 'failure', 'cancelled'].includes(report.outcome)) throw failure('unknown_execution')
      if (request.key_id && request.billable && report.outcome === 'success') {
        const key = this.keys.getById(request.key_id)
        this.keys.recordUsage(request.key_id, report.usage || {}, {
          model: report.model,
          rateMultiplier: this.groupsRepo.rateMultiplier(key?.group_id ?? 1),
          officialCost:
            typeof report.official_cost === 'number' &&
            Number.isFinite(report.official_cost) &&
            report.official_cost >= 0
              ? report.official_cost
              : undefined,
        })
      }
      const safe = {
        outcome: report.outcome,
        usage: report.usage || {},
        model: report.model || null,
        group: report.group,
        instance: report.instance,
      }
      this.db.prepare("UPDATE rollout_requests SET state='settled',report=? WHERE id=?").run(JSON.stringify(safe), id)
      if (request.ephemeral) this.db.prepare('UPDATE rollout_sessions SET closed=1 WHERE id=?').run(request.session_id)
      return { duplicate: false }
    })
  }
  drain(id, proof) {
    const group = this.group(id)
    if (!group) throw failure('group_not_found', 404)
    const confirmed =
      proof?.schema === 1 &&
      proof.group === id &&
      proof.instance === group.instance &&
      proof.ready === true &&
      proof.active_requests === 0 &&
      proof.queued_requests === 0 &&
      proof.pending_tool_results === 0 &&
      proof.helper_active === false &&
      proof.recovering === false &&
      proof.switch_ready === true
    return this.transaction(() => {
      const pending = this.pending(id).length
      const current = this.group(id)
      if (
        confirmed &&
        !pending &&
        current.mode === 'continuation' &&
        proof.session_restore_protocol === 'anthropic-full-history-v1'
      )
        this.db
          .prepare("UPDATE rollout_sessions SET closed=1 WHERE group_id=? AND recovery='anthropic-full-history-v1'")
          .run(id)
      const bound = Number(
        this.db.prepare('SELECT count(*) n FROM rollout_sessions WHERE group_id=? AND closed=0').get(id).n,
      )
      return {
        group: id,
        instance: group.instance,
        policy_generation: this.policy().generation,
        confirmed,
        pending_requests: pending,
        bound_sessions: bound,
        drained: confirmed && !pending && !bound && current.mode === 'continuation',
      }
    })
  }
  snapshot() {
    return {
      policy: this.policy(),
      groups: this.groups(),
      requests: this.db
        .prepare('SELECT id,group_id,state FROM rollout_requests ORDER BY created_at DESC LIMIT 1000')
        .all(),
      sessions: this.db.prepare('SELECT id,group_id,recovery,closed FROM rollout_sessions LIMIT 1000').all(),
    }
  }
  retire(expected, id, proof) {
    const drained = this.drain(id, proof)
    return this.transaction(() => {
      if (
        this.policy().generation !== expected ||
        this.policy().target === id ||
        !drained.drained ||
        this.pending(id).length
      )
        throw failure('retirement_not_confirmed')
      this.db.prepare("UPDATE rollout_groups SET mode='retired' WHERE id=? AND mode='continuation'").run(id)
      return { ...drained, retired: true }
    })
  }
}
