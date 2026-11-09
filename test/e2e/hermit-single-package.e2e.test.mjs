import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import http from 'node:http'
import { once } from 'node:events'
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { startGateway, api, REPO_ROOT } from '../harness.mjs'

// Failure inventory: docs/operations/hermit-single-package-20261109.md.
test('Hermit exposes one replaceable package and preserves deployed files', { timeout: 60000 }, async () => {
  const out = path.resolve(process.env.HERMIT_SINGLE_E2E_OUT || `.tmp/hermit-single-${Date.now()}`)
  fs.mkdirSync(out, { recursive: true })
  const checks = []
  const check = (name, value) => {
    checks.push({ name, result: value ? 'PASS' : 'FAIL' })
    assert.ok(value, name)
  }
  const cli = Buffer.alloc(4096)
  Buffer.from([0x7f, 0x45, 0x4c, 0x46, 2, 1]).copy(cli)
  cli.writeUInt16LE(2, 16)
  cli.writeUInt16LE(62, 18)
  let downloads = 0
  const origin = http.createServer((_req, res) => {
    downloads++
    res.end(cli)
  })
  origin.listen(0, '127.0.0.1')
  await once(origin, 'listening')
  const gw = await startGateway({ env: { KIN_KERNEL_TEST_ENDPOINTS: '1' } })
  try {
    const login = await api(gw, 'POST', '/api/panel/login', { body: { username: 'admin', password: 'testpass' } })
    const headers = { cookie: login.headers.get('set-cookie') }
    const catalog = async () => (await api(gw, 'GET', '/api/panel/kernel-packages', { headers })).json.data
    check('empty_current_package', (await catalog()).item === null)
    const make = (name, production) => {
      const dir = path.join(gw.project, name)
      fs.mkdirSync(dir)
      execFileSync('python3', [
        path.join(REPO_ROOT, 'test/fixtures/hermit-page-package.py'),
        dir,
        `http://127.0.0.1:${origin.address().port}/cli`,
        createHash('sha256').update(cli).digest('hex'),
        ...(production ? ['production'] : []),
      ])
      return { dir, receipt: JSON.parse(fs.readFileSync(path.join(dir, 'release.json'))) }
    }
    const upload = async (fixture, corrupt = false) => {
      const receipt = fixture.receipt
      const r = await fetch(gw.baseUrl + '/api/panel/kernel-packages', {
        method: 'POST',
        headers: {
          ...headers,
          'content-type': 'application/gzip',
          'x-kernel-sha256': corrupt ? '0'.repeat(64) : receipt.archive.sha256,
          'x-kernel-bytes': String(receipt.archive.bytes),
          'x-kernel-manifest-sha256': receipt.manifest_sha256,
        },
        body: fs.readFileSync(path.join(fixture.dir, 'package.tar.gz')),
      })
      return { status: r.status, json: await r.json() }
    }
    const old = make('old-package', false),
      next = make('next-package', true)
    check('first_upload', (await upload(old)).status === 200)
    check('same_upload_idempotent', (await upload(old)).json.data.idempotent === true)
    check('one_current_package', (await catalog()).item.version === '0.1.0-ui-e2e' && !('items' in (await catalog())))
    check('replacement_upload', (await upload(next)).status === 200)
    check('replacement_is_only_current', (await catalog()).item.version === '0.2.0-ui-e2e')
    const pool = path.join(gw.project, 'share/kernel-packages')
    const oldPath = path.join(pool, 'versions/hermit/linux-amd64/0.1.0-ui-e2e')
    check('unreferenced_package_removed', !fs.existsSync(oldPath))
    check(
      'failed_upload_preserves_current',
      (await upload(old, true)).status === 400 && (await catalog()).item.version === '0.2.0-ui-e2e',
    )
    const recordFile = path.join(gw.project, 'vms/vm-sim-01.json')
    const record = JSON.parse(fs.readFileSync(recordFile))
    record.dataplane = 'hermit'
    record.kernel_package = {
      runtime: 'hermit',
      target: 'linux-amd64',
      version: '0.2.0-ui-e2e',
      manifest_sha256: next.receipt.manifest_sha256,
    }
    fs.writeFileSync(recordFile, JSON.stringify(record))
    const before = fs.readFileSync(recordFile)
    check('replace_while_vm_bound', (await upload(old)).status === 200)
    check('vm_record_unchanged', before.equals(fs.readFileSync(recordFile)))
    check(
      'deployed_files_preserved',
      fs.existsSync(path.join(pool, 'versions/hermit/linux-amd64/0.2.0-ui-e2e/payload/bin/hermit')),
    )
    check(
      'deployed_package_not_selectable',
      (await catalog()).item.version === '0.1.0-ui-e2e' && !('items' in (await catalog())),
    )
    check('shared_cli_downloaded_once', downloads === 1)
    const invalidRecord = { ...record, kernel_package: 'invalid-binding' }
    fs.writeFileSync(recordFile, JSON.stringify(invalidRecord))
    const held = await upload(next)
    check(
      'invalid_binding_retains_files_and_reports_cleanup_pending',
      held.status === 200 && held.json.data.cleanup_pending === true && fs.existsSync(oldPath),
    )
    fs.writeFileSync(recordFile, before)
    const pointer = path.join(pool, 'current.json')
    const valid = fs.readFileSync(pointer)
    fs.writeFileSync(pointer, '{"runtime":"hermit","version":"../outside","target":"linux-amd64"}')
    const broken = await api(gw, 'GET', '/api/panel/kernel-packages', { headers })
    check('invalid_pointer_rejected', broken.status >= 400)
    fs.writeFileSync(pointer, valid)
    fs.writeFileSync(path.join(out, 'catalog.json'), JSON.stringify(await catalog(), null, 2))
    fs.writeFileSync(
      path.join(out, 'summary.json'),
      JSON.stringify({ result: 'PASS', checks: checks.length, downloads }, null, 2),
    )
  } finally {
    fs.writeFileSync(path.join(out, 'checks.json'), JSON.stringify(checks, null, 2))
    await gw.stop()
    origin.close()
    fs.rmSync(gw.project, { recursive: true, force: true })
  }
})
