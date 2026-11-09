import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { spawn, execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { slotExecArgv, slotExecContainer } from '../vm/slot-exec.mjs'
import { slotHost } from '../vm/slot-host.mjs'
import { isDockerInspectNotFound } from '../vm/docker-container.mjs'
import { rustKernelHealth } from './rust-kernel-client.mjs'
import {
  assertHermitActivation,
  hermitAuthentication,
  resolveHermitPackage,
  writeHermitKernelConfig,
  HERMIT_GUEST_PACKAGES,
} from '../vm/hermit-runtime.mjs'

const execute = promisify(execFile)
const owners = new Map()
const starting = new Map()
const projectRootOf = (exec) => exec.projectRoot || (exec.homeDir ? path.resolve(exec.homeDir, '../../..') : null)
const key = (exec) => `${projectRootOf(exec)}:${exec.vmId || exec.vm?.id}`
export const hasHermitKernel = (exec) => owners.has(key(exec))
export const selectedHermit = (exec) => exec?.vm?.dataplane === 'hermit'

async function docker(vm, args) {
  const env = slotHost(vm).dockerEnv()
  return execute(process.env.KIN_DOCKER_BIN || 'docker', args, {
    timeout: 8000,
    maxBuffer: 65536,
    ...(env ? { env } : {}),
  })
}
export async function stopHermitKernel(exec, { timeoutMs = 20000 } = {}) {
  const entry = owners.get(key(exec))
  if (!entry) return { ok: true, reason: 'not_owned' }
  entry.child.stdin.end()
  const stopped = await Promise.race([
    entry.done.then(() => true),
    new Promise((resolve) => {
      const t = setTimeout(() => resolve(false), timeoutMs)
      t.unref?.()
    }),
  ])
  if (!stopped) return { ok: false, reason: 'hermit_stop_unconfirmed' }
  owners.delete(key(exec))
  return { ok: true, reason: 'lease_closed' }
}
export async function reloadHermitCredential(exec) {
  const ownerExec = {
    ...exec,
    projectRoot: exec.projectRoot || (exec.homeDir ? path.dirname(path.dirname(path.dirname(exec.homeDir))) : null),
  }
  if (!ownerExec.projectRoot) return { ok: false, reason: 'hermit_project_missing' }
  const stopped = await stopHermitKernel(ownerExec)
  if (!stopped.ok) return stopped
  return ensureHermitKernel(ownerExec)
}
export async function stopHermitSlot(vm) {
  const entries = [...owners.values()].filter((entry) => entry.exec.vm.id === vm.id)
  const results = await Promise.all(entries.map((entry) => stopHermitKernel(entry.exec)))
  return { ok: results.every((result) => result.ok) }
}
export async function stopAllHermitKernels() {
  return Promise.all([...owners.values()].map((entry) => stopHermitKernel(entry.exec)))
}
// The controller owns each stdin lease. Restore recorded-running owners before
// opening HTTP admission, including VMs paused by an upgrade's scheduling hold.
export async function restoreHermitKernels(projectRoot, vms) {
  const pending = (vm) =>
    vm.kernel_transition && !['applied', 'finalized', 'rolled_back'].includes(vm.kernel_transition.state)
  return Promise.all(
    vms
      .filter(
        (vm) =>
          vm.status === 'running' &&
          vm.dataplane === 'hermit' &&
          !vm.node_id &&
          !vm.migration_pending &&
          !['running', 'needs_attention'].includes(vm.slot_migration?.status) &&
          !pending(vm),
      )
      .map(async (vm) => {
        const result = await ensureHermitKernel({
          projectRoot,
          vmId: vm.id,
          vm,
          homeDir: path.join(projectRoot, 'vms', vm.id, 'cli-home'),
        })
        if (!result.ok) console.warn(`[hermit-startup] ${vm.id}: ${result.reason}`)
        return { vmId: vm.id, ...result }
      }),
  )
}
export function ensureHermitKernel(exec, opts = {}) {
  exec = { ...exec, projectRoot: projectRootOf(exec) }
  const id = key(exec)
  if (starting.has(id)) return starting.get(id).then(() => ensureHermitKernel(exec, opts))
  const promise = start(exec, opts).finally(() => starting.delete(id))
  starting.set(id, promise)
  return promise
}
async function start(exec, { timeoutMs = 15000 } = {}) {
  let spawned = false
  try {
    const vm = exec.vm
    const binding = vm.kernel_package
    const installed = await resolveHermitPackage(exec.projectRoot, binding)
    assertHermitActivation(vm, installed.manifest)
    const authentication = crypto
      .createHash('sha256')
      .update(
        hermitAuthentication(exec.projectRoot, vm, {
          allowOAuth: installed.manifest.capabilities.helper_integration === true,
        }).token,
      )
      .digest('hex')
    const existing = owners.get(key(exec))
    if (existing) {
      if (existing.authentication !== authentication) return { ok: false, reason: 'hermit_authentication_changed' }
      if (existing.manifest !== installed.manifest_sha256) return { ok: false, reason: 'hermit_version_busy' }
      const health = await rustKernelHealth(exec, { timeoutMs: 1000 })
      return { ok: health?.runtime_flavor === 'hermit' && health?.healthy !== false, reason: 'already_up', health }
    }
    const container = slotExecContainer(vm)
    let cmd
    try {
      cmd = JSON.parse((await docker(vm, ['inspect', '--format', '{{json .Config.Cmd}}', container])).stdout)
    } catch (error) {
      if (isDockerInspectNotFound(error)) return { ok: false, reason: 'hermit_holder_missing' }
      throw error
    }
    if (!Array.isArray(cmd) || cmd[0] !== 'sleep' || cmd[1] !== 'infinity')
      return { ok: false, reason: 'hermit_holder_required' }
    const init = JSON.parse((await docker(vm, ['inspect', '--format', '{{json .HostConfig.Init}}', container])).stdout)
    if (init !== true) return { ok: false, reason: 'hermit_init_required' }
    const mounts = JSON.parse((await docker(vm, ['inspect', '--format', '{{json .Mounts}}', container])).stdout)
    if (!mounts.some((m) => m.Destination === HERMIT_GUEST_PACKAGES && m.RW === false))
      return { ok: false, reason: 'hermit_package_mount_missing' }
    const preflight = `import platform,os,json,hashlib; print(json.dumps({'os':platform.freedesktop_os_release(),'libc':os.confstr('CS_GNU_LIBC_VERSION'),'arch':platform.machine(),'tmux':hashlib.file_digest(open('/usr/bin/tmux','rb'),'sha256').hexdigest()}))`
    let audit
    try {
      audit = JSON.parse((await docker(vm, slotExecArgv(vm, ['python3', '-c', preflight]))).stdout)
    } catch {
      return { ok: false, reason: 'hermit_guest_preflight_failed', error: '槽位缺少可验证的 Python 或 tmux 依赖' }
    }
    const env = installed.manifest.validated_environment
    if (
      audit.os.ID !== env.distribution ||
      audit.os.VERSION_ID !== env.version_id ||
      audit.libc !== env.libc ||
      audit.arch !== env.architecture ||
      audit.tmux !== installed.manifest.dependencies.tmux.sha256
    )
      return { ok: false, reason: 'hermit_guest_environment_mismatch' }
    const config = writeHermitKernelConfig(exec.projectRoot, vm, { force: true })
    const fd = fs.openSync(`${config.runDir}/hermit-stderr.log`, 'a', 0o600)
    const child = spawn(
      process.env.KIN_DOCKER_BIN || 'docker',
      slotExecArgv(vm, [config.guestBinary, '--mode', 'vm2api-slot', '--config', '/run/kin/native-slot.json'], {
        interactive: true,
        user: slotHost(vm).execUser(vm),
      }),
      {
        stdio: ['pipe', fd, fd],
        ...(slotHost(vm).dockerEnv() ? { env: slotHost(vm).dockerEnv() } : {}),
      },
    )
    fs.closeSync(fd)
    child.stdin.on('error', () => {})
    let finish
    const done = new Promise((resolve) => {
      finish = resolve
    })
    const entry = { child, done, exec, authentication, manifest: installed.manifest_sha256 }
    owners.set(key(exec), entry)
    spawned = true
    child.once('error', () => finish())
    child.once('close', () => {
      if (owners.get(key(exec)) === entry) owners.delete(key(exec))
      finish()
    })
    const until = Date.now() + timeoutMs
    while (Date.now() < until) {
      if (child.exitCode !== null || child.signalCode !== null) break
      const health = await rustKernelHealth(exec, { timeoutMs: 500 })
      if (health?.runtime_flavor === 'hermit' && health?.healthy !== false)
        return { ok: true, reason: 'started', health, manifest_sha256: installed.manifest_sha256 }
      await new Promise((resolve) => setTimeout(resolve, 50))
    }
    await stopHermitKernel(exec)
    return { ok: false, reason: 'hermit_health_timeout' }
  } catch (error) {
    if (spawned) await stopHermitKernel(exec)
    return {
      ok: false,
      reason: typeof error.code === 'string' ? error.code : 'hermit_start_failed',
      error: error.message,
    }
  }
}
