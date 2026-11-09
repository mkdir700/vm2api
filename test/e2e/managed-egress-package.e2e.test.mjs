import test from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { DatabaseSync } from 'node:sqlite'
import { once } from 'node:events'
import { mkdir, readFile, writeFile, rm, stat } from 'node:fs/promises'
import { startGateway, seedVm, api } from '../harness.mjs'
import { writeWorkerCredentialFile } from '../../src/lib/oauth/oauth-credentials.mjs'

const digest = (bytes) => createHash('sha256').update(bytes).digest('hex')

test('VM packages retain managed exit references and refuse unavailable replacements before writing', {
  timeout: 30000,
}, async () => {
  let gateway
  try {
    gateway = await startGateway({ env: { VM2API_CONTAINER_NAME: `package-egress-absent-${process.pid}` } })
    const imported = await api(gateway, 'POST', '/api/panel/proxies/import', {
      body: {
        protocol: 'hysteria2',
        config: { server: 'localhost', server_port: 443, password: 'controlled-package-upstream' },
        label: 'Package exit',
      },
    })
    assert.equal(imported.status, 200)
    const exitId = imported.json.data.items[0].id
    const vmId = 'vm-managed-package'
    const vm = seedVm({ project: gateway.project, id: vmId, oauth: false })
    const file = path.join(gateway.project, 'vms', `${vmId}.json`)
    await writeFile(
      file,
      JSON.stringify({
        ...vm,
        status: 'stopped',
        proxy: { id: exitId, managed: true, managed_host_id: 'control-plane', scheme: 'hysteria2' },
      }),
    )
    const home = path.join(gateway.project, 'vms', vmId, 'cli-home')
    writeWorkerCredentialFile(home, {
      access_token: 'controlled-original-token',
      refresh_token: 'controlled-original-refresh',
      expires_at: Math.floor(Date.now() / 1000) + 3600,
    })
    const credentialFile = path.join(home, '.claude', 'credentials.json')
    let credentialBefore = digest(await readFile(credentialFile))
    const exported = await api(gateway, 'GET', `/api/panel/vms/${vmId}/package`)
    assert.equal(exported.status, 200)
    const doc = exported.json.data
    assert.equal(doc.proxy.kind, 'managed', 'export must preserve the managed reference kind')
    assert.deepEqual(Object.keys(doc.proxy).sort(), ['host_id', 'id', 'kind', 'label'])
    assert.equal(doc.proxy.id, exitId)
    assert.equal(doc.proxy.host_id, 'control-plane')
    assert.equal(doc.proxy.label, 'Package exit')
    let before = digest(await readFile(file))
    const attempted = JSON.parse(
      JSON.stringify(doc).replaceAll('controlled-original-token', 'controlled-replacement-token'),
    )
    const assertRefused = async (proxy, code, status = 409) => {
      const response = await api(gateway, 'PUT', `/api/panel/vms/${vmId}/package`, {
        body: { ...attempted, vm: { ...doc.vm, note: 'must not be written' }, proxy },
      })
      assert.equal(response.status, status)
      assert.equal(response.json.error.code, code)
      assert.equal(digest(await readFile(file)), before)
      assert.equal(digest(await readFile(credentialFile)), credentialBefore)
    }
    await assertRefused(doc.proxy, 'managed_egress_not_ready')
    assert.equal((await api(gateway, 'POST', `/api/panel/proxies/${exitId}/disable`)).status, 200)
    await assertRefused(doc.proxy, 'proxy_disabled')
    assert.equal((await api(gateway, 'POST', `/api/panel/proxies/${exitId}/enable`)).status, 200)
    await assertRefused({ ...doc.proxy, id: 'px-missing' }, 'managed_exit_not_found')
    await assertRefused({ ...doc.proxy, host_id: 'another-host' }, 'managed_host_unsupported')
    await assertRefused({ ...doc.proxy, id: exitId + 'x'.repeat(130) }, 'invalid_proxy', 400)
    await assertRefused({ ...doc.proxy, host_id: '' }, 'invalid_proxy', 400)
    await assertRefused({ ...doc.proxy, kind: 'unknown', host: '127.0.0.1', port: 24000 }, 'invalid_proxy', 400)
    const user = await api(gateway, 'POST', '/api/panel/users', {
      body: { username: 'package-owner', password: 'controlled-package-owner', role: 'user' },
    })
    assert.equal(user.status, 201)
    const login = await fetch(gateway.baseUrl + '/api/panel/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: 'package-owner', password: 'controlled-package-owner' }),
    })
    assert.equal(login.status, 200)
    const owned = await api(gateway, 'POST', '/api/panel/proxies/import', {
      headers: { authorization: '', cookie: login.headers.get('set-cookie') },
      body: { protocol: 'hysteria2', config: { server: 'localhost', password: 'controlled-owner-upstream' } },
    })
    assert.equal(owned.status, 403)
    // Existing tenant-owned exits survive the new admin-only management policy.
    const legacy = await api(gateway, 'POST', '/api/panel/proxies/import', {
      body: { protocol: 'hysteria2', config: { server: 'localhost', password: 'controlled-legacy-owner' } },
    })
    assert.equal(legacy.status, 200)
    const ownedId = legacy.json.data.items[0].id
    const projectBeforeRestart = gateway.project
    await gateway.stop()
    const fixtureDb = new DatabaseSync(path.join(projectBeforeRestart, 'data', 'kin.db'))
    fixtureDb.prepare('UPDATE proxies SET owner_user_id = ? WHERE id = ?').run(user.json.data.item.id, ownedId)
    fixtureDb.close()
    gateway = await startGateway({
      project: projectBeforeRestart,
      env: { VM2API_CONTAINER_NAME: `package-egress-absent-${process.pid}` },
    })
    before = digest(await readFile(file))
    credentialBefore = digest(await readFile(credentialFile))
    await assertRefused({ ...doc.proxy, id: ownedId }, 'proxy_forbidden', 403)
    const created = await api(gateway, 'POST', '/api/panel/vms/package', {
      body: { ...doc, vm: { ...doc.vm, id: 'vm-refused-package' } },
    })
    assert.equal(created.status, 409)
    assert.equal(created.json.error.code, 'managed_egress_not_ready')
    await assert.rejects(readFile(path.join(gateway.project, 'vms', 'vm-refused-package.json')), {
      code: 'ENOENT',
    })
    await assert.rejects(stat(path.join(gateway.project, 'vms', 'vm-refused-package')), { code: 'ENOENT' })
    const list = await api(gateway, 'GET', '/api/panel/proxies')
    assert.equal(list.json.data.proxies.filter((row) => !row.managed && row.protocol !== 'local').length, 0)
    const external = await api(gateway, 'PUT', `/api/panel/vms/${vmId}/package`, {
      body: { ...doc, proxy: { kind: 'socks5', host: '127.0.0.1', port: 19080 } },
    })
    assert.equal(external.status, 200)
    const externalVm = JSON.parse(await readFile(file, 'utf8'))
    assert.equal(externalVm.proxy.managed, false)
    assert.equal(externalVm.proxy.host, '127.0.0.1')
    assert.equal(externalVm.proxy.port, 19080)
    const local = await api(gateway, 'PUT', `/api/panel/vms/${vmId}/package`, {
      body: { ...doc, proxy: { kind: 'local' } },
    })
    assert.equal(local.status, 200)
    assert.equal(JSON.parse(await readFile(file, 'utf8')).proxy.id, 'px-local')
    const project = gateway.project
    const ended = gateway.child.exitCode == null ? once(gateway.child, 'exit') : Promise.resolve()
    await gateway.stop()
    await ended
    const db = new DatabaseSync(path.join(project, 'data', 'kin.db'))
    try {
      db.prepare('UPDATE proxies SET status = ? WHERE id = ?').run('dead', exitId)
    } finally {
      db.close()
    }
    gateway = await startGateway({ project, env: { VM2API_CONTAINER_NAME: `package-egress-absent-${process.pid}` } })
    const deadBefore = digest(await readFile(file))
    const deadCredentialBefore = digest(await readFile(credentialFile))
    const dead = await api(gateway, 'PUT', `/api/panel/vms/${vmId}/package`, { body: attempted })
    assert.equal(dead.status, 409)
    assert.equal(dead.json.error.code, 'proxy_disabled')
    assert.equal(digest(await readFile(file)), deadBefore)
    assert.equal(digest(await readFile(credentialFile)), deadCredentialBefore)
    const files = [
      'test/e2e/managed-egress-package.e2e.test.mjs',
      'src/lib/vm/vm-package.mjs',
      'src/lib/oauth/oauth-credentials.mjs',
      'src/lib/vm/vm-runtime.mjs',
      'src/lib/vm/proxy-pool.mjs',
      'src/lib/vm/managed-egress-binding.mjs',
      'src/lib/admin/panel-routes.mjs',
    ]
    const receipt = {
      status: 'PASS',
      source: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
      command: 'node --test test/e2e/managed-egress-package.e2e.test.mjs',
      scope: 'real HTTP/SQLite package reference and pre-write refusal; no successful runtime import proof',
      source_files: Object.fromEntries(await Promise.all(files.map(async (f) => [f, digest(await readFile(f))]))),
      results: [
        'typed reference excludes runtime addresses and credentials',
        'unavailable/missing/wrong-host reference preserves VM and existing credential bytes',
        'unknown kind and malformed reference rejected',
        'cross-owner reference refused before VM writes',
        'persisted dead exit refused after gateway restart without VM or credential writes',
        'legacy external SOCKS and local package write-back retained',
        'refused creation writes no VM and creates no external SOCKS row',
      ],
    }
    await mkdir('.tmp/managed-egress-e2e', { recursive: true })
    await writeFile('.tmp/managed-egress-e2e/package-receipt.json', JSON.stringify(receipt, null, 2))
  } finally {
    await gateway?.stop()
    if (gateway) await rm(gateway.project, { recursive: true, force: true })
  }
})
