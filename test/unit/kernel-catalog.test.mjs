import test, { after, before } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describeKernelCatalog, pullKernelRelease } from '../../src/lib/admin/kernel-catalog.mjs'
import {
  describeCcNodePayload,
  describeKernelPayload,
  describeWrapSample,
  materializeWrapCli,
  wrapCliTemplateDir,
} from '../../src/lib/vm/wrap-cli-runtime.mjs'

const envNames = ['KIN_WRAP_CLI_ROOT', 'KIN_KERNEL_BIN']
const env = Object.fromEntries(envNames.map((name) => [name, process.env[name]]))
before(() => {
  for (const name of envNames) delete process.env[name]
})
after(() => {
  for (const name of envNames) {
    if (env[name] == null) delete process.env[name]
    else process.env[name] = env[name]
  }
})
function writable(root) {
  if (!fs.existsSync(root)) return
  fs.chmodSync(root, 0o755)
  for (const entry of fs.readdirSync(root, { withFileTypes: true }))
    if (entry.isDirectory()) writable(path.join(root, entry.name))
}
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kernel-catalog-'))
  t.after(() => {
    writable(root)
    fs.rmSync(root, { recursive: true, force: true })
  })
  return root
}
function elf(revision = '') {
  const data = Buffer.alloc(96 + revision.length)
  data.set([0x7f, 0x45, 0x4c, 0x46, 2, 1, 1])
  data.writeUInt16LE(3, 16)
  data.writeUInt16LE(62, 18)
  data.write(revision, 96)
  return data
}
function transport(files, { tag = 'v1.2.3', size, redirect } = {}) {
  const seen = []
  const entries = Object.entries(files)
  const fetchImpl = async (url, options) => {
    seen.push(String(url))
    assert.equal(options.redirect, 'manual')
    if (String(url).includes('/releases/latest') || String(url).includes('/releases/tags/'))
      return new Response(
        JSON.stringify({
          tag_name: tag,
          assets: entries.map(([name, body], index) => ({
            name,
            size: size ?? body.length,
            url: `https://api.github.com/repos/dofastted/vm2api/releases/assets/${index + 1}`,
          })),
        }),
      )
    const index = Number(String(url).split('/').at(-1)) - 1
    assert.ok(entries[index], `unexpected asset request ${url}`)
    if (redirect) return new Response(null, { status: 302, headers: { location: redirect } })
    return new Response(entries[index][1])
  }
  return { fetchImpl, seen }
}
function snapshot(root) {
  const rows = {}
  function visit(dir, prefix = '') {
    for (const name of fs.readdirSync(dir).sort()) {
      const abs = path.join(dir, name)
      const rel = `${prefix}/${name}`
      const st = fs.statSync(abs)
      rows[rel] = st.isDirectory()
        ? { mode: st.mode }
        : { mode: st.mode, data: fs.readFileSync(abs).toString('base64') }
      if (st.isDirectory()) visit(abs, rel)
    }
  }
  visit(root)
  return rows
}

test('CLI pull downloads only the free pair, installs both, and preserves legacy factory assets', async (t) => {
  const root = fixture(t)
  const factory = path.join(root, 'share/wrap-cli')
  fs.mkdirSync(factory, { recursive: true })
  fs.writeFileSync(path.join(factory, 'cc-node'), 'legacy-cc', { mode: 0o755 })
  fs.mkdirSync(path.join(factory, 'glibc239'))
  fs.writeFileSync(path.join(factory, 'glibc239/libc.so.6'), 'existing-runtime')
  const kernel = elf('new-kernel'),
    cli = elf('new-cli')
  const http = transport({ 'kin-kernel': kernel, 'cli-node': cli })
  const result = await pullKernelRelease(root, { kernel: 'cli-node' }, http)
  assert.equal(result.ok, true, result.error)
  assert.equal(http.seen.length, 3)
  assert.equal(result.kernel.version, '1.2.3')
  assert.equal(describeKernelCatalog(root)[0].version, '1.2.3')
  assert.notEqual(wrapCliTemplateDir(root), factory)
  assert.equal(fs.readFileSync(describeCcNodePayload(root).path, 'utf8'), 'legacy-cc')
  const materialized = materializeWrapCli(root, { id: 'vm-fixture', dataplane: 'wrap' })
  assert.equal(materialized.ok, true, materialized.error)
  assert.deepEqual(fs.readFileSync(path.join(materialized.dest, 'kin-kernel.bin')), kernel)
  assert.deepEqual(fs.readFileSync(path.join(materialized.dest, 'cli-node')), cli)
  assert.equal(fs.readFileSync(path.join(materialized.dest, 'glibc239/libc.so.6'), 'utf8'), 'existing-runtime')
  assert.equal(fs.readFileSync(path.join(factory, 'cc-node'), 'utf8'), 'legacy-cc')
})

test('CLI installation needs no unrelated cc-node even in an empty project', async (t) => {
  const root = fixture(t)
  const pulled = await pullKernelRelease(
    root,
    { kernel: 'cli-node' },
    transport({ 'kin-kernel': elf(), 'cli-node': elf() }),
  )
  assert.equal(pulled.ok, true)
  const installed = materializeWrapCli(root, { id: 'vm-free' })
  assert.equal(installed.ok, true, installed.error)
  assert.equal(fs.existsSync(path.join(installed.dest, 'cc-node')), false)
})

for (const [label, files, options, code] of [
  ['invalid second executable', { 'kin-kernel': elf(), 'cli-node': Buffer.from('not ELF') }, {}, 'kernel_not_elf'],
  ['oversized asset', { 'kin-kernel': elf(), 'cli-node': elf() }, { size: 600 * 1024 * 1024 }, 'kernel_too_large'],
  [
    'unsafe redirect',
    { 'kin-kernel': elf(), 'cli-node': elf() },
    { redirect: 'http://127.0.0.1/private' },
    'kernel_redirect_blocked',
  ],
  ['incomplete pair', { 'kin-kernel': elf() }, {}, 'cli_node_asset_missing'],
])
  test(`CLI ${label} preserves the complete prior selected pair`, async (t) => {
    const root = fixture(t)
    assert.equal(
      (
        await pullKernelRelease(
          root,
          { kernel: 'cli-node' },
          transport({ 'kin-kernel': elf('old'), 'cli-node': elf('old') }),
        )
      ).ok,
      true,
    )
    const previous = wrapCliTemplateDir(root)
    const bytes = snapshot(previous)
    const result = await pullKernelRelease(root, { kernel: 'cli-node' }, transport(files, options))
    assert.equal(result.ok, false)
    assert.equal(result.code, code)
    assert.equal(wrapCliTemplateDir(root), previous)
    assert.deepEqual(snapshot(previous), bytes)
    assert.equal(describeKernelCatalog(root)[0].ready, true)
  })

test('publication failure preserves the pointer and prior package byte-for-byte', async (t) => {
  const root = fixture(t)
  const files = { 'kin-kernel': elf('old'), 'cli-node': elf('old') }
  assert.equal((await pullKernelRelease(root, { kernel: 'cli-node' }, transport(files))).ok, true)
  const selected = wrapCliTemplateDir(root)
  const before = snapshot(selected)
  const pointer = path.join(root, 'share/wrap-cli-releases/current-amd64.json')
  const pointerBytes = fs.readFileSync(pointer)
  const rename = fs.renameSync
  fs.renameSync = (source, destination) => {
    if (destination === pointer) throw Object.assign(new Error('fixture I/O failure'), { code: 'EACCES' })
    return rename(source, destination)
  }
  let result
  try {
    result = await pullKernelRelease(
      root,
      { kernel: 'cli-node' },
      transport({ 'kin-kernel': elf('new'), 'cli-node': elf('new') }),
    )
  } finally {
    fs.renameSync = rename
  }
  assert.equal(result.ok, false)
  assert.equal(wrapCliTemplateDir(root), selected)
  assert.deepEqual(fs.readFileSync(pointer), pointerBytes)
  assert.deepEqual(snapshot(selected), before)
  assert.equal(fs.readdirSync(path.join(root, 'share/wrap-cli-releases/packages')).length, 1)
})

test('cache retains only current and previous immutable snapshots', async (t) => {
  const root = fixture(t)
  const selected = []
  for (const revision of ['one', 'two', 'three']) {
    const result = await pullKernelRelease(
      root,
      { kernel: 'cli-node' },
      transport({ 'kin-kernel': elf(revision), 'cli-node': elf(revision) }),
    )
    assert.equal(result.ok, true)
    selected.push(wrapCliTemplateDir(root))
  }
  assert.equal(fs.existsSync(selected[0]), false)
  assert.equal(fs.existsSync(selected[1]), true)
  assert.equal(fs.existsSync(selected[2]), true)
})

test('standard project KIN_KERNEL_BIN permits pulling and resolves the published pair', async (t) => {
  const root = fixture(t)
  const bundled = path.join(root, 'bin/kin-kernel')
  fs.mkdirSync(path.dirname(bundled), { recursive: true })
  fs.writeFileSync(bundled, elf('factory'), { mode: 0o755 })
  process.env.KIN_KERNEL_BIN = bundled
  try {
    const kernel = elf('pulled')
    const result = await pullKernelRelease(
      root,
      { kernel: 'cli-node' },
      transport({ 'kin-kernel': kernel, 'cli-node': elf('cli') }),
    )
    assert.equal(result.ok, true, result.error)
    assert.equal(describeKernelPayload(root).path, path.join(wrapCliTemplateDir(root), 'kin-kernel.bin'))
    const installed = materializeWrapCli(root, { id: 'vm-default-env' })
    assert.equal(installed.ok, true, installed.error)
    assert.deepEqual(fs.readFileSync(path.join(installed.dest, 'kin-kernel.bin')), kernel)
    assert.deepEqual(fs.readFileSync(bundled), elf('factory'))
  } finally {
    delete process.env.KIN_KERNEL_BIN
  }
})

test('external kernel overrides remain pinned and cannot be replaced by a pull', async (t) => {
  const root = fixture(t),
    external = fixture(t)
  assert.equal(
    (await pullKernelRelease(root, { kernel: 'cli-node' }, transport({ 'kin-kernel': elf(), 'cli-node': elf() }))).ok,
    true,
  )
  const selected = wrapCliTemplateDir(root)
  const binary = path.join(external, 'custom-kernel')
  fs.writeFileSync(binary, elf('custom'), { mode: 0o755 })
  process.env.KIN_KERNEL_BIN = binary
  try {
    const result = await pullKernelRelease(
      root,
      { kernel: 'cli-node' },
      transport({ 'kin-kernel': elf('new'), 'cli-node': elf('new') }),
    )
    assert.equal(result.code, 'kernel_override_active')
    assert.equal(describeKernelPayload(root).path, binary)
    assert.equal(wrapCliTemplateDir(root), selected)
    assert.deepEqual(fs.readFileSync(binary), elf('custom'))
  } finally {
    delete process.env.KIN_KERNEL_BIN
  }
})

test('only missing pointers permit factory fallback; malformed, missing-target and unreadable selections fail closed', async (t) => {
  const root = fixture(t)
  await pullKernelRelease(root, { kernel: 'cli-node' }, transport({ 'kin-kernel': elf(), 'cli-node': elf() }))
  const pointer = path.join(root, 'share/wrap-cli-releases/current-amd64.json')
  const validPointer = fs.readFileSync(pointer)
  const factory = path.join(root, 'share/wrap-cli')
  fs.mkdirSync(factory, { recursive: true })
  fs.writeFileSync(path.join(factory, 'kin-kernel.bin'), elf('factory'), { mode: 0o755 })
  fs.writeFileSync(path.join(factory, 'cli-node'), elf('factory'), { mode: 0o755 })
  for (const value of [
    '{not-json',
    JSON.stringify({ package: 'packages/amd64-00000000-0000-0000-0000-000000000000' }),
  ]) {
    fs.writeFileSync(pointer, value)
    assert.throws(() => wrapCliTemplateDir(root), { code: 'kernel_cache_invalid' })
    assert.equal(describeKernelCatalog(root)[0].code, 'kernel_cache_invalid')
    assert.equal(describeKernelCatalog(root)[0].ready, false)
    assert.equal(describeWrapSample(root).code, 'kernel_cache_invalid')
    assert.equal(materializeWrapCli(root, { id: 'vm-fail-closed' }).code, 'kernel_cache_invalid')
    assert.equal(fs.existsSync(path.join(root, 'vms/vm-fail-closed')), false)
  }
  fs.writeFileSync(pointer, validPointer)
  const read = fs.readFileSync
  fs.readFileSync = (file, ...args) => {
    if (file === pointer) throw Object.assign(new Error('fixture unreadable'), { code: 'EACCES' })
    return read(file, ...args)
  }
  try {
    assert.throws(() => wrapCliTemplateDir(root), { code: 'kernel_cache_invalid' })
    assert.equal(describeKernelCatalog(root)[0].code, 'kernel_cache_invalid')
  } finally {
    fs.readFileSync = read
  }
  fs.unlinkSync(pointer)
  assert.equal(wrapCliTemplateDir(root), factory)
  assert.equal(describeKernelCatalog(root)[0].ready, true)
})

test('incomplete selected CLI cache cannot silently reuse the factory kernel', async (t) => {
  const root = fixture(t)
  assert.equal(
    (await pullKernelRelease(root, { kernel: 'cli-node' }, transport({ 'kin-kernel': elf(), 'cli-node': elf() }))).ok,
    true,
  )
  const selected = wrapCliTemplateDir(root)
  const bundled = path.join(root, 'bin/kin-kernel')
  fs.mkdirSync(path.dirname(bundled), { recursive: true })
  fs.writeFileSync(bundled, elf('factory'), { mode: 0o755 })
  writable(selected)
  fs.unlinkSync(path.join(selected, 'kin-kernel.bin'))
  process.env.KIN_KERNEL_BIN = bundled
  try {
    assert.throws(() => wrapCliTemplateDir(root), { code: 'kernel_cache_invalid' })
    assert.equal(describeKernelCatalog(root)[0].code, 'kernel_cache_invalid')
    assert.equal(materializeWrapCli(root, { id: 'vm-no-fallback' }).code, 'kernel_cache_invalid')
    assert.equal(fs.existsSync(path.join(root, 'vms/vm-no-fallback')), false)
  } finally {
    delete process.env.KIN_KERNEL_BIN
  }
})
