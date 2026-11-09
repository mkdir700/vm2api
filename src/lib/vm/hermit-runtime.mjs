import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { kernelPackageRoot, inspectKernelPackage } from './kernel-packages.mjs'
import { runtimeKind } from './runtime-kind.mjs'
import { isCodexVm } from './vm-kind.mjs'
import { credentialModeOfVm, looksLikeConsoleApiKey } from '../oauth/credential-mode.mjs'
import { readWorkerCredentialFile, slotWorkerCredentialPath, runtimeFileOwner } from '../oauth/oauth-credentials.mjs'
import { readRoutingConfigFile } from '../core/config.mjs'
import { resolveSessionSlots, normalizeSessionIdleTtlSeconds } from './slot-engine.mjs'

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
const HERMIT_API_ORIGIN = 'https://api.anthropic.com'
const HERMIT_TOKEN_URL = 'https://platform.claude.com/v1/oauth/token'
function hermitUpstreamURLs() {
  const upstream = process.env.KIN_HERMIT_UPSTREAM_URL || HERMIT_API_ORIGIN
  const invalid = () =>
    Object.assign(new Error('Hermit 上游地址不符合固定 HTTPS 或回环实验要求'), {
      code: 'hermit_environment_unsupported',
    })
  if (upstream === HERMIT_API_ORIGIN) return { upstream, token: HERMIT_TOKEN_URL, https: true }
  let url
  try {
    url = new URL(upstream)
  } catch {
    throw invalid()
  }
  if (
    url.protocol !== 'http:' ||
    url.hostname !== '127.0.0.1' ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    upstream.includes('?') ||
    upstream.includes('#')
  )
    throw invalid()
  return { upstream, token: upstream.replace(/\/$/, '') + '/v1/oauth/token', https: false }
}
export function assertHermitActivation(vm, manifest) {
  if (isCodexVm(vm)) throw Object.assign(new Error('Codex 槽位不能选择 Hermit'), { code: 'hermit_codex_unsupported' })
  if (vm.node_id || runtimeKind(vm) !== 'docker')
    throw Object.assign(new Error('当前只验收本机 Docker 执行接口'), { code: 'hermit_placement_unsupported' })
  const laboratory = process.env.KIN_KERNEL_TEST_ENDPOINTS === '1' && !!process.env.KIN_HERMIT_UPSTREAM_URL
  if (
    !laboratory &&
    (manifest.acceptance !== 'production' ||
      manifest.capabilities.production !== true ||
      manifest.capabilities.helper_integration !== true ||
      manifest.capabilities.https_upstream !== true ||
      manifest.capabilities.switch_readiness !== true)
  ) {
    throw Object.assign(new Error('当前 Hermit 包只完成模拟验收，不能激活生产槽位'), {
      code: 'hermit_activation_unqualified',
    })
  }
  const urls = hermitUpstreamURLs()
  if (!laboratory && !urls.https)
    throw Object.assign(new Error('生产槽位需要固定 HTTPS 上游'), { code: 'hermit_environment_unsupported' })
  if (urls.https) hermitExtraCA()
  if (manifest.target !== 'linux-amd64')
    throw Object.assign(new Error('Hermit 实验环境不匹配'), { code: 'hermit_environment_unsupported' })
  if (urls.https && manifest.capabilities.https_upstream !== true)
    throw Object.assign(new Error('当前 Hermit 包没有固定 HTTPS 能力'), { code: 'hermit_https_unsupported' })
}
function hermitExtraCA() {
  const file = process.env.NODE_EXTRA_CA_CERTS
  if (!file) return null
  const invalid = () => Object.assign(new Error('Hermit CA 文件无效'), { code: 'hermit_ca_invalid' })
  try {
    const stat = fs.lstatSync(file)
    if (!path.isAbsolute(file) || path.normalize(file) !== file || !stat.isFile() || stat.size > 1024 * 1024)
      throw invalid()
    const data = fs.readFileSync(file)
    if (data.length > 1024 * 1024) throw invalid()
    const certificates = data.toString('utf8').match(/-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/g)
    if (!certificates?.length) throw invalid()
    for (const certificate of certificates) new crypto.X509Certificate(certificate)
    return data
  } catch {
    throw invalid()
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
export function writeHermitKernelConfig(project, vm, { force = false, routing } = {}) {
  const binding = hermitBinding(vm)
  const paths = hermitPackagePaths(project, binding)
  const manifest = JSON.parse(fs.readFileSync(path.join(paths.payload, 'manifest.json'), 'utf8'))
  const authentication = hermitAuthentication(project, vm, {
    allowOAuth: manifest.capabilities.helper_integration === true,
  })
  const urls = hermitUpstreamURLs()
  const ca = urls.https ? hermitExtraCA() : null
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
    const poolRouting =
      manifest.capabilities.native_session_pool === true ? routing || readRoutingConfigFile(project) : null
    if (ca) privateFile(path.join(runDir, 'native-ca.pem'), ca, vm)
    const body = {
      ...(manifest.capabilities.native_session_pool === true
        ? {
            session_capacity: resolveSessionSlots(
              { ...vm, kernel_package: { ...binding, native_session_pool: true } },
              poolRouting,
            ),
            session_idle_ttl_seconds: normalizeSessionIdleTtlSeconds(poolRouting.inference?.session_idle_ttl_seconds),
          }
        : {}),
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
          upstream_url: urls.upstream,
          environment: [...authentication.environment, ...(ca ? ['NODE_EXTRA_CA_CERTS=/run/kin/native-ca.pem'] : [])],
        },
      },
      ...(manifest.capabilities.helper_integration === true
        ? {
            helper: {
              credential_path: '/home/kincli/.claude/credentials.json',
              oauth_token_url: urls.token,
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
