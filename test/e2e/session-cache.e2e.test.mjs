import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import http from 'node:http'
import { startGateway, seedVm, api } from '../harness.mjs'

// Failure inventory: selected session-cache plan. Real panel HTTP and UDS hop;
// the native model/owner boundary is qualified separately by the pinned CLI.
test('session cache panel preserves filtering, authentication and unsupported kernel errors', {
  timeout: 60000,
}, async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'session-cache-'))
  const out = path.resolve(process.env.SESSION_CACHE_E2E_OUT || `.tmp/session-cache-${Date.now()}`)
  fs.mkdirSync(out, { recursive: true })
  let gw
  let native
  let complete = false
  let old = false
  const checks = []
  const calls = []
  const check = (name, value) => {
    checks.push({ name, result: value ? 'PASS' : 'FAIL' })
    assert.ok(value, name)
  }
  try {
    const vm = seedVm({ project: root })
    vm.dataplane = 'hermit'
    fs.writeFileSync(path.join(root, 'vms/vm-sim-01.json'), JSON.stringify(vm))
    const run = path.dirname(vm.runtime.worker_socket)
    fs.mkdirSync(run, { recursive: true })
    fs.writeFileSync(path.join(run, 'internal.token'), 'synthetic-session-cache-token', { mode: 0o600 })
    native = http.createServer((req, res) => {
      res.setHeader('content-type', 'application/json')
      if (req.headers['x-kin-internal-token'] !== 'synthetic-session-cache-token') {
        res.writeHead(401)
        return res.end('{}')
      }
      if (req.url === '/internal/health')
        return res.end(JSON.stringify({ ok: true, healthy: true, runtime_flavor: 'hermit' }))
      calls.push(req.url)
      if (old) {
        res.writeHead(404)
        return res.end(JSON.stringify({ error: { code: 'not_found_error' } }))
      }
      const session = new URL(req.url, 'http://slot').searchParams.get('session')
      res.end(
        JSON.stringify({
          schema_version: 1,
          scope: 'recent_kernel_generation',
          requests:
            session === 'visible-session'
              ? [
                  {
                    external_session_id: session,
                    routing_session_id: 'routing-session',
                    purpose: 'classifier',
                    parent_branch_id: null,
                  },
                ]
              : [],
          branches: [],
          retention: { request_limit: 128, resets_on_restart: true },
        }),
      )
    })
    await new Promise((resolve) => native.listen(path.join(run, 'kernel.sock'), resolve))
    gw = await startGateway({ project: root })
    const denied = await api(gw, 'GET', '/api/panel/vms/vm-sim-01/session-cache', { headers: { authorization: '' } })
    check('unauthenticated_denied', denied.status === 401)
    const created = await api(gw, 'POST', '/api/panel/users', {
      body: { username: 'cache-reader', password: 'synthetic-reader-pass', role: 'user' },
    })
    check('create_tenant_fixture', created.status === 201 || created.status === 200)
    const login = await fetch(gw.baseUrl + '/api/panel/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: 'cache-reader', password: 'synthetic-reader-pass' }),
    })
    check('tenant_login', login.status === 200)
    const before = calls.length
    const tenant = await api(gw, 'GET', '/api/panel/vms/vm-sim-01/session-cache', {
      headers: { authorization: '', cookie: login.headers.get('set-cookie') },
    })
    check('tenant_denied_before_kernel', tenant.status === 403 && calls.length === before)
    const result = await api(gw, 'GET', '/api/panel/vms/vm-sim-01/session-cache?session=visible-session')
    check(
      'authenticated_snapshot',
      result.status === 200 && (result.json.data || result.json).requests[0].external_session_id === 'visible-session',
    )
    check('filter_reaches_kernel', calls.includes('/internal/session-cache?session=visible-session'))
    const empty = await api(gw, 'GET', '/api/panel/vms/vm-sim-01/session-cache?session=missing')
    check('missing_session_is_empty', (empty.json.data || empty.json).requests.length === 0)
    old = true
    const unsupported = await api(gw, 'GET', '/api/panel/vms/vm-sim-01/session-cache')
    check('old_kernel_is_explicitly_unavailable', unsupported.status === 404 && unsupported.json.ok === false)
    check('unknown_vm', (await api(gw, 'GET', '/api/panel/vms/missing/session-cache')).status === 404)
    complete = true
  } finally {
    await gw?.stop()
    if (native) await new Promise((resolve) => native.close(resolve))
    fs.writeFileSync(
      path.join(out, 'summary.json'),
      JSON.stringify({ result: complete ? 'PASS' : 'FAIL', checks, calls }, null, 2) + '\n',
    )
    fs.rmSync(root, { recursive: true, force: true })
  }
})
