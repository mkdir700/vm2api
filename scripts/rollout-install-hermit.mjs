import fs from 'node:fs'
import path from 'node:path'
import { pullHermitPackage } from '../src/lib/vm/hermit-release.mjs'
import { getKernelPackage, inspectKernelPackage } from '../src/lib/vm/kernel-packages.mjs'
import { isCodexVm } from '../src/lib/vm/vm-kind.mjs'
import { failure } from '../src/lib/rollout/protocol.mjs'

const [root, raw] = process.argv.slice(2)
const expected = JSON.parse(raw)
if (!/^[a-f0-9]{64}$/.test(expected.manifest_sha256 || '')) throw failure('fixed_manifest_required')
if (!path.isAbsolute(root)) throw failure('absolute_project_required')
const candidates = []
for (const name of fs.readdirSync(path.join(root, 'vms'))) {
  if (!/^vm-[A-Za-z0-9_-]+\.json$/.test(name)) continue
  const file = path.join(root, 'vms', name),
    vm = JSON.parse(fs.readFileSync(file))
  if (vm.status === 'deleted') continue
  if (isCodexVm(vm) || vm.node_id || (vm.runtime_type && vm.runtime_type !== 'docker'))
    throw failure('local_docker_claude_required')
  if (vm.kernel_transition && !['finalized', 'rolled_back'].includes(vm.kernel_transition.state))
    throw failure('unfinished_kernel_transition')
  candidates.push({ file, vm })
}
const installed = await pullHermitPackage(root, { version: expected.version, commit: expected.commit })
const selected = getKernelPackage(root).item
if (
  !selected ||
  selected.version !== expected.version ||
  (expected.manifest_sha256 && selected.manifest_sha256 !== expected.manifest_sha256)
)
  throw failure('installed_package_mismatch')
await inspectKernelPackage(root, selected)
// 发布器仅在独立候选组停止时调用。不能修改活动组或复制活动账号。
for (const { file, vm } of candidates) {
  vm.dataplane = 'hermit'
  vm.kernel_package = {
    runtime: 'hermit',
    target: selected.target,
    version: selected.version,
    manifest_sha256: selected.manifest_sha256,
  }
  const temporary = file + '.pending'
  fs.writeFileSync(temporary, JSON.stringify(vm, null, 2), { mode: 0o600 })
  fs.renameSync(temporary, file)
}
console.log(
  JSON.stringify({
    schema: 1,
    result: 'PASS',
    version: installed.version,
    commit: expected.commit,
    manifest_sha256: selected.manifest_sha256,
  }),
)
