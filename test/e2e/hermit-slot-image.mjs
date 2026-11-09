// Real Docker guest-image preparation. No production mounts or credentials.
// Failure inventory: .planning/2026-11-09-hermit-slot-image-repair/task_plan.md.
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { prepareHermitSlotImage } from '../../src/lib/vm/hermit-slot-image.mjs'

const [out, manifestFile] = process.argv.slice(2)
fs.mkdirSync(out, { recursive: true })
const manifest = JSON.parse(fs.readFileSync(manifestFile))
const docker = (...args) => execFileSync('docker', args, { encoding: 'utf8', timeout: 60000 }).trim()
const name = `hermit-image-e2e-${crypto.randomBytes(6).toString('hex')}`
const checks = []
const check = (name, ok) => {
  checks.push({ name, result: ok ? 'PASS' : 'FAIL' })
  fs.writeFileSync(path.join(out, 'checks.json'), JSON.stringify(checks, null, 2) + '\n')
  assert.ok(ok, name)
}
const root = path.resolve(import.meta.dirname, '../..')
let original
try {
  original = docker(
    'run',
    '-d',
    '--name',
    name,
    '--network',
    'none',
    '--read-only',
    '--cap-drop',
    'ALL',
    '--label',
    'vm2api.e2e=hermit-slot-image',
    'ghcr.io/dofastted/kin-os-ubuntu:24.04',
    'sleep',
    'infinity',
  )
  const before = JSON.parse(docker('inspect', name))[0]
  const prepared = await prepareHermitSlotImage('ubuntu-24.04', { projectRoot: root, manifest })
  fs.writeFileSync(path.join(out, 'prepared.json'), JSON.stringify(prepared, null, 2) + '\n')
  check('preparation_succeeds', prepared.ok)
  const audit = JSON.parse(
    docker(
      'run',
      '--rm',
      '--pull=never',
      '--network',
      'none',
      '--read-only',
      '--cap-drop',
      'ALL',
      '--entrypoint',
      'python3',
      prepared.image,
      '-c',
      "import os,json,hashlib; p='/usr/bin/tmux'; print(json.dumps({'tmux':hashlib.sha256(open(p,'rb').read()).hexdigest() if os.path.exists(p) else None}))",
    ),
  )
  check('prepared_image_has_pinned_tmux', audit.tmux === manifest.dependencies.tmux.sha256)
  check('prepared_image_uses_immutable_id', /^sha256:[a-f0-9]{64}$/.test(prepared.image))
  const reused = await prepareHermitSlotImage('ubuntu-24.04', { projectRoot: root, manifest })
  check('qualified_image_is_reused', reused.ok && reused.image === prepared.image)
  const wrong = structuredClone(manifest)
  wrong.dependencies.tmux.sha256 = '0'.repeat(64)
  const rejected = await prepareHermitSlotImage('ubuntu-24.04', { projectRoot: root, manifest: wrong }).catch(
    (error) => ({ ok: false, code: error.code }),
  )
  check('wrong_digest_is_rejected', !rejected.ok && rejected.code === 'hermit_guest_environment_mismatch')
  const after = JSON.parse(docker('inspect', name))[0]
  check(
    'original_container_unchanged',
    after.Id === before.Id && after.State.Running && after.State.StartedAt === before.State.StartedAt,
  )
  fs.writeFileSync(
    path.join(out, 'summary.json'),
    JSON.stringify({ result: 'PASS', image: prepared.image, original, checks }, null, 2) + '\n',
  )
} finally {
  if (original) docker('rm', '-f', original)
  check('test_container_removed', !docker('ps', '-aq', '--filter', `name=^/${name}$`))
}
