import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'
import { getVm, listVms, patchVmRecord } from './vm-registry.mjs'
import { readJsonCached, withVmLock } from './vm-file.mjs'
import { deriveScheduleFields } from '../pool/schedule-state.mjs'
import { powerOnSlot, inspectSlotContainer } from './slot-recovery.mjs'
import { runtimeKind } from './runtime-kind.mjs'
import { slotExec } from './slot-runtime.mjs'
import { getRustKernelHelper } from '../transport/rust-kernel-client.mjs'
import { isCodexVm } from './vm-kind.mjs'

const fail = (code) => Object.assign(new Error(code), { code })
const require = (ok, code) => {
  if (!ok) throw fail(code)
}
const fileOf = (project) => path.join(project, 'data', 'deployment-lifecycle.json')
const hash = (value) => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex')
const binding = (vm) =>
  hash([
    vm.id,
    vm.owner_user_id,
    vm.account_id,
    vm.claude?.account_uuid,
    vm.claude?.org_uuid,
    vm.node_id,
    vm.proxy?.id,
    vm.fingerprint,
  ])
const selection = (vm) => ({
  dataplane: vm.dataplane || 'wrap',
  manifest_sha256: vm.kernel_package?.manifest_sha256 || null,
})
const active = (t) => t && !['resumed', 'cancelled'].includes(t.state)
async function kernelHealth(project, vm) {
  // 发布证明必须来自真实控制套接字，不能使用推理模拟健康结果。
  const result = await getRustKernelHelper(slotExec(project, vm), '/internal/health', { timeoutMs: 2000 })
  return result.ok ? result.body : null
}

export function deploymentActive(project) {
  return !!active(readJsonCached(fileOf(project)))
}

export function deploymentOwnsSlot(vm) {
  return vm?.schedule_hold?.reason === 'maintenance' && vm.schedule_hold.detail?.deployment === true
}

// 同步落盘后才执行下一步。崩溃后的半完成暂停和恢复可以核对归属后补齐。
function save(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 })
  const temporary = `${file}.pending`
  const fd = fs.openSync(temporary, 'w', 0o600)
  try {
    fs.writeFileSync(fd, JSON.stringify(value))
    fs.fsyncSync(fd)
  } finally {
    fs.closeSync(fd)
  }
  fs.renameSync(temporary, file)
  const directory = fs.openSync(path.dirname(file), 'r')
  try {
    fs.fsyncSync(directory)
  } finally {
    fs.closeSync(directory)
  }
}

export class DeploymentLifecycle {
  constructor(ctx) {
    this.ctx = ctx
    this.project = ctx.cfg.paths.project
    this.file = fileOf(this.project)
  }

  read() {
    return fs.existsSync(this.file) ? JSON.parse(fs.readFileSync(this.file)) : null
  }
  write(t, state) {
    t.state = state
    t.updated_at = new Date().toISOString()
    save(this.file, t)
  }
  view(t) {
    return t
      ? {
          schema: 1,
          id: t.id,
          instance: t.instance,
          state: t.state,
          target: t.target,
          slots: t.slots.map(({ id, running }) => ({ id, running })),
          updated_at: t.updated_at,
        }
      : null
  }
  records() {
    return listVms(this.project)
      .map((vm) => getVm(this.project, vm.id))
      .filter((vm) => vm.status !== 'deleted')
  }
  assertScope(t, { resuming = false } = {}) {
    const records = this.records()
    require(isDeepStrictEqual(
      records.map((v) => v.id).sort(),
      t.slots.map((v) => v.id).sort(),
    ), 'deployment_scope_changed')
    for (const before of t.slots) {
      const vm = getVm(this.project, before.id)
      require(binding(vm) === before.binding, 'deployment_binding_changed')
      const owned = deploymentOwnsSlot(vm) && vm.schedule_hold.detail.tag === t.id
      require(owned ||
        (resuming && isDeepStrictEqual(vm.schedule_hold || null, before.hold)), 'deployment_hold_changed')
    }
  }
  async proof(t, target = false) {
    const scheduler = this.ctx.poolScheduler
    require(typeof scheduler?.queuedTotal === 'function' &&
      scheduler.vmInflight instanceof Map &&
      typeof this.ctx.deploymentInflight === 'function', 'deployment_scheduler_proof_missing')
    require(this.ctx.deploymentInflight() === 0, 'deployment_not_drained')
    require(scheduler.queuedTotal() === 0, 'deployment_not_drained')
    for (const before of t.slots) {
      const vm = getVm(this.project, before.id)
      require(Number(scheduler.vmInflight?.get(before.id) || 0) === 0, 'deployment_not_drained')
      const h = await kernelHealth(this.project, vm)
      if (!before.running) {
        require(vm.status === before.status, 'deployment_stopped_slot_changed')
        if (!h) {
          const runtime = await inspectSlotContainer(vm)
          require(runtime.running === false && runtime.restarting !== true, 'deployment_stopped_runtime_unknown')
          continue
        }
      }
      require(h?.ok === true &&
        h.healthy === true &&
        h.rollout_drain_schema === 1 &&
        h.session_restore_protocol === 'anthropic-full-history-v1', 'deployment_health_proof_missing')
      require(h.active_requests === 0 &&
        h.pending_tool_results === 0 &&
        h.queued_requests === 0 &&
        h.helper_active === false &&
        h.recovering === false &&
        h.switch_ready === true, 'deployment_not_drained')
      const wanted =
        target && before.running && t.target.manifest_sha256
          ? { dataplane: 'hermit', manifest_sha256: t.target.manifest_sha256 }
          : before.selection
      require(isDeepStrictEqual(selection(vm), wanted), 'deployment_kernel_identity_changed')
      require((wanted.dataplane === 'hermit') === (h.runtime_flavor === 'hermit'), 'deployment_kernel_identity_changed')
      if (before.running) require(vm.status === 'running', 'deployment_runtime_not_running')
    }
  }
  async run(action, body = {}) {
    return withVmLock(this.file, async () => {
      const instance = process.env.TRUEROUTER_INSTANCE_ID
      require(instance && instance === body.instance, 'deployment_instance_mismatch')
      if (action === 'status') return this.view(this.read())
      require(/^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/.test(body.id || ''), 'deployment_id_invalid')
      let t = this.read()
      if (action === 'prepare') {
        const target = body.target || {}
        require(Object.keys(target).every((k) => k === 'manifest_sha256') &&
          (!target.manifest_sha256 || /^[a-f0-9]{64}$/.test(target.manifest_sha256)), 'deployment_target_invalid')
        if (t?.id !== body.id) {
          require(!active(t), 'deployment_already_active')
          const history = path.join(this.project, 'data', 'deployments', `${body.id}.json`)
          require(!fs.existsSync(history), 'deployment_id_reused')
          if (t) save(path.join(this.project, 'data', 'deployments', `${t.id}.json`), t)
          const records = this.records()
          require(records.length > 0 &&
            records.every(
              (vm) =>
                !isCodexVm(vm) &&
                (!vm.kernel_transition || ['finalized', 'rolled_back'].includes(vm.kernel_transition.state)),
            ), 'deployment_slot_not_supported')
          require(!target.manifest_sha256 ||
            records
              .filter((vm) => vm.status === 'running')
              .every(
                (vm) => !vm.node_id && runtimeKind(vm) === 'docker' && process.platform === 'linux',
              ), 'deployment_kernel_placement_unsupported')
          t = {
            schema: 1,
            id: body.id,
            instance,
            target,
            slots: records.map((vm) => ({
              id: vm.id,
              status: vm.status,
              running: vm.status === 'running',
              binding: binding(vm),
              selection: selection(vm),
              hold: vm.schedule_hold || null,
            })),
          }
          this.write(t, 'holding')
        }
        require(t.instance === instance && isDeepStrictEqual(t.target, target), 'deployment_identity_changed')
        if (!active(t)) return this.view(t)
        require(['holding', 'waiting', 'prepared'].includes(t.state), 'deployment_phase_invalid')
        for (const before of t.slots) {
          await this.ctx.kernelWatchdog?.hold?.(before.id)
          const vm = getVm(this.project, before.id)
          require(vm && binding(vm) === before.binding, 'deployment_binding_changed')
          if (deploymentOwnsSlot(vm) && vm.schedule_hold.detail.tag === t.id) continue
          require(isDeepStrictEqual(vm.schedule_hold || null, before.hold), 'deployment_hold_changed')
          patchVmRecord(this.project, before.id, (record) => {
            record.schedule_hold = { reason: 'maintenance', detail: { tag: t.id, deployment: true } }
            deriveScheduleFields(record)
          })
        }
        this.assertScope(t)
        this.write(t, 'waiting')
        try {
          await this.proof(t)
          await new Promise((resolve) => setTimeout(resolve, 200))
          await this.proof(t)
        } catch (error) {
          if (['deployment_not_drained', 'deployment_health_proof_missing'].includes(error.code)) return this.view(t)
          throw error
        }
        this.write(t, 'prepared')
        return this.view(t)
      }
      require(t && t.id === body.id && t.instance === instance, 'deployment_identity_changed')
      if (action === 'begin-update') {
        if (t.state === 'updating') return this.view(t)
        require(t.state === 'prepared', 'deployment_phase_invalid')
        this.assertScope(t)
        await this.proof(t)
        this.write(t, 'updating')
        return this.view(t)
      }
      if (action === 'cancel') {
        if (t.state === 'cancelled') return this.view(t)
        require(['holding', 'waiting', 'prepared', 'cancelling'].includes(t.state), 'deployment_phase_invalid')
        this.assertScope(t, { resuming: true })
        this.write(t, 'cancelling')
        this.release(t)
        this.write(t, 'cancelled')
        return this.view(t)
      }
      if (action === 'restore') {
        require(['updating', 'restoring', 'ready'].includes(t.state), 'deployment_phase_invalid')
        this.assertScope(t)
        this.write(t, 'restoring')
        for (const before of t.slots.filter((slot) => slot.running)) {
          await withVmLock(path.join(this.project, 'vms', `${before.id}.json`), async () => {
            const vm = getVm(this.project, before.id)
            const health = await kernelHealth(this.project, vm)
            if (vm.dataplane !== 'hermit' && vm.status === 'running' && health?.ok === true && health.healthy === true)
              return
            require(this.ctx.proxyPool.getProxyForVm(before.id)?.id ===
              vm.proxy?.id, 'deployment_proxy_binding_missing')
            await this.ctx.kernelWatchdog?.hold?.(before.id)
            try {
              const started = await powerOnSlot({
                projectRoot: this.project,
                id: before.id,
                proxyPool: this.ctx.proxyPool,
                routing: this.ctx.routingConfig,
                by: 'deployment',
                fillTimezone: async () => {},
              })
              require(started.ok &&
                started.boot?.rust_ok !== false &&
                started.boot?.rust?.ok !== false, 'deployment_restore_failed')
            } finally {
              this.ctx.kernelWatchdog?.release?.(before.id)
            }
          })
        }
        this.assertScope(t)
        await this.proof(t, true)
        this.write(t, 'ready')
        return this.view(t)
      }
      if (action === 'resume') {
        if (t.state === 'resumed') return this.view(t)
        require(['ready', 'resuming'].includes(t.state), 'deployment_phase_invalid')
        this.assertScope(t, { resuming: t.state === 'resuming' })
        require(t.slots.every((before) => {
          const transition = getVm(this.project, before.id).kernel_transition
          return !transition || ['finalized', 'rolled_back'].includes(transition.state)
        }), 'deployment_kernel_not_finalized')
        await this.proof(t, true)
        this.write(t, 'resuming')
        this.release(t)
        this.write(t, 'resumed')
        return this.view(t)
      }
      throw fail('deployment_action_invalid')
    })
  }
  release(t) {
    for (const before of t.slots) {
      patchVmRecord(this.project, before.id, (record) => {
        if (deploymentOwnsSlot(record) && record.schedule_hold.detail.tag === t.id) {
          if (before.hold) record.schedule_hold = before.hold
          else delete record.schedule_hold
          deriveScheduleFields(record)
        }
      })
      this.ctx.kernelWatchdog?.release?.(before.id)
    }
  }
}
