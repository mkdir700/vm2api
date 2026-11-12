import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { startGateway, api } from '../harness.mjs'

test('published Hermit package installs from the public Worker into an isolated gateway', {
  timeout: 180000,
  skip: !process.env.HERMIT_REMOTE_LIVE_CLI,
}, async () => {
  const out = path.resolve(process.env.HERMIT_REMOTE_LIVE_OUT || `.tmp/hermit-remote-live-${Date.now()}`)
  fs.mkdirSync(out, { recursive: true })
  const base = 'https://hermit-releases.truerouter.cc'
  const headers = { 'User-Agent': 'vm2api-hermit-installer/1.0' }
  const snapshot = await (await fetch(base + '/v1/releases/latest', { headers })).json()
  const manifest = await (await fetch(snapshot.manifest_url, { headers })).json()
  const cli = process.env.HERMIT_REMOTE_LIVE_CLI
  const digest = createHash('sha256')
  for await (const chunk of fs.createReadStream(cli)) digest.update(chunk)
  assert.equal(digest.digest('hex'), manifest.cli.sha256)
  assert.equal(fs.statSync(cli).size, manifest.cli.bytes)
  const gw = await startGateway({ env: { KIN_KERNEL_TEST_ENDPOINTS: '0', KIN_HERMIT_RELEASES_URL: base } })
  try {
    // Reuse a real verified CLI cache; never execute the Linux CLI on this host.
    const cache = path.join(gw.project, 'share/kernel-packages/cli', manifest.cli.sha256)
    fs.mkdirSync(cache, { recursive: true })
    fs.copyFileSync(cli, path.join(cache, 'claude'))
    fs.chmodSync(path.join(cache, 'claude'), 0o555)
    const vm = path.join(gw.project, 'vms/vm-sim-01.json')
    const before = fs.readFileSync(vm)
    const pulled = await api(gw, 'POST', '/api/panel/kernel-packages/pull', { body: {} })
    fs.writeFileSync(path.join(out, 'pull.json'), JSON.stringify(pulled.json, null, 2))
    assert.equal(pulled.status, 200, JSON.stringify(pulled.json))
    const current = await api(gw, 'GET', '/api/panel/kernel-packages')
    const item = current.json.data.item
    const selected = await (await fetch(base + '/v1/releases/' + item.version, { headers })).json()
    assert.equal(item.target, 'linux-amd64')
    assert.equal(item.manifest_sha256, selected.manifest_sha256)
    const installed = path.join(
      gw.project,
      'share/kernel-packages/versions/hermit/linux-amd64',
      item.version,
      'payload/manifest.json',
    )
    const raw = fs.readFileSync(installed)
    assert.equal(createHash('sha256').update(raw).digest('hex'), selected.manifest_sha256)
    assert.equal(JSON.parse(raw).source.commit, selected.commit)
    assert.ok(before.equals(fs.readFileSync(vm)))
    fs.writeFileSync(path.join(out, 'catalog.json'), JSON.stringify(current.json, null, 2))
    fs.writeFileSync(path.join(out, 'selected-release.json'), JSON.stringify(selected, null, 2))
    fs.writeFileSync(
      path.join(out, 'summary.json'),
      JSON.stringify(
        {
          result: 'PASS',
          version: item.version,
          commit: selected.commit,
          manifest_sha256: selected.manifest_sha256,
          public_worker: base,
          real_package_installer: true,
          verified_cli_cache: true,
          vm_activation: 'NOT RUN',
          live_provider: 'NOT RUN',
        },
        null,
        2,
      ),
    )
  } finally {
    await gw.stop()
    fs.rmSync(gw.project, { recursive: true, force: true })
  }
})
