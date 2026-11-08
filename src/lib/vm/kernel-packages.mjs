import fs from 'node:fs'
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

export function listKernelPackages(project) {
  const base = path.join(kernelPackageRoot(project), 'versions')
  const items = []
  if (!fs.existsSync(base)) return { items }
  for (const runtime of fs.readdirSync(base))
    for (const target of fs.readdirSync(path.join(base, runtime))) {
      for (const version of fs.readdirSync(path.join(base, runtime, target))) {
        try {
          const dir = path.join(base, runtime, target, version)
          if (!fs.lstatSync(dir).isDirectory()) continue
          const receipt = JSON.parse(fs.readFileSync(path.join(dir, 'receipt.json'), 'utf8'))
          const manifest = JSON.parse(fs.readFileSync(path.join(dir, 'payload/manifest.json'), 'utf8'))
          items.push({
            ...receipt,
            capabilities: manifest.capabilities,
            acceptance: manifest.acceptance,
            validated_environment: manifest.validated_environment,
            cli: { version: manifest.cli.version, sha256: manifest.cli.sha256 },
          })
        } catch {
          /* 未完成的版本不进入目录。 */
        }
      }
    }
  return { items: items.sort((a, b) => a.runtime.localeCompare(b.runtime) || a.version.localeCompare(b.version)) }
}

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
