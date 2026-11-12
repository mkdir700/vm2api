import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { Readable, Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import {
  describeKernelPayload,
  hasCustomKernelOverride,
  inspectLinuxAmd64Elf,
  wrapCliTemplateDir,
  WRAP_KERNEL_BIN,
  wrapKernelWrapperScript,
} from '../vm/wrap-cli-runtime.mjs'
import {
  fetchKernelReleaseMetadata,
  openKernelReleaseAsset,
  selectKernelAsset,
  selectCliNodeAsset,
  MAX_KERNEL_DOWNLOAD_BYTES,
  MAX_CLI_NODE_DOWNLOAD_BYTES,
} from './release-kernel.mjs'

const coded = (code, message) => Object.assign(new Error(message), { code })
function jsonFile(file, max = 64 * 1024) {
  const st = fs.lstatSync(file)
  if (!st.isFile() || st.size > max) throw coded('kernel_metadata_invalid', '内核元数据无效')
  return JSON.parse(fs.readFileSync(file, 'utf8'))
}
function elfFile(file) {
  const st = fs.lstatSync(file)
  if (!st.isFile() || !(st.mode & 0o111)) return false
  const fd = fs.openSync(file, 'r')
  try {
    const header = Buffer.alloc(64)
    return fs.readSync(fd, header, 0, 64, 0) === 64 && inspectLinuxAmd64Elf(header).ok
  } finally {
    fs.closeSync(fd)
  }
}
function releaseInfo(root) {
  try {
    return jsonFile(path.join(root, 'RELEASE.json'))
  } catch {
    return {}
  }
}
function publicProduct(id, ready, meta = {}, code) {
  const version = typeof meta.version === 'string' && meta.version.length <= 80 ? meta.version : null
  const updated =
    typeof meta.updated_at === 'string' && Number.isFinite(Date.parse(meta.updated_at)) ? meta.updated_at : null
  return {
    id,
    name: 'cli-node',
    ready,
    version,
    updated_at: updated,
    ...(!ready
      ? {
          code,
          error:
            code === 'kernel_cache_invalid'
              ? '内核缓存选择无效，请重新拉取'
              : 'cli-node 或 kin-kernel 未就绪，请重新拉取',
        }
      : {}),
  }
}

export function describeKernelCatalog(projectRoot) {
  let cli
  try {
    const root = wrapCliTemplateDir(projectRoot)
    let meta = releaseInfo(root)
    if (!meta.version) {
      try {
        const sample = jsonFile(path.join(root, 'SAMPLE.json'))
        meta = {
          version: /^v\d+\.\d+\.\d+$/.test(sample.release_tag) ? sample.release_tag.slice(1) : null,
          updated_at: sample.captured_at,
        }
      } catch {}
    }
    const ready = elfFile(describeKernelPayload(projectRoot).path) && elfFile(path.join(root, 'cli-node'))
    cli = publicProduct('cli-node', ready, meta, 'cli_node_package_missing')
  } catch (error) {
    cli = publicProduct(
      'cli-node',
      false,
      {},
      error.code === 'kernel_cache_invalid' ? error.code : 'cli_node_package_missing',
    )
  }
  return [cli]
}

function limitBytes(max, code, expected = 0) {
  let size = 0
  return new Transform({
    transform(chunk, encoding, done) {
      size += chunk.length
      done(size > max ? coded(code, '内核下载或解压大小超限') : null, chunk)
    },
    flush(done) {
      done(expected && size !== expected ? coded('kernel_size_mismatch', '内核下载大小不匹配') : null)
    },
  })
}
function responseBody(response, max, code) {
  const declared = Number(response.headers.get('content-length'))
  if (declared > max) throw coded(code, '内核下载大小超限')
  if (!response.body) throw coded('kernel_download_failed', '内核下载为空')
  return Readable.fromWeb(response.body)
}
async function downloadFile(asset, dest, max, fetchImpl) {
  const response = await openKernelReleaseAsset(asset.url, fetchImpl, asset.asset)
  await pipeline(
    responseBody(response, max, 'kernel_too_large'),
    limitBytes(max, 'kernel_too_large'),
    fs.createWriteStream(dest, { flags: 'wx', mode: 0o755 }),
  )
  if (asset.size && fs.statSync(dest).size !== asset.size) throw coded('kernel_size_mismatch', '内核下载大小不匹配')
  if (!elfFile(dest)) throw coded('kernel_not_elf', '内核不是 Linux amd64 ELF')
}

function makeReadonly(root) {
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    const file = path.join(root, entry.name)
    if (entry.isDirectory()) makeReadonly(file)
    else fs.chmodSync(file, fs.statSync(file).mode & 0o111 ? 0o555 : 0o444)
  }
  fs.chmodSync(root, 0o555)
}
function removeStaged(root) {
  if (!root || !fs.existsSync(root)) return
  fs.chmodSync(root, 0o755)
  for (const entry of fs.readdirSync(root, { withFileTypes: true }))
    if (entry.isDirectory()) removeStaged(path.join(root, entry.name))
  fs.rmSync(root, { recursive: true, force: true })
}
// Keep the current and immediately preceding snapshot, not an ever-growing
// download history. Cleanup is post-commit and can never turn success into an error.
function prunePackages(base, arch, current, previous) {
  try {
    for (const entry of fs.readdirSync(path.join(base, 'packages'), { withFileTypes: true })) {
      if (!entry.isDirectory() || !new RegExp(`^${arch}-[a-f0-9-]{36}$`).test(entry.name)) continue
      const relative = `packages/${entry.name}`
      if (relative !== current && relative !== previous) removeStaged(path.join(base, relative))
    }
  } catch {}
}

export async function pullKernelRelease(projectRoot, { kernel, tag = '' } = {}, { fetchImpl = globalThis.fetch } = {}) {
  if (kernel !== 'cli-node') return { ok: false, code: 'kernel_invalid', error: '请选择默认内核 cli-node' }
  let stage, published, lock, pointerTemp
  try {
    const payload = await fetchKernelReleaseMetadata({ tag, fetchImpl })
    const specs = [selectKernelAsset(payload), selectCliNodeAsset(payload)]
    for (const spec of specs) {
      if (!spec.ok) return spec
      if (payload.assets.filter((asset) => asset?.name === spec.asset).length !== 1)
        throw coded('kernel_asset_duplicate', 'Release 内核附件重复')
    }
    if (String(process.env.KIN_WRAP_CLI_ROOT || '').trim() || hasCustomKernelOverride(projectRoot))
      throw coded('kernel_override_active', '已配置显式内核路径，请先移除覆盖配置再拉取')
    const base = path.join(projectRoot, 'share/wrap-cli-releases')
    fs.mkdirSync(base, { recursive: true })
    lock = path.join(base, '.pull-lock')
    try {
      fs.mkdirSync(lock, { mode: 0o700 })
    } catch (error) {
      lock = null
      throw coded(
        error.code === 'EEXIST' ? 'kernel_pull_busy' : 'kernel_cache_unwritable',
        '内核缓存忙或不可写，请稍后重试',
      )
    }
    const packages = path.join(base, 'packages')
    fs.mkdirSync(packages, { recursive: true })
    if (fs.lstatSync(packages).isSymbolicLink()) throw coded('kernel_cache_invalid', '内核缓存不能是链接')
    stage = fs.mkdtempSync(path.join(packages, '.stage-'))
    const release = {
      tag: payload.tag_name,
      version: specs[0].version,
      asset: 'kin-kernel,cli-node',
    }
    const metadata = { ...release, updated_at: new Date().toISOString() }
    await downloadFile(specs[0], path.join(stage, WRAP_KERNEL_BIN), MAX_KERNEL_DOWNLOAD_BYTES, fetchImpl)
    await downloadFile(specs[1], path.join(stage, 'cli-node'), MAX_CLI_NODE_DOWNLOAD_BYTES, fetchImpl)
    fs.writeFileSync(path.join(stage, 'kin-kernel'), wrapKernelWrapperScript(), { mode: 0o755, flag: 'wx' })
    fs.writeFileSync(path.join(stage, 'RELEASE.json'), JSON.stringify(metadata), { flag: 'wx' })
    makeReadonly(stage)
    const relative = `packages/amd64-${crypto.randomUUID()}`
    published = path.join(base, relative)
    fs.renameSync(stage, published)
    stage = null
    const pointer = path.join(base, `current-amd64.json`)
    let previous
    try {
      previous = jsonFile(pointer, 4096).package
    } catch {}
    pointerTemp = `${pointer}.${crypto.randomUUID()}.tmp`
    fs.writeFileSync(pointerTemp, JSON.stringify({ package: relative, release, updated_at: metadata.updated_at }), {
      flag: 'wx',
      mode: 0o644,
    })
    const product = publicProduct(kernel, true, metadata)
    fs.renameSync(pointerTemp, pointer)
    pointerTemp = null
    published = null
    prunePackages(base, 'amd64', relative, previous)
    return { ok: true, kernel: product, release }
  } catch (error) {
    return {
      ok: false,
      code: typeof error.code === 'string' && /^[a-z][a-z0-9_]+$/.test(error.code) ? error.code : 'kernel_pull_failed',
      error: 'cli-node 拉取失败，原包未更改',
    }
  } finally {
    for (const dir of [stage, published]) {
      try {
        removeStaged(dir)
      } catch {}
    }
    if (pointerTemp) {
      try {
        fs.unlinkSync(pointerTemp)
      } catch {}
    }
    if (lock) {
      try {
        fs.rmdirSync(lock)
      } catch {}
    }
  }
}
