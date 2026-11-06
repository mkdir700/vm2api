import { mkdir, readFile, open, rename, rm } from 'node:fs/promises'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { SettingsRepo } from '../db/repos/settings-repo.mjs'
import { managedEgressConfig } from './managed-egress-config.mjs'

const digest = (value) => createHash('sha256').update(value).digest('hex')

/** One instance per host. The runtime adapter checks, restarts and verifies the same service.
 * acquireDrain must pause every affected caller before returning a lease with wait/release.
 * A lease with unavailable=true must leave callers blocked after release.
 */
export class ManagedEgressHost {
  constructor({ db, hostId, configDir, runtime, acquireDrain, files = null }) {
    if (!hostId || !configDir || !runtime || typeof acquireDrain !== 'function')
      throw new Error('managed_host_options_required')
    this.settings = new SettingsRepo(db)
    this.key = `managed_egress_host:${hostId}`
    if (
      files &&
      (files.root !== configDir ||
        ['ensure', 'read', 'atomic', 'remove'].some((name) => typeof files[name] !== 'function'))
    )
      throw new Error('managed_host_store_invalid')
    this.files = files
    this.dir = configDir
    this.file = path.join(configDir, 'config.json')
    this.previous = path.join(configDir, 'previous.json')
    this.runtime = runtime
    this.acquireDrain = acquireDrain
    this.queue = Promise.resolve()
  }

  state() {
    return this.settings.get(this.key, { desired_version: null, applied_version: null, status: 'unknown', error: null })
  }

  /** The caller settles managed operations before replacing the database. */
  rebind(db) {
    this.settings = new SettingsRepo(db)
  }

  record(patch) {
    const state = { ...this.state(), ...patch }
    this.settings.set(this.key, state)
    return state
  }

  serialize(operation) {
    const result = this.queue.then(operation)
    this.queue = result.catch(() => {})
    return result
  }

  async ensureDirectory() {
    if (this.files) return this.files.ensure()
    return mkdir(this.dir, { recursive: true, mode: 0o700 })
  }

  async read(file) {
    if (this.files) return this.files.read(path.basename(file))
    return readFile(file, 'utf8')
  }

  async remove(file) {
    if (this.files) return this.files.remove(path.basename(file))
    return rm(file, { force: true })
  }

  async atomic(file, text) {
    if (this.files) return this.files.atomic(path.basename(file), text)
    const candidate = `${file}.new`
    try {
      const handle = await open(candidate, 'w', 0o600)
      try {
        await handle.writeFile(text)
        await handle.sync()
      } finally {
        await handle.close()
      }
      await rename(candidate, file)
      const directory = await open(path.dirname(file), 'r')
      try {
        await directory.sync()
      } finally {
        await directory.close()
      }
    } finally {
      await rm(candidate, { force: true })
    }
  }

  apply(exits, { drainTimeoutMs = 30000 } = {}) {
    // Snapshot the submitted state so a caller cannot mutate a queued update.
    const text = JSON.stringify(managedEgressConfig(exits))
    return this.serialize(() => this.applyText(text, drainTimeoutMs))
  }

  async applyText(text, drainTimeoutMs) {
    const before = this.state()
    if (['applying', 'unavailable'].includes(before.status)) throw new Error('managed_host_recovery_required')
    await this.ensureDirectory()
    const desired = digest(text)
    this.record({ desired_version: desired, status: 'checking', error: null })
    const candidate = path.join(this.dir, 'candidate.json')
    let lease
    let changed = false
    let previous
    try {
      await this.atomic(candidate, text)
      await this.runtime.check(candidate)
      previous = await this.read(this.file)
      lease = await this.acquireDrain()
      this.record({ status: 'draining' })
      if ((await lease.wait(drainTimeoutMs)) !== true) throw new Error('managed_drain_timeout')
      // Save recovery material before publishing the candidate or restarting.
      await this.atomic(this.previous, previous)
      this.record({ status: 'applying' })
      // Publication may succeed before a directory-sync error is reported.
      changed = true
      await this.atomic(this.file, text)
      await this.runtime.restart()
      await this.runtime.verify(JSON.parse(text))
      this.record({ applied_version: desired, status: 'ready', error: null })
      await this.remove(this.previous)
      return this.state()
    } catch (error) {
      if (changed) {
        try {
          await this.atomic(this.file, previous)
          await this.runtime.restart()
          await this.runtime.verify(JSON.parse(previous))
          this.record({
            applied_version: digest(previous),
            status: 'ready',
            error: 'managed_apply_failed_rolled_back',
          })
          await this.remove(this.previous)
        } catch {
          this.record({ status: 'unavailable', error: 'managed_rollback_failed' })
        }
      } else {
        this.record({
          status: before.status,
          error: error?.message === 'managed_drain_timeout' ? 'managed_drain_timeout' : 'managed_candidate_failed',
        })
      }
      return this.state()
    } finally {
      try {
        await this.remove(candidate)
      } finally {
        if (lease) {
          try {
            await lease.release({ unavailable: this.state().status === 'unavailable' })
          } catch {
            this.record({ status: 'unavailable', error: 'managed_drain_release_failed' })
            throw new Error('managed_drain_release_failed')
          }
        }
      }
    }
  }

  /** Verify an already-applied instance without restarting it or interrupting bound slots. */
  inspect() {
    return this.serialize(async () => {
      const state = this.state()
      let config
      try {
        if (state.status !== 'ready' || !state.applied_version) throw new Error('managed_no_applied_state')
        try {
          await this.read(this.previous)
          throw new Error('managed_recovery_required')
        } catch (error) {
          if (error.code !== 'ENOENT') throw error
        }
        const text = await this.read(this.file)
        if (digest(text) !== state.applied_version) throw new Error('managed_active_hash_mismatch')
        config = JSON.parse(text)
        await this.runtime.check(this.file)
        const exits = []
        for (const inbound of config.inbounds) {
          try {
            const observed = await this.runtime.verify({ ...config, inbounds: [inbound] })
            exits.push({ id: inbound.tag.replace(/^in-/, ''), ready: true, ip: observed?.[0]?.ip || null })
          } catch {
            exits.push({ id: inbound.tag.replace(/^in-/, ''), ready: false, error: 'managed_exit_verification_failed' })
          }
        }
        return { ok: true, config, exits }
      } catch {
        return { ok: false, error: 'managed_runtime_unverified', config, exits: [] }
      }
    })
  }

  /** Explicit startup reconciliation. Keep callers blocked until this returns ready.
   * A crash during apply restores the saved configuration before verification.
   */
  recover() {
    return this.serialize(async () => {
      const lease = await this.acquireDrain({ recovery: true })
      try {
        if ((await lease.wait(30000)) !== true) throw new Error('managed_drain_timeout')
        let previous = null
        try {
          previous = await this.read(this.previous)
        } catch (error) {
          if (error.code !== 'ENOENT') throw error
        }
        if (previous != null) await this.atomic(this.file, previous)
        const text = await this.read(this.file)
        await this.runtime.check(this.file)
        await this.runtime.restart()
        await this.runtime.verify(JSON.parse(text))
        this.record({ applied_version: digest(text), status: 'ready', error: null })
        await this.remove(this.previous)
        return this.state()
      } catch {
        return this.record({ status: 'unavailable', error: 'managed_recovery_failed' })
      } finally {
        try {
          await lease.release({ unavailable: this.state().status === 'unavailable' })
        } catch {
          this.record({ status: 'unavailable', error: 'managed_drain_release_failed' })
          throw new Error('managed_drain_release_failed')
        }
      }
    })
  }
}
