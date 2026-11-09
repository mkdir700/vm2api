import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import http from 'node:http'
import { once } from 'node:events'
import { createHash } from 'node:crypto'
import { execFileSync, spawn } from 'node:child_process'
import { startGateway, REPO_ROOT } from '../harness.mjs'

// Failure inventory: docs/operations/hermit-kernel-page-results-20261109.md.
// Requires: pnpm -C web build and an available ego-browser installation.
test('Hermit uploads packages and uses the shared VM installer through the browser', {
  timeout: 90000,
}, async () => {
  const artifact = path.resolve(process.env.HERMIT_PAGE_E2E_OUT || `.tmp/hermit-kernel-page-${Date.now()}`)
  fs.mkdirSync(artifact, { recursive: true })
  const gw = await startGateway({ env: { KIN_KERNEL_TEST_ENDPOINTS: '1' } })
  const cli = Buffer.alloc(4096)
  Buffer.from([0x7f, 0x45, 0x4c, 0x46, 2, 1]).copy(cli)
  cli.writeUInt16LE(2, 16)
  cli.writeUInt16LE(62, 18)
  const upstream = http.createServer((_req, res) => res.end(cli))
  upstream.listen(0, '127.0.0.1')
  await once(upstream, 'listening')
  try {
    fs.mkdirSync(path.join(gw.project, 'web'), { recursive: true })
    fs.symlinkSync(path.join(REPO_ROOT, 'web/dist'), path.join(gw.project, 'web/dist'))
    const slot = path.join(gw.project, 'vms/vm-sim-01.json')
    const before = JSON.parse(fs.readFileSync(slot))
    const fixture = path.join(gw.project, 'fixture')
    fs.mkdirSync(fixture)
    execFileSync('python3', [
      '-c',
      fs.readFileSync(path.join(REPO_ROOT, 'test/fixtures/hermit-page-package.py'), 'utf8'),
      fixture,
      `http://127.0.0.1:${upstream.address().port}/claude`,
      createHash('sha256').update(cli).digest('hex'),
    ])
    const production = path.join(gw.project, 'production-fixture')
    fs.mkdirSync(production)
    execFileSync('python3', [
      path.join(REPO_ROOT, 'test/fixtures/hermit-page-package.py'),
      production,
      `http://127.0.0.1:${upstream.address().port}/claude`,
      createHash('sha256').update(cli).digest('hex'),
      'production',
    ])
    fs.renameSync(path.join(production, 'package.tar.gz'), path.join(production, 'production.tar.gz'))
    fs.renameSync(path.join(production, 'release.json'), path.join(production, 'production-release.json'))
    const config = {
      url: gw.baseUrl,
      artifact,
      archive: path.join(fixture, 'package.tar.gz'),
      receipt: path.join(fixture, 'release.json'),
      productionArchive: path.join(production, 'production.tar.gz'),
      productionReceipt: path.join(production, 'production-release.json'),
    }
    const browser = spawn('ego-browser', ['nodejs'], { stdio: ['pipe', 'pipe', 'pipe'] })
    let output = ''
    browser.stdout.on('data', (d) => {
      output += d
    })
    browser.stderr.on('data', (d) => {
      output += d
    })
    browser.stdin.end(
      `globalThis.hermitKernelPage = ${JSON.stringify(config)};\n` +
        fs.readFileSync(path.join(REPO_ROOT, 'test/fixtures/hermit-kernel-page.mjs'), 'utf8'),
    )
    const [code] = await once(browser, 'exit')
    fs.writeFileSync(path.join(artifact, 'browser.log'), output)
    assert.equal(code, 0, output)
    const after = JSON.parse(fs.readFileSync(slot))
    assert.equal(after.dataplane, before.dataplane, 'rejected install preserves the active kernel')
    assert.equal(after.status, before.status, 'rejected install preserves the running state')
    assert.deepEqual(after.claude, before.claude, 'rejected install preserves credentials')
    assert.equal(after.pending_kernel_package, undefined, 'package management does not stage a slot')
    fs.writeFileSync(
      path.join(artifact, 'summary.json'),
      JSON.stringify(
        { result: 'PASS', active_kernel_preserved: true, running_state_preserved: true, credentials_preserved: true },
        null,
        2,
      ),
    )
    console.log(`Hermit kernel page evidence: ${artifact}`)
  } finally {
    await gw.stop()
    upstream.close()
    fs.rmSync(gw.project, { recursive: true, force: true })
  }
})
