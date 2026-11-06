import test from 'node:test'
import assert from 'node:assert/strict'
import net from 'node:net'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { mkdir, writeFile, readFile } from 'node:fs/promises'
import { DatabaseSync } from 'node:sqlite'
import { startGateway, api } from '../harness.mjs'

test('managed import persists through the real panel API without exposing listener credentials', {
  timeout: 30000,
}, async () => {
  const occupied = net.createServer((socket) => socket.destroy())
  await new Promise((resolve, reject) => occupied.once('error', reject).listen(24000, '127.0.0.1', resolve))
  let gateway
  let project
  const secret = 'controlled-upstream-secret'
  const rows = []
  try {
    gateway = await startGateway({ env: { VM2API_CONTAINER_NAME: `managed-e2e-absent-${process.pid}` } })
    project = gateway.project
    const invalid = await api(gateway, 'POST', '/api/panel/proxies/import', {
      body: { text: `hy2://${secret}@localhost/?unsupported=${secret}` },
    })
    assert.equal(invalid.status, 400)
    assert.ok(!invalid.text.includes(secret))
    const remote = await api(gateway, 'POST', '/api/panel/proxies/import', {
      body: { protocol: 'hysteria2', host_id: 'remote-node', config: { server: 'localhost', password: secret } },
    })
    assert.equal(remote.status, 400)
    assert.equal(remote.json.error.code, 'managed_host_unsupported')
    const results = await Promise.all(
      [0, 1].map((i) =>
        api(gateway, 'POST', '/api/panel/proxies/import', {
          body: { text: `hy2://${secret}-${i}@localhost:443/?sni=localhost`, label: `Controlled ${i}` },
        }),
      ),
    )
    for (const result of results) {
      assert.equal(result.status, 200, result.text)
      const data = result.json.data || result.json
      assert.equal(data.application_status, 'pending')
      assert.equal(typeof data.application_error, 'string', 'import must attempt application and report failure')
      assert.ok(data.application_error.length > 0)
      const row = data.items[0]
      rows.push(row)
      assert.equal(row.host, null)
      assert.equal(row.port, null)
      assert.equal(row.blocked_reason, 'managed_egress_not_ready')
      assert.ok(!result.text.includes(secret))
      const bind = await api(gateway, 'POST', `/api/panel/proxies/${row.id}/bind`, { body: { vm_id: 'vm-sim-01' } })
      assert.ok(bind.status >= 400)
      assert.ok(bind.text.includes('managed_egress_not_ready'))
      const reveal = await api(gateway, 'POST', `/api/panel/proxies/${row.id}/reveal`)
      assert.equal(reveal.status, 409)
      assert.ok(!reveal.text.includes(secret))
    }
    const beforeEditDb = new DatabaseSync(path.join(project, 'data', 'kin.db'), { readOnly: true })
    const beforeEdit = beforeEditDb.prepare('SELECT port, username, password FROM proxies WHERE id = ?').get(rows[0].id)
    beforeEditDb.close()
    const invalidEdit = await api(gateway, 'PUT', `/api/panel/proxies/${rows[0].id}`, {
      body: { link: `hy2://${secret}@localhost/?invalid=yes` },
    })
    assert.equal(invalidEdit.status, 400)
    assert.ok(!invalidEdit.text.includes(secret))
    const edited = await api(gateway, 'PUT', `/api/panel/proxies/${rows[0].id}`, {
      body: { config: { server_port: 8443 }, label: 'Edited managed node' },
    })
    assert.equal(edited.status, 200, edited.text)
    const afterEditDb = new DatabaseSync(path.join(project, 'data', 'kin.db'), { readOnly: true })
    assert.deepEqual(
      afterEditDb.prepare('SELECT port, username, password FROM proxies WHERE id = ?').get(rows[0].id),
      beforeEdit,
    )
    afterEditDb.close()
    const apply = await api(gateway, 'POST', '/api/panel/proxies/apply')
    assert.equal(apply.status, 409)
    const recovery = await api(gateway, 'POST', '/api/panel/proxies/recover')
    assert.equal(recovery.status, 409)
    assert.ok(!recovery.text.includes(secret))
    assert.ok(!apply.text.includes(secret))
    for (const action of ['apply', 'recover']) {
      const unavailableHost = await api(gateway, 'POST', `/api/panel/proxies/${action}`, {
        body: { host_id: 'unavailable-node' },
      })
      assert.equal(unavailableHost.status, 409)
      assert.equal(unavailableHost.json.error.code, 'managed_runtime_unavailable')
      const invalidHost = await api(gateway, 'POST', `/api/panel/proxies/${action}`, {
        body: { host_id: [] },
      })
      assert.equal(invalidHost.status, 400)
      assert.equal(invalidHost.json.error.code, 'invalid_managed_host')
    }
    const db = new DatabaseSync(path.join(project, 'data', 'kin.db'), { readOnly: true })
    try {
      const persisted = db
        .prepare('SELECT id, port, managed_host_id FROM proxies WHERE managed_config IS NOT NULL')
        .all()
      assert.equal(persisted.length, 2)
      assert.notEqual(persisted[0].port, persisted[1].port)
      assert.ok(
        persisted.every((row) => row.port > 24000 && row.port <= 24999 && row.managed_host_id === 'control-plane'),
      )
    } finally {
      db.close()
    }
    const userResponse = await api(gateway, 'POST', '/api/panel/users', {
      body: { username: 'managed-reader', password: 'controlled-reader-pass', role: 'user' },
    })
    assert.equal(userResponse.status, 201, userResponse.text)
    const ownerId = (userResponse.json.data || userResponse.json).item.id
    const login = await fetch(gateway.baseUrl + '/api/panel/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: 'managed-reader', password: 'controlled-reader-pass' }),
    })
    assert.equal(login.status, 200)
    const userHeaders = { authorization: '', cookie: login.headers.get('set-cookie') }
    const deniedRemote = await api(gateway, 'POST', '/api/panel/proxies/import', {
      headers: userHeaders,
      body: { host_id: 'remote-node', link: `hy2://${secret}@localhost/` },
    })
    assert.equal(deniedRemote.status, 403)
    assert.equal(deniedRemote.json.error.code, 'admin_required')
    const owned = await api(gateway, 'POST', '/api/panel/proxies/import', {
      headers: userHeaders,
      body: { link: `hy2://${secret}@localhost/`, owner_user_id: 'fake-owner' },
    })
    assert.equal(owned.status, 200, owned.text)
    const ownedId = (owned.json.data || owned.json).items[0].id
    assert.equal((owned.json.data || owned.json).items[0].owner_user_id, ownerId)
    const deniedApply = await api(gateway, 'POST', '/api/panel/proxies/apply', { headers: userHeaders })
    assert.equal(deniedApply.status, 403)
    assert.equal((await api(gateway, 'POST', '/api/panel/proxies/recover', { headers: userHeaders })).status, 403)
    const denied = await api(gateway, 'DELETE', `/api/panel/proxies/${rows[0].id}`, { headers: userHeaders })
    assert.ok([403, 404].includes(denied.status), denied.text)
    const userList = await api(gateway, 'GET', '/api/panel/proxies', { headers: userHeaders })
    assert.equal(userList.status, 200)
    assert.ok(
      (userList.json.data || userList.json).proxies.every(
        (item) => !Object.hasOwn(item, 'managed_host_id') && !Object.hasOwn(item, 'managed_host_name'),
      ),
    )
    assert.ok(!(userList.json.data || userList.json).proxies.some((item) => rows.some((row) => row.id === item.id)))
    const deleted = await api(gateway, 'DELETE', `/api/panel/proxies/${ownedId}`, { headers: userHeaders })
    assert.equal(deleted.status, 200, deleted.text)
    assert.equal((deleted.json.data || deleted.json).application_status, 'pending')
    assert.equal((await api(gateway, 'POST', '/api/panel/proxies/apply')).status, 409)
    await gateway.stop()
    gateway = await startGateway({ project, env: { VM2API_CONTAINER_NAME: `managed-e2e-absent-${process.pid}` } })
    const response = await api(gateway, 'GET', '/api/panel/proxies')
    assert.equal(response.status, 200)
    const list = (response.json.data || response.json).proxies
    assert.ok(
      list
        .filter((item) => item.managed)
        .every((item) => item.managed_host_id === 'control-plane' && item.managed_host_name === '本机'),
    )
    assert.equal(list.find((item) => item.id === ownedId).removal_pending, true)
    for (const row of rows)
      assert.ok(list.some((item) => item.id === row.id && item.blocked_reason === 'managed_egress_not_ready'))
    await mkdir('.tmp/managed-egress-e2e', { recursive: true })
    await writeFile(
      '.tmp/managed-egress-e2e/api-receipt.json',
      JSON.stringify(
        {
          command: 'node --test test/e2e/managed-egress-api.e2e.test.mjs',
          scope: 'real gateway API; no slot or upstream traffic',
          source: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
          source_files: Object.fromEntries(
            await Promise.all(
              [
                'src/lib/vm/proxy-pool.mjs',
                'src/lib/admin/panel-routes.mjs',
                'test/e2e/managed-egress-api.e2e.test.mjs',
              ].map(async (file) => [
                file,
                createHash('sha256')
                  .update(await readFile(file))
                  .digest('hex'),
              ]),
            ),
          ),
          results: {
            invalid_link: 'rejected without secret echo',
            remote_host: 'unknown host rejected; non-administrator remote import denied',
            concurrent_import: 'unique ports',
            occupied_port: 'skipped',
            automatic_application_failure: 'saved row retained; explicit application_error; no false readiness',
            pending_bind: 'rejected',
            internal_reveal: 'rejected',
            gateway_restart: 'IDs preserved',
            ownership: 'authenticated owner retained; cross-owner deletion rejected',
          },
        },
        null,
        2,
      ),
    )
  } finally {
    await gateway?.stop()
    await new Promise((resolve) => occupied.close(resolve))
  }
})
