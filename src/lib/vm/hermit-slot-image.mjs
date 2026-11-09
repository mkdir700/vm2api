import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { imageForKernel } from './os-catalog.mjs'

const execute = promisify(execFile)
const preparing = new Map()
const auditScript =
  "import platform,os,json,hashlib; print(json.dumps({'os':platform.freedesktop_os_release(),'libc':os.confstr('CS_GNU_LIBC_VERSION'),'arch':platform.machine(),'tmux':hashlib.file_digest(open('/usr/bin/tmux','rb'),'sha256').hexdigest()}))"
const fail = (code, message) => Object.assign(new Error(message), { code })

async function docker(args, timeout = 30000) {
  return (
    await execute(process.env.KIN_DOCKER_BIN || 'docker', args, {
      timeout,
      maxBuffer: 4 * 1024 * 1024,
    })
  ).stdout.trim()
}
async function imageId(ref) {
  try {
    const id = await docker(['image', 'inspect', '--format', '{{.Id}}', ref])
    return /^sha256:[a-f0-9]{64}$/.test(id) ? id : null
  } catch {
    return null
  }
}
async function qualified(image, manifest) {
  if (!image) return false
  try {
    const audit = JSON.parse(
      await docker([
        'run',
        '--rm',
        '--pull=never',
        '--network',
        'none',
        '--read-only',
        '--cap-drop',
        'ALL',
        '--security-opt',
        'no-new-privileges',
        '--entrypoint',
        'python3',
        image,
        '-c',
        auditScript,
      ]),
    )
    const env = manifest.validated_environment
    return (
      audit.os.ID === env.distribution &&
      audit.os.VERSION_ID === env.version_id &&
      audit.libc === env.libc &&
      audit.arch === env.architecture &&
      audit.tmux === manifest.dependencies.tmux.sha256
    )
  } catch {
    return false
  }
}

// Prepare outside the slot lifecycle. Never modify a running container or a registry tag.
export function prepareHermitSlotImage(kernel, { manifest }) {
  const task = `${kernel}:${JSON.stringify([manifest.validated_environment, manifest.dependencies.tmux])}`
  if (preparing.has(task)) return preparing.get(task)
  const promise = prepare(kernel, manifest).finally(() => preparing.delete(task))
  preparing.set(task, promise)
  return promise
}
async function prepare(kernel, manifest) {
  if (kernel !== 'ubuntu-24.04' || manifest.target !== 'linux-amd64')
    throw fail('hermit_guest_environment_mismatch', 'Hermit 需要 Linux AMD64 Ubuntu 24.04 槽位镜像')
  const dir = fileURLToPath(new URL('../../../docker/kin-os/ubuntu-24.04', import.meta.url))
  let source
  try {
    source = fs.readFileSync(path.join(dir, 'Dockerfile'))
  } catch {
    throw fail('hermit_guest_build_context_missing', '缺少 Hermit 槽位镜像构建文件')
  }
  const digest = crypto
    .createHash('sha256')
    .update(source)
    .update(JSON.stringify([manifest.validated_environment, manifest.dependencies.tmux]))
    .digest('hex')
  const tag = `local/vm2api-hermit-guest:${digest}`
  let image = await imageId(tag)
  if (await qualified(image, manifest)) return { ok: true, image, action: 'present' }
  image = await imageId(imageForKernel(kernel))
  if (await qualified(image, manifest)) return { ok: true, image, action: 'present' }
  try {
    await docker(['build', '--platform', 'linux/amd64', '-t', tag, dir], 900000)
  } catch {
    throw fail('hermit_guest_build_failed', 'Hermit 槽位镜像构建失败；原内核未切换，请检查 Docker 构建依赖和网络')
  }
  image = await imageId(tag)
  if (!(await qualified(image, manifest)))
    throw fail('hermit_guest_environment_mismatch', '构建后的槽位镜像不满足 Hermit 环境或 tmux 摘要要求')
  return { ok: true, image, action: 'built' }
}
