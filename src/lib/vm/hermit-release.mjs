import { createHash } from 'node:crypto'
import { installKernelPackage, MAX_KERNEL_PACKAGE_BYTES } from './kernel-packages.mjs'

const DEFAULT_ORIGIN = 'https://hermit-releases.truerouter.cc'
const SHA = /^[a-f0-9]{64}$/
const VERSION = /^[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?$/
const digest = (bytes) => createHash('sha256').update(bytes).digest('hex')
const failure = (code, message, status = 502) => Object.assign(new Error(message), { code, status })
const invalid = () => failure('hermit_release_invalid', 'Hermit 发布信息无效，请稍后重试')

function releaseOrigin() {
  const value = process.env.KIN_HERMIT_RELEASES_URL || DEFAULT_ORIGIN
  let url
  try {
    url = new URL(value)
  } catch {
    throw invalid()
  }
  const loopback =
    process.env.KIN_KERNEL_TEST_ENDPOINTS === '1' && url.protocol === 'http:' && url.hostname === '127.0.0.1'
  if (
    (!loopback && url.protocol !== 'https:') ||
    url.username ||
    url.password ||
    url.pathname !== '/' ||
    url.search ||
    url.hash
  )
    throw failure('hermit_release_origin_invalid', 'Hermit 发布源配置无效', 500)
  return url.origin
}

async function download(url, limit, timeout, fetchImpl) {
  const response = await fetchImpl(url, {
    redirect: 'error',
    signal: AbortSignal.timeout(timeout),
    headers: { 'User-Agent': 'vm2api-hermit-installer/1.0' },
  })
  if (response.status !== 200 || response.redirected || (response.url && response.url !== url)) {
    await response.body?.cancel()
    throw failure('hermit_release_unavailable', '无法获取 Hermit 发布文件，请稍后重试')
  }
  if (Number(response.headers.get('content-length')) > limit) {
    await response.body?.cancel()
    throw failure('hermit_release_too_large', 'Hermit 发布文件超过大小限制')
  }
  if (!response.body) throw invalid()
  const chunks = []
  let size = 0
  for await (const chunk of response.body) {
    size += chunk.length
    if (size > limit) throw failure('hermit_release_too_large', 'Hermit 发布文件超过大小限制')
    chunks.push(chunk)
  }
  return Buffer.concat(chunks, size)
}

function parse(bytes) {
  try {
    return JSON.parse(bytes.toString('utf8'))
  } catch {
    throw invalid()
  }
}

function validArchive(archive, name) {
  return (
    archive?.name === name &&
    SHA.test(archive.sha256 || '') &&
    Number.isSafeInteger(archive.bytes) &&
    archive.bytes > 0 &&
    archive.bytes <= MAX_KERNEL_PACKAGE_BYTES
  )
}

export async function pullHermitPackage(project, { fetchImpl = globalThis.fetch } = {}) {
  try {
    const origin = releaseOrigin()
    const latest = parse(await download(origin + '/v1/releases/latest', 65536, 15000, fetchImpl))
    if (
      !latest ||
      latest.schema_version !== 1 ||
      typeof latest.version !== 'string' ||
      latest.version.length > 79 ||
      !VERSION.test(latest.version) ||
      latest.target !== 'linux-amd64' ||
      !/^[a-f0-9]{40}$/.test(latest.commit || '')
    )
      throw invalid()
    const base = `${origin}/v1/releases/${latest.version}`
    const name = `hermit-${latest.version}-linux-amd64.tar.gz`
    if (
      latest.release_url !== base + '/release.json' ||
      latest.download_url !== base + '/download' ||
      latest.manifest_url !== base + '/manifest.json' ||
      !validArchive(latest.archive, name) ||
      !SHA.test(latest.release_sha256 || '') ||
      !SHA.test(latest.manifest_sha256 || '')
    )
      throw invalid()
    const raw = await download(latest.release_url, 65536, 15000, fetchImpl)
    if (digest(raw) !== latest.release_sha256) throw failure('hermit_release_integrity', 'Hermit 发布清单摘要不匹配')
    const receipt = parse(raw)
    if (
      !receipt ||
      receipt.schema_version !== 1 ||
      receipt.version !== latest.version ||
      receipt.target !== latest.target ||
      receipt.activated !== false ||
      !validArchive(receipt.archive, name) ||
      receipt.archive.bytes !== latest.archive.bytes ||
      receipt.archive.sha256 !== latest.archive.sha256 ||
      receipt.manifest_sha256 !== latest.manifest_sha256
    )
      throw invalid()
    const bytes = await download(latest.download_url, receipt.archive.bytes, 120000, fetchImpl)
    if (bytes.length !== receipt.archive.bytes || digest(bytes) !== receipt.archive.sha256)
      throw failure('hermit_release_integrity', 'Hermit 内核包大小或摘要不匹配')
    return await installKernelPackage(project, bytes, {
      ...receipt.archive,
      manifest_sha256: receipt.manifest_sha256,
    })
  } catch (error) {
    if (error.name === 'TimeoutError' || error.name === 'AbortError')
      throw failure('hermit_release_timeout', 'Hermit 下载超时，请稍后重试', 504)
    if (error.code) throw error
    throw failure('hermit_release_download_failed', 'Hermit 远程下载失败，请稍后重试')
  }
}
