import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { kernelPackageRoot, inspectKernelPackage } from './kernel-packages.mjs'
import { runtimeKind } from './runtime-kind.mjs'
import { isCodexVm } from './vm-kind.mjs'
import { runtimeFileOwner } from '../oauth/oauth-credentials.mjs'

export const HERMIT_GUEST_PACKAGES = '/opt/kin-kernel-packages'
const name = (value) => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9.+-]{0,79}$/.test(value)
export function hermitBinding(vm) {
  return vm?.kernel_package || null
}
export function hermitPackagePaths(project, binding) {
  if (
    binding?.runtime !== 'hermit' ||
    !['linux-amd64', 'darwin-arm64'].includes(binding.target) ||
    !name(binding.version)
  ) {
    throw Object.assign(new Error('Hermit 版本选择无效'), { code: 'invalid_kernel_binding' })
  }
  const relative = `versions/hermit/${binding.target}/${binding.version}/payload`
  return { payload: path.join(kernelPackageRoot(project), relative), guest: `${HERMIT_GUEST_PACKAGES}/${relative}` }
}
export async function resolveHermitPackage(project, binding) {
  const result = await inspectKernelPackage(project, binding)
  if (binding.manifest_sha256 && binding.manifest_sha256 !== result.manifest_sha256)
    throw Object.assign(new Error('版本清单摘要已改变'), { code: 'kernel_binding_mismatch' })
  return result
}
export function assertHermitActivation(vm, manifest) {
  if (isCodexVm(vm)) throw Object.assign(new Error('Codex 槽位不能选择 Hermit'), { code: 'hermit_codex_unsupported' })
  if (vm.node_id || runtimeKind(vm) !== 'docker')
    throw Object.assign(new Error('当前只验收本机 Docker 执行接口'), { code: 'hermit_placement_unsupported' })
  // 当前生产认证、原生上游和 helper 均未验收。实验开关只用于隔离测试。
  if (
    process.env.KIN_KERNEL_TEST_ENDPOINTS !== '1' ||
    !process.env.KIN_HERMIT_API_KEY ||
    !process.env.KIN_HERMIT_UPSTREAM_URL
  ) {
    throw Object.assign(new Error('当前 Hermit 包只完成模拟验收，不能激活生产槽位'), {
      code: 'hermit_activation_unqualified',
    })
  }
  const url = new URL(process.env.KIN_HERMIT_UPSTREAM_URL)
  if (
    url.protocol !== 'http:' ||
    url.hostname !== '127.0.0.1' ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    manifest.target !== 'linux-amd64'
  ) {
    throw Object.assign(new Error('Hermit 实验环境不匹配'), { code: 'hermit_environment_unsupported' })
  }
}
function privateFile(file, body, vm) {
  fs.writeFileSync(file, body, { mode: 0o600 })
  fs.chmodSync(file, 0o600)
  try {
    const owner = runtimeFileOwner(vm)
    if (process.getuid?.() === 0) fs.chownSync(file, owner.uid, owner.gid)
  } catch {}
}
export function writeHermitKernelConfig(project, vm, { force = false } = {}) {
  const binding = hermitBinding(vm)
  const paths = hermitPackagePaths(project, binding)
  const manifest = JSON.parse(fs.readFileSync(path.join(paths.payload, 'manifest.json'), 'utf8'))
  const runDir = vm.runtime?.worker_run_dir || path.join(project, 'vms', vm.id, 'run')
  fs.mkdirSync(runDir, { recursive: true, mode: 0o700 })
  fs.chmodSync(runDir, 0o700)
  try {
    const owner = runtimeFileOwner(vm)
    if (process.getuid?.() === 0) fs.chownSync(runDir, owner.uid, owner.gid)
  } catch {}
  const tokenPath = path.join(runDir, 'internal.token')
  const configPath = path.join(runDir, 'native-slot.json')
  let token
  try {
    token = fs.readFileSync(tokenPath, 'utf8').trim()
  } catch {}
  if (!token) token = crypto.randomBytes(32).toString('hex')
  privateFile(tokenPath, token + '\n', vm)
  if (force || !fs.existsSync(configPath)) {
    const root = `/run/kin/h-${crypto.randomBytes(5).toString('hex')}`
    const body = {
      session: {
        root,
        managed: {
          native_binary: `${HERMIT_GUEST_PACKAGES}/cli/${manifest.cli.sha256}/claude`,
          native_sha256: manifest.cli.sha256,
          tmux_binary: '/usr/bin/tmux',
          tmux_sha256: manifest.dependencies.tmux.sha256,
          hook_directory: `${paths.guest}/hooks`,
          hook_sha256: Object.fromEntries(
            Object.entries(manifest.files)
              .filter(([n]) => n.startsWith('hooks/'))
              .map(([n, m]) => [path.basename(n), m.sha256]),
          ),
          upstream_url: process.env.KIN_HERMIT_UPSTREAM_URL || 'http://127.0.0.1:1',
          environment: ['ANTHROPIC_API_KEY=' + (process.env.KIN_HERMIT_API_KEY || '')],
        },
      },
      socket: '/run/kin/kernel.sock',
      internal_token: token,
    }
    privateFile(configPath, JSON.stringify(body, null, 2) + '\n', vm)
  }
  return {
    runDir,
    configPath,
    tokenPath,
    socketPath: path.join(runDir, 'kernel.sock'),
    manifest,
    guestBinary: `${paths.guest}/bin/hermit`,
  }
}
