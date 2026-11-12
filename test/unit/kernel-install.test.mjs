import test, { after, before } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { installKernelTargets, releaseKernelInstallSafetyHold } from '../../src/lib/vm/kernel-install.mjs'
import { getVm } from '../../src/lib/vm/vm-registry.mjs'
import { withVmLock } from '../../src/lib/vm/vm-file.mjs'

const savedEnv = Object.fromEntries(
  ['KIN_SLOT_RUN_ROOT', 'KIN_WRAP_CLI_ROOT', 'KIN_KERNEL_BIN', 'KIN_NATIVE_CLI_ROOT'].map((key) => [
    key,
    process.env[key],
  ]),
)
before(() => {
  for (const key of Object.keys(savedEnv)) delete process.env[key]
})
after(() => {
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value == null) delete process.env[key]
    else process.env[key] = value
  }
})

function elf(payload) {
  const bytes = Buffer.alloc(96 + Buffer.byteLength(payload))
  bytes.set([0x7f, 0x45, 0x4c, 0x46, 2, 1, 1])
  bytes.writeUInt16LE(3, 16)
  bytes.writeUInt16LE(62, 18)
  bytes.writeUInt32LE(1, 20)
  bytes.write(payload, 96)
  return bytes
}
function fixture(t, patch = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kernel-install-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const run = path.join(root, 'linux-private-run', 'vm-13')
  const vm = {
    id: 'vm-13',
    status: 'running',
    dataplane: 'wrap',
    timezone: 'UTC',
    runtime: { type: 'docker', worker_run_dir: run },
    fingerprint: { hostname: 'existing-computer' },
    seed_policy: { telemetry: false },
    claude: { account_uuid: 'existing-account' },
    ...patch,
  }
  fs.mkdirSync(path.join(root, 'vms', vm.id, 'cli-home', '.kin'), { recursive: true })
  fs.writeFileSync(path.join(root, 'vms', `${vm.id}.json`), JSON.stringify(vm))
  const home = path.join(root, 'vms', vm.id, 'cli-home')
  fs.mkdirSync(path.join(home, '.claude'), { recursive: true })
  fs.writeFileSync(path.join(home, '.claude', 'credentials.json'), 'protected-credential')
  fs.writeFileSync(path.join(home, '.kin', 'kin-kernel.bin'), 'previous-kernel')
  fs.writeFileSync(path.join(home, 'workspace.txt'), 'protected-workspace')
  const cli = path.join(root, 'share', 'wrap-cli')
  fs.mkdirSync(cli, { recursive: true })
  fs.writeFileSync(path.join(cli, 'cli-node'), elf('free-cli'), { mode: 0o755 })
  fs.writeFileSync(path.join(cli, 'kin-kernel.bin'), elf('free-kernel'), { mode: 0o755 })
  return { root, vm, home, run }
}
const target = (kernel = 'cli-node') => [{ id: 'vm-13', kernel }]
function lifecycle(root, extra = {}) {
  let stopCount = 0
  return {
    ops: {
      stopSlot(vm) {
        stopCount++
        assert.equal(getVm(root, vm.id).status, 'running')
        return { ok: true, runtime: { ...vm.runtime, stopped: true } }
      },
      suspendVmRuntimeRestart(vm) {
        assert.equal(getVm(root, vm.id).status, 'stopped')
        return { ok: true }
      },
      ...extra,
    },
    stops: () => stopCount,
  }
}

test('VM lock and watchdog drain complete before stop; newer credentials are preserved', async (t) => {
  const { root, vm } = fixture(t)
  const file = path.join(root, 'vms', `${vm.id}.json`)
  let unlock, finishRestart, heldResolve
  const lockWait = new Promise((resolve) => {
    unlock = resolve
  })
  const draining = new Promise((resolve) => {
    finishRestart = resolve
  })
  const held = new Promise((resolve) => {
    heldResolve = resolve
  })
  let stops = 0
  const writer = withVmLock(file, async () => {
    await lockWait
    const current = JSON.parse(fs.readFileSync(file))
    current.claude.account_uuid = 'newer-account'
    fs.writeFileSync(file, JSON.stringify(current))
  })
  const operation = installKernelTargets({
    projectRoot: root,
    targets: target('cli-node'),
    watchdog: {
      hold() {
        heldResolve()
        return draining
      },
      release() {},
      reset() {
        assert.fail('no reset')
      },
    },
    ops: {
      stopSlot(current) {
        stops++
        assert.equal(current.claude.account_uuid, 'newer-account')
        return { ok: true }
      },
      suspendVmRuntimeRestart: () => ({ ok: true }),
    },
  })
  assert.equal(stops, 0)
  unlock()
  await writer
  await held
  assert.equal(stops, 0, 'in-flight watchdog restart still owns the runtime')
  finishRestart()
  const result = await operation
  assert.equal(result.ok, true, JSON.stringify(result))
  assert.equal(stops, 1)
  assert.equal(getVm(root, vm.id).claude.account_uuid, 'newer-account')
})

test('a failed stop leaves the previous record and package untouched and releases the watchdog', async (t) => {
  const { root, vm, home } = fixture(t)
  const before = fs.readFileSync(path.join(root, 'vms', `${vm.id}.json`))
  let released = false
  const result = await installKernelTargets({
    projectRoot: root,
    targets: target('cli-node'),
    watchdog: {
      hold() {},
      release() {
        released = true
      },
    },
    ops: {
      stopSlot: () => ({ ok: false, error: 'stop denied' }),
      materializeResolvedKernel() {
        assert.fail('cannot replace a running kernel')
      },
    },
  })
  assert.equal(result.ok, false)
  assert.equal(result.items[0].stopped, false)
  assert.equal(result.items[0].code, 'kernel_stop_failed')
  assert.equal(released, true)
  assert.deepEqual(fs.readFileSync(path.join(root, 'vms', `${vm.id}.json`)), before)
  assert.equal(fs.readFileSync(path.join(home, '.kin', 'kin-kernel.bin'), 'utf8'), 'previous-kernel')
})

test('package publication during asynchronous stop reports the version actually materialized', async (t) => {
  const { root, vm, home } = fixture(t)
  const cli = path.join(root, 'share', 'wrap-cli')
  fs.writeFileSync(path.join(cli, 'RELEASE.json'), JSON.stringify({ version: '1.0.0' }))
  const life = lifecycle(root, {
    async stopSlot() {
      await Promise.resolve()
      fs.writeFileSync(path.join(cli, 'RELEASE.json'), JSON.stringify({ version: '2.0.0' }))
      fs.writeFileSync(path.join(cli, 'kin-kernel.bin'), elf('new-publication'))
      return { ok: true }
    },
  })
  const result = await installKernelTargets({ projectRoot: root, targets: target('cli-node'), ops: life.ops })
  assert.equal(result.ok, true, JSON.stringify(result))
  assert.equal(result.items[0].version, '2.0.0')
  assert.equal(getVm(root, vm.id).kernel_installation.version, '2.0.0')
  assert.ok(fs.readFileSync(path.join(home, '.kin', 'kin-kernel.bin')).equals(elf('new-publication')))
})

test('failed STOPPED persistence keeps the watchdog held rather than reviving stale running intent', async (t) => {
  const { root, vm, home } = fixture(t)
  const file = path.join(root, 'vms', `${vm.id}.json`)
  const rename = fs.renameSync
  let released = false
  const watchdog = {
    hold() {},
    release() {
      released = true
    },
  }
  fs.renameSync = (from, to) => {
    if (to === file) throw Object.assign(new Error('fixture record permission failure'), { code: 'EACCES' })
    return rename(from, to)
  }
  try {
    const result = await installKernelTargets({
      projectRoot: root,
      targets: target('cli-node'),
      watchdog,
      ops: {
        stopSlot: () => ({ ok: true }),
        materializeResolvedKernel() {
          assert.fail('cannot replace before stopped intent is durable')
        },
      },
    })
    assert.equal(result.ok, false)
    assert.equal(result.items[0].stopped, true)
    assert.equal(result.items[0].code, 'kernel_stop_persist_failed')
    assert.equal(released, false)
    assert.equal(fs.readFileSync(path.join(home, '.kin', 'kin-kernel.bin'), 'utf8'), 'previous-kernel')
  } finally {
    fs.renameSync = rename
  }
  assert.equal(releaseKernelInstallSafetyHold(root + '-different-project', vm.id, watchdog), false)
  assert.equal(
    releaseKernelInstallSafetyHold(root, vm.id, {
      release() {
        assert.fail('foreign watchdog hold')
      },
    }),
    false,
  )
  const failedRetry = await installKernelTargets({
    projectRoot: root,
    targets: target('cli-node'),
    watchdog,
    ops: {
      stopSlot: () => ({ ok: false, error: 'retry stop denied' }),
    },
  })
  assert.equal(failedRetry.ok, false)
  assert.equal(released, false, 'an unsuccessful retry cannot clear an inherited installer safety hold')
  const retry = await installKernelTargets({
    projectRoot: root,
    targets: target('cli-node'),
    watchdog,
    ops: lifecycle(root).ops,
  })
  assert.equal(retry.ok, true, JSON.stringify(retry))
  assert.equal(released, true, 'successful explicit installation releases its inherited safety hold')
  assert.equal(
    releaseKernelInstallSafetyHold(root, vm.id, watchdog),
    false,
    'no generic watchdog release once installer hold is gone',
  )
})
