import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { kernelPackageRoot, inspectKernelPackage } from './kernel-packages.mjs'
import { runtimeKind } from './runtime-kind.mjs'
import { isCodexVm } from './vm-kind.mjs'
import { credentialModeOfVm, looksLikeConsoleApiKey } from '../oauth/credential-mode.mjs'
import { readWorkerCredentialFile, slotWorkerCredentialPath, runtimeFileOwner } from '../oauth/oauth-credentials.mjs'

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
  if (process.env.KIN_KERNEL_TEST_ENDPOINTS !== '1' || !process.env.KIN_HERMIT_UPSTREAM_URL) {
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
export function hermitAuthentication(project, vm, { allowOAuth = false } = {}) {
  const invalid = () =>
    Object.assign(new Error('Hermit 槽位 API Key 凭据无效；请修正凭据后重启槽位'), {
      code: 'hermit_authentication_invalid',
    })
  const home = path.join(project, 'vms', vm.id, 'cli-home')
  const file = slotWorkerCredentialPath(home)
  const selected = credentialModeOfVm(vm) === 'apikey'
  let doc
  try {
    const stat = fs.lstatSync(file)
    if (!stat.isFile() || stat.size > 65536 || ![0o400, 0o444, 0o600].includes(stat.mode & 0o777)) throw invalid()
    doc = JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch (error) {
    if (error.code !== 'ENOENT' || selected) throw invalid()
  }
  if (selected || doc?.type === 'apikey' || doc?.anthropicApiKey) {
    const cred = readWorkerCredentialFile(home)
    const baseUrl = doc?.anthropicApiKey?.baseUrl || doc?.anthropicApiKey?.base_url || 'https://api.anthropic.com'
    if (
      !cred ||
      cred.type !== 'apikey' ||
      cred.auth_scheme !== 'x_api_key' ||
      !looksLikeConsoleApiKey(cred.api_key) ||
      /[\s\x00-\x1f\x7f]/.test(cred.api_key) ||
      doc?.claudeAiOauth ||
      doc?.refresh_token ||
      doc?.refreshToken ||
      baseUrl !== 'https://api.anthropic.com'
    )
      throw invalid()
    return { token: cred.api_key, environment: ['ANTHROPIC_API_KEY=' + cred.api_key] }
  }
  if (allowOAuth && doc?.claudeAiOauth) {
    const cred = readWorkerCredentialFile(home)
    const access = cred?.access_token || ''
    const refresh = cred?.refresh_token || ''
    if (
      (!access && !refresh) ||
      (access && !access.startsWith('sk-ant-oat01-')) ||
      /[\s\x00-\x1f\x7f]/.test(access + refresh)
    )
      throw invalid()
    return { token: access, environment: access ? ['CLAUDE_CODE_OAUTH_TOKEN=' + access] : [], oauth: true }
  }
  // 兼容原隔离实验。此分支不读取或转发 OAuth 令牌。
  const key = process.env.KIN_HERMIT_API_KEY || ''
  if (process.env.KIN_KERNEL_TEST_ENDPOINTS !== '1' || !key || /[\s\x00-\x1f\x7f]/.test(key)) throw invalid()
  return { token: key, environment: ['ANTHROPIC_API_KEY=' + key] }
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
  const authentication = hermitAuthentication(project, vm, {
    allowOAuth: manifest.capabilities.helper_integration === true,
  })
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
          environment: authentication.environment,
        },
      },
      ...(manifest.capabilities.helper_integration === true
        ? {
            helper: {
              credential_path: '/home/kincli/.claude/credentials.json',
              oauth_token_url:
                (process.env.KIN_HERMIT_UPSTREAM_URL || 'http://127.0.0.1:1').replace(/\/$/, '') + '/v1/oauth/token',
            },
          }
        : {}),
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
