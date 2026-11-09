import fs from 'node:fs'
import crypto from 'node:crypto'
import path from 'node:path'
import os from 'node:os'
import { fileURLToPath } from 'node:url'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const execute = promisify(execFile)
const helper = fileURLToPath(new URL('../../../scripts/kernel-package.py', import.meta.url))
export const MAX_KERNEL_PACKAGE_BYTES = 64 * 1024 * 1024
export const kernelPackageRoot = (project) => path.join(project, 'share/kernel-packages')

async function run(args) {
  let stdout
  try {
    ;({ stdout } = await execute(process.env.KIN_PYTHON_BIN || 'python3', [helper, ...args], {
      timeout: 120000,
      maxBuffer: 1024 * 1024,
    }))
  } catch (error) {
    stdout = error.stdout
    if (!stdout) throw Object.assign(new Error('内核包安装进程失败'), { code: 'package_helper_failed' })
  }
  const result = JSON.parse(stdout)
  if (!result.ok) throw Object.assign(new Error(result.error.message), { code: result.error.code })
  return result.data
}

export async function installKernelPackage(project, bytes, expected) {
  if (
    !/^[a-f0-9]{64}$/.test(expected.sha256 || '') ||
    !/^[a-f0-9]{64}$/.test(expected.manifest_sha256 || '') ||
    !Number.isSafeInteger(expected.bytes) ||
    expected.bytes !== bytes.length ||
    bytes.length > MAX_KERNEL_PACKAGE_BYTES
  ) {
    throw Object.assign(new Error('归档大小或摘要参数无效'), { code: 'invalid_package_receipt' })
  }
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-package-'))
  try {
    const archive = path.join(temporary, 'archive.tar.gz')
    fs.writeFileSync(archive, bytes, { mode: 0o600 })
    return await run([
      'install',
      '--root',
      kernelPackageRoot(project),
      '--archive',
      archive,
      '--sha256',
      expected.sha256,
      '--manifest-sha256',
      expected.manifest_sha256,
      '--bytes',
      String(expected.bytes),
      ...(process.env.KIN_KERNEL_TEST_ENDPOINTS === '1' ? ['--allow-loopback'] : []),
    ])
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true })
  }
}

export function getKernelPackage(project) {
  const root = kernelPackageRoot(project)
  const pointer = path.join(root, 'current.json')
  try {
    if (!fs.existsSync(pointer) && !fs.lstatSync(pointer, { throwIfNoEntry: false })) return { item: null }
    const stat = fs.lstatSync(pointer)
    if (!stat.isFile() || stat.size > 65536) throw new Error('pointer')
    const current = JSON.parse(fs.readFileSync(pointer, 'utf8'))
    if (
      current.runtime !== 'hermit' ||
      !['linux-amd64', 'darwin-arm64'].includes(current.target) ||
      !/^[A-Za-z0-9][A-Za-z0-9.+-]{0,79}$/.test(current.version || '') ||
      !/^[a-f0-9]{64}$/.test(current.manifest_sha256 || '')
    )
      throw new Error('identity')
    const dir = path.join(root, 'versions/hermit', current.target, current.version)
    for (const file of [
      path.join(root, 'versions'),
      path.join(root, 'versions/hermit'),
      path.dirname(dir),
      dir,
      path.join(dir, 'payload'),
    ]) {
      if (!fs.lstatSync(file).isDirectory()) throw new Error('directory')
    }
    const manifestPath = path.join(dir, 'payload/manifest.json')
    if (!fs.lstatSync(manifestPath).isFile()) throw new Error('manifest')
    const raw = fs.readFileSync(manifestPath)
    if (raw.length > 65536 || crypto.createHash('sha256').update(raw).digest('hex') !== current.manifest_sha256)
      throw new Error('digest')
    const manifest = JSON.parse(raw)
    if (
      manifest.runtime !== current.runtime ||
      manifest.target !== current.target ||
      manifest.version !== current.version
    )
      throw new Error('manifest identity')
    return {
      item: {
        ...current,
        capabilities: manifest.capabilities,
        acceptance: manifest.acceptance,
        validated_environment: manifest.validated_environment,
        cli: { version: manifest.cli.version, sha256: manifest.cli.sha256 },
      },
    }
  } catch {
    throw Object.assign(new Error('当前 Hermit 内核包无效，请重新上传'), { code: 'invalid_current_package' })
  }
}

export const collectKernelPackages = (project) => run(['prune', '--root', kernelPackageRoot(project)])

export const inspectKernelPackage = (project, binding) =>
  run([
    'inspect',
    '--root',
    kernelPackageRoot(project),
    '--runtime',
    binding.runtime,
    '--target',
    binding.target,
    '--version',
    binding.version,
  ])
