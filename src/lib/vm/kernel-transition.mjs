import crypto from 'node:crypto'
import fs from 'node:fs'
import net from 'node:net'
import path from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { getVm, patchVmRecord, waitForSlotDrain } from './vm-registry.mjs'
import { slotExec, startSlotReady, ensureSlotInferenceRuntime } from './slot-runtime.mjs'
import { slotExecContainer } from './slot-exec.mjs'
import { slotHost } from './slot-host.mjs'
import { runtimeKind } from './runtime-kind.mjs'
import { inspectContainer, runtimePatch } from './vm-runtime.mjs'
import { isCodexVm } from './vm-kind.mjs'
import { resolveKernelDataplane } from './slot-engine.mjs'
import { resolveHermitPackage, assertHermitActivation, hermitAuthentication } from './hermit-runtime.mjs'
import { ensureHermitKernel, stopHermitKernel } from '../transport/hermit-kernel-supervisor.mjs'
import { rustKernelHealth, rustKernelPaths } from '../transport/rust-kernel-client.mjs'
import { checkCragLicense } from './crag-license.mjs'
import { describeKernelCatalog } from '../admin/kernel-catalog.mjs'
import { deriveScheduleFields, migrateScheduleRecord, applyScheduleOff } from '../pool/schedule-state.mjs'

const execute = promisify(execFile)
const selectionFields = ['dataplane', 'crag_kernel_version', 'kernel_package', 'pending_kernel_package']
const terminal = new Set(['finalized', 'rolled_back'])
const fail = (code, message) => Object.assign(new Error(message), { code })
const selection = (vm) =>
  Object.fromEntries(selectionFields.filter((k) => k in vm).map((k) => [k, structuredClone(vm[k])]))
function replaceSelection(record, desired) {
  for (const field of selectionFields) {
    if (field in desired) record[field] = structuredClone(desired[field])
    else delete record[field]
  }
}
async function docker(vm, args) {
  const env = slotHost(vm).dockerEnv()
  return (
    await execute(process.env.KIN_DOCKER_BIN || 'docker', args, {
      timeout: 45000,
      maxBuffer: 256 * 1024,
      ...(env ? { env } : {}),
    })
  ).stdout
}
async function inspect(vm, name) {
  try {
    return JSON.parse(await docker(vm, ['inspect', name]))[0]
  } catch (error) {
    if (/No such (object|container)/i.test(error.stderr || '')) return null
    throw error
  }
}
async function clearStoppedKernelSocket(project, vm) {
  const paths = rustKernelPaths(slotExec(project, vm))
  if (!paths.runDir || paths.socketPath !== path.join(paths.runDir, 'kernel.sock'))
    throw fail('kernel_socket_path_invalid', '内核套接字路径不符合槽位配置')
  let before
  try {
    before = fs.lstatSync(paths.socketPath)
  } catch (error) {
    if (error.code === 'ENOENT') return
    throw error
  }
  if (!before.isSocket() || fs.lstatSync(paths.runDir).isSymbolicLink())
    throw fail('kernel_socket_invalid', '内核套接字不是可清理的残留套接字')
  await new Promise((resolve, reject) => {
    const socket = net.createConnection(paths.socketPath)
    const finish = (error) => {
      socket.destroy()
      error ? reject(error) : resolve()
    }
    socket.setTimeout(1000, () => finish(fail('kernel_socket_busy', '内核套接字状态尚未确认')))
    socket.once('connect', () => finish(fail('kernel_socket_busy', '内核套接字仍有活动进程')))
    socket.once('error', (error) => finish(['ENOENT', 'ECONNREFUSED'].includes(error.code) ? null : error))
  })
  let after
  try {
    after = fs.lstatSync(paths.socketPath)
  } catch (error) {
    if (error.code === 'ENOENT') return
    throw error
  }
  if (!after.isSocket() || after.ino !== before.ino || after.dev !== before.dev)
    throw fail('kernel_socket_changed', '内核套接字身份已改变')
  fs.unlinkSync(paths.socketPath)
}
export function publicKernelTransition(vm) {
  const t = vm?.kernel_transition
  if (!t) return null
  return {
    id: t.id,
    state: t.state,
    target: t.target,
    previous: t.previous,
    started_at: t.started_at,
    completed_at: t.completed_at || null,
    code: t.code || null,
    recovery_code: t.recovery_code || null,
    can_rollback: !terminal.has(t.state),
  }
}
function save(project, id, transition, state, extra = {}) {
  Object.assign(transition, extra, { state })
  const saved = patchVmRecord(project, id, { kernel_transition: transition })
  if (!saved) throw fail('vm_not_found', '槽位记录不存在')
  return saved
}
function hold(project, id, t) {
  return patchVmRecord(project, id, (vm) => {
    vm.schedule_hold = { reason: 'maintenance', detail: { tag: t.id } }
    deriveScheduleFields(vm)
  })
}
function release(project, id, t, patch) {
  return patchVmRecord(project, id, (vm) => {
    patch?.(vm)
    if (vm.schedule_hold?.detail?.tag === t.id) {
      if (t.previous_hold) vm.schedule_hold = t.previous_hold
      else delete vm.schedule_hold
    }
    deriveScheduleFields(vm)
  })
}
const healthy = (boot) => boot?.ok === true && boot.rust_ok !== false && boot.rust?.ok !== false
async function transitionHealth(project, vm) {
  const exec = slotExec(project, vm)
  let health = await rustKernelHealth(exec, { timeoutMs: 1000 })
  if (vm.dataplane === 'hermit' && !health?.ok && health?.status !== 200) {
    const started = await ensureHermitKernel(exec)
    if (started.ok) health = await rustKernelHealth(exec, { timeoutMs: 1000 })
  }
  return health
}

async function prepare(project, vm, target, routing) {
  const desired = { ...vm, ...target }
  if (target.dataplane === 'hermit') {
    const binding = { runtime: 'hermit', target: target.target, version: target.version }
    const installed = await resolveHermitPackage(project, binding)
    assertHermitActivation(desired, installed.manifest)
    hermitAuthentication(project, vm, { allowOAuth: installed.manifest.capabilities.helper_integration === true })
    if (
      routing.compatibility?.official_cc_passthrough !== true &&
      installed.manifest.capabilities.system_prompt !== true
    )
      throw fail(
        'hermit_protocol_profile_unsupported',
        '当前 Hermit 包不支持 vm2api 系统提示词，请安装具有 system_prompt 能力的版本',
      )
    if (
      routing.failover?.eager_tool_streaming === true &&
      installed.manifest.capabilities.eager_tool_streaming !== true
    )
      throw fail(
        'hermit_protocol_profile_unsupported',
        '当前 Hermit 包不支持工具参数流式，请安装具有 eager_tool_streaming 能力的版本',
      )
    desired.kernel_package = { ...binding, manifest_sha256: installed.manifest_sha256 }
    delete desired.crag_kernel_version
  } else {
    if (!['wrap', 'crag'].includes(target.dataplane))
      throw fail('invalid_dataplane', '请选择 cli-node、CRAG v2 或 Hermit')
    delete desired.kernel_package
    if (target.dataplane === 'crag') desired.crag_kernel_version = 'v2'
    else delete desired.crag_kernel_version
    const product = describeKernelCatalog(project).find(
      (p) => p.id === (target.dataplane === 'crag' ? 'crag' : 'cli-node'),
    )
    if (!product?.ready) throw fail(product?.code || 'kernel_package_missing', product?.error || '请先安装目标内核')
    const license = checkCragLicense(project, desired, routing)
    if (!license.ok) throw fail(license.code, license.error)
  }
  delete desired.pending_kernel_package
  return desired
}

// The caller owns the canonical VM lifecycle lock throughout drain and recovery.
export async function runKernelTransition({
  project,
  id,
  action = 'apply',
  target,
  routing = {},
  watchdog,
  scheduler,
  proxyPool,
  stopAfterApply = false,
}) {
  let vm = getVm(project, id)
  if (!vm || vm.id !== id) return { ok: false, code: 'vm_not_found', error: '槽位不存在' }
  if (isCodexVm(vm) || vm.node_id || runtimeKind(vm) !== 'docker' || process.platform !== 'linux')
    return {
      ok: false,
      code: 'kernel_transition_placement_unsupported',
      error: '内核切换仅支持本机 Linux Docker Claude 槽位',
    }
  let t = vm.kernel_transition
  let held = false
  let began = false
  let rollbackStarted = false
  try {
    if (!['apply', 'rollback', 'finalize'].includes(action))
      throw fail('kernel_transition_action_invalid', '切换动作无效')
    if (action === 'apply') {
      if (!target || typeof target !== 'object') throw fail('kernel_target_invalid', '请选择目标内核')
      const proxy = proxyPool?.getProxyByIdWithAuth(vm.proxy?.id)
      if (!proxy) throw fail('proxy_required', '槽位缺少可用的出口绑定')
      vm = { ...vm, proxy }
      if (target.dataplane !== 'hermit' && resolveKernelDataplane(vm, routing) !== 'hermit')
        throw fail('kernel_transition_target_unsupported', '原生内核之间请使用现有切换入口')
      const desired = await prepare(project, vm, target, routing)
      if (
        !stopAfterApply &&
        vm.dataplane === 'hermit' &&
        target.dataplane === 'hermit' &&
        vm.kernel_package?.manifest_sha256 === desired.kernel_package.manifest_sha256 &&
        (!t || terminal.has(t.state) || t.state === 'applied')
      ) {
        const existing = await inspect(vm, slotExecContainer(vm))
        if (existing && !existing.State?.Running && vm.status !== 'running')
          return { ok: true, activated: true, unchanged: true, transition: publicKernelTransition(vm) }
        const result = await ensureHermitKernel(slotExec(project, vm))
        if (!result.ok) throw fail(result.reason, result.error || '当前 Hermit 内核未就绪')
        return { ok: true, activated: true, unchanged: true, transition: publicKernelTransition(vm) }
      }
      if (t && !terminal.has(t.state)) throw fail('kernel_transition_pending', '请先回滚或确认上次切换')
      held = true
      await watchdog?.hold?.(id)
      // Match the installer: observe container identity after any watchdog restart settles.
      const latest = getVm(project, id)
      vm.runtime = latest?.runtime || vm.runtime
      desired.runtime = structuredClone(vm.runtime || {})
      const name = slotExecContainer(vm)
      const old = await inspect(vm, name)
      if (old && old.Config?.Labels?.['kin.vm.id'] !== id)
        throw fail('kernel_container_identity_mismatch', '原容器与槽位身份不匹配')
      t = {
        id: `kernel-${crypto.randomUUID()}`,
        state: 'prepared',
        started_at: new Date().toISOString(),
        previous: selection(vm),
        target: selection(desired),
        previous_status: vm.status,
        previous_hold: vm.schedule_hold || null,
        container: name,
        backup: `${name}-rollback-${crypto.randomBytes(5).toString('hex')}`,
        previous_container_id: old?.Id || null,
        candidate_container_id: null,
        previous_running: old?.State?.Running === true,
        previous_runtime: structuredClone(vm.runtime || {}),
        restart_policy: old?.HostConfig?.RestartPolicy?.Name || 'no',
      }
      save(project, id, t, 'prepared')
      began = true
      hold(project, id, t)
      const drained = await waitForSlotDrain(scheduler, [id])
      if (!drained.ok) throw fail('slots_busy', '在途请求未结束，未切换内核')
      const currentHealth = await transitionHealth(project, vm)
      if (
        Number(currentHealth?.active_requests) > 0 ||
        currentHealth?.helper_active === true ||
        currentHealth?.recovering === true
      )
        throw fail('kernel_busy', '内核仍有活动请求，未切换内核')
      if (
        vm.dataplane === 'hermit' &&
        old?.State?.Running === true &&
        (currentHealth?.switch_ready !== true || Number(currentHealth?.pending_tool_results) > 0)
      )
        throw fail('kernel_tools_pending', '内核尚未确认工具结果已返回，未切换内核')
      save(project, id, t, 'stopping')
      const stopped = await stopHermitKernel(slotExec(project, vm))
      if (!stopped.ok) throw fail(stopped.reason, '旧内核停止尚未确认')
      if (old) {
        // Disable automatic restart before retaining the old container.
        await docker(vm, ['update', '--restart=no', name])
        await docker(vm, ['stop', '--time', '30', name])
        const halted = await inspect(vm, name)
        if (halted?.State?.Running) throw fail('kernel_stop_unconfirmed', '旧容器停止尚未确认')
        await clearStoppedKernelSocket(project, vm)
        save(project, id, t, 'retaining')
        await docker(vm, ['rename', name, t.backup])
      }
      save(project, id, t, 'starting')
      desired.kernel_transition_id = t.id
      const boot = await startSlotReady(desired, project, {
        routing: { ...routing, inference: { ...routing.inference, eager_start: true } },
      })
      const candidate = await inspect(vm, name)
      if (candidate) save(project, id, t, 'checking', { candidate_container_id: candidate.Id })
      if (!healthy(boot))
        throw fail(boot?.code || boot?.rust?.reason || 'kernel_start_failed', '目标内核未通过健康检查')
      const observed = await rustKernelHealth(slotExec(project, desired), { timeoutMs: 2000 })
      if (!observed || observed.healthy === false || !(observed.ok === true || observed.status === 200))
        throw fail('kernel_health_failed', '目标内核未通过健康检查')
      if ((target.dataplane === 'hermit') !== (observed.runtime_flavor === 'hermit'))
        throw fail('kernel_identity_mismatch', '目标内核身份不匹配')
      const keepRunning =
        !stopAfterApply && (t.previous_container_id ? t.previous_running : t.previous_status === 'running')
      if (!keepRunning) {
        const stop = await stopHermitKernel(slotExec(project, desired))
        if (!stop.ok) throw fail(stop.reason, '目标内核停止尚未确认')
        await docker(vm, ['stop', '--time', '30', name])
        if (stopAfterApply) {
          await docker(vm, ['update', '--restart=no', name])
          const halted = await inspect(vm, name)
          if (!halted || halted.State?.Running || halted.HostConfig?.RestartPolicy?.Name !== 'no')
            throw fail('kernel_stop_unconfirmed', '目标容器停止或自动重启策略尚未确认')
        }
        runtimePatch(desired, inspectContainer(name), { routing })
      }
      Object.assign(t, { state: 'applied', completed_at: new Date().toISOString() })
      release(project, id, t, (record) => {
        record.kernel_transition = t
        replaceSelection(record, t.target)
        record.status = stopAfterApply ? 'stopped' : t.previous_status
        record.runtime = { ...desired.runtime, stopped: !keepRunning }
        if (stopAfterApply) {
          migrateScheduleRecord(record)
          const operatorDisabled = record.schedule_off === true && record.schedule_off_reason === 'disabled'
          applyScheduleOff(record, true, { reason: record.schedule_off_reason || 'stopped' })
          if (operatorDisabled) record.schedule_off_reason = 'disabled'
        }
      })
      watchdog?.reset?.(id)
      return { ok: true, activated: true, transition: publicKernelTransition(getVm(project, id)) }
    }
    if (!t || terminal.has(t.state)) throw fail('kernel_transition_missing', '没有可回滚的切换')
    held = true
    await watchdog?.hold?.(id)
    if (action === 'finalize') {
      if (t.state !== 'applied') throw fail('kernel_transition_not_applied', '切换未完成，请先回滚')
      const backup = await inspect(vm, t.backup)
      if (backup) {
        if (backup.Id !== t.previous_container_id || backup.State.Running)
          throw fail('kernel_backup_mismatch', '回滚容器身份或状态不匹配')
        await docker(vm, ['rm', t.backup])
      }
      save(project, id, t, 'finalized')
      return { ok: true, transition: publicKernelTransition(getVm(project, id)) }
    }
    hold(project, id, t)
    const drained = await waitForSlotDrain(scheduler, [id])
    if (!drained.ok) {
      release(project, id, t)
      throw fail('slots_busy', '在途请求未结束，未回滚内核')
    }
    const currentContainer = await inspect(vm, t.container)
    const currentHealth = await transitionHealth(project, vm)
    if (
      vm.dataplane === 'hermit' &&
      t.state === 'applied' &&
      currentContainer?.State?.Running === true &&
      (currentHealth?.switch_ready !== true ||
        Number(currentHealth?.pending_tool_results) > 0 ||
        Number(currentHealth?.active_requests) > 0)
    ) {
      release(project, id, t)
      return {
        ok: false,
        code: 'kernel_tools_pending',
        error: '内核尚未确认工具结果已返回，未回滚内核',
        transition: publicKernelTransition(vm),
      }
    }
    rollbackStarted = true
    await restore(project, vm, t, routing)
    watchdog?.reset?.(id)
    return { ok: true, rolled_back: true, transition: publicKernelTransition(getVm(project, id)) }
  } catch (error) {
    if (rollbackStarted || (began && ['stopping', 'retaining', 'starting', 'checking', 'applied'].includes(t?.state))) {
      try {
        if (rollbackStarted) throw error
        await restore(project, vm, t, routing)
        watchdog?.reset?.(id)
      } catch (rollbackError) {
        const recoveryCode =
          typeof rollbackError?.code === 'string' && /^[a-zA-Z0-9_]{1,64}$/.test(rollbackError.code)
            ? rollbackError.code
            : 'kernel_rollback_failed'
        save(project, id, t, 'rollback_failed', { code: 'kernel_rollback_failed', recovery_code: recoveryCode })
        hold(project, id, t)
        return {
          ok: false,
          code: 'kernel_rollback_failed',
          error: '回滚未完成，槽位保持暂停。请重试回滚',
          transition: publicKernelTransition(getVm(project, id)),
        }
      }
    } else if (began && t?.state === 'prepared') {
      Object.assign(t, { state: 'rolled_back', code: error.code || 'kernel_transition_failed' })
      release(project, id, t, (record) => {
        record.kernel_transition = t
      })
    }
    return {
      ok: false,
      code: error.code || 'kernel_transition_failed',
      error:
        began && t?.state === 'rolled_back'
          ? `${error.code ? error.message : '目标内核切换失败'}；已恢复原内核`
          : error.code
            ? error.message
            : '内核切换失败，请检查容器和文件权限',
      transition: publicKernelTransition(getVm(project, id)),
    }
  } finally {
    if (held) watchdog?.release?.(id)
  }
}

async function restore(project, vm, t, routing) {
  save(project, vm.id, t, 'rolling_back')
  const old = await inspect(vm, t.backup)
  let current = await inspect(vm, t.container)
  // A crash can happen between rename and journal update. IDs establish ownership.
  if (old && old.Id !== t.previous_container_id) throw fail('kernel_backup_mismatch', '回滚容器身份不匹配')
  if (old?.State?.Running) throw fail('kernel_backup_busy', '旧容器仍在运行，不能回滚')
  if (t.previous_container_id && !old && current?.Id !== t.previous_container_id)
    throw fail('kernel_backup_missing', '回滚容器不存在')
  if (current && current.Id !== t.previous_container_id) {
    if (!t.candidate_container_id || current.Id !== t.candidate_container_id) {
      // Creation may finish before its ID is recorded. Require this slot's canonical label.
      if (
        current.Config?.Labels?.['kin.vm.id'] !== vm.id ||
        current.Config?.Labels?.['kin.vm.kernel-transition'] !== t.id
      )
        throw fail('kernel_candidate_mismatch', '目标容器身份不匹配')
    }
    const stopped = await stopHermitKernel(slotExec(project, vm))
    if (!stopped.ok) throw fail(stopped.reason, '目标内核停止尚未确认')
    await docker(vm, ['stop', '--time', '30', current.Id])
    const halted = await inspect(vm, current.Id)
    if (halted?.State?.Running) throw fail('kernel_stop_unconfirmed', '目标容器停止尚未确认')
    await clearStoppedKernelSocket(project, vm)
    await docker(vm, ['rm', current.Id])
    current = null
  }
  if (t.previous_container_id) {
    if (!current) {
      if (!old) throw fail('kernel_backup_missing', '回滚容器不存在')
      await docker(vm, ['rename', t.backup, t.container])
    } else if (current.Id !== t.previous_container_id) throw fail('kernel_backup_mismatch', '回滚容器身份不匹配')
    const restored = { ...getVm(project, vm.id) }
    replaceSelection(restored, t.previous)
    restored.proxy = vm.proxy
    // Commit the old selection before restarting; credentials are read from current files.
    patchVmRecord(project, vm.id, (record) => replaceSelection(record, t.previous))
    await docker(vm, ['update', `--restart=${t.restart_policy}`, t.container])
    if (t.previous_running) {
      if (!current?.State?.Running) await clearStoppedKernelSocket(project, vm)
      await docker(vm, ['start', t.container])
      const ready =
        resolveKernelDataplane(restored, routing) === 'hermit'
          ? await ensureHermitKernel(slotExec(project, restored))
          : await ensureSlotInferenceRuntime(restored, project, {
              routing: { ...routing, inference: { ...routing.inference, eager_start: true } },
            })
      if (!healthy(ready))
        throw fail(ready?.code || ready?.reason || 'kernel_rollback_health_failed', '旧内核未通过健康检查')
    }
  }
  Object.assign(t, { state: 'rolled_back', completed_at: new Date().toISOString() })
  release(project, vm.id, t, (record) => {
    record.kernel_transition = t
    replaceSelection(record, t.previous)
    record.status = t.previous_status
    const restored = { ...record, runtime: t.previous_runtime || record.runtime }
    runtimePatch(restored, inspectContainer(t.container), { routing })
    record.runtime = restored.runtime
  })
}
