import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { startGateway, api } from '../harness.mjs'
import { startHermitReleaseOrigin } from '../fixtures/hermit-release-origin.mjs'

// Failure inventory: .planning/2026-11-12-vm2api-hermit-remote-install/task_plan.md.
test('Hermit remote pull verifies one release snapshot and reuses the package installer', {
  timeout: 90000,
}, async () => {
  const out = path.resolve(process.env.HERMIT_REMOTE_E2E_OUT || `.tmp/hermit-remote-${Date.now()}`)
  fs.mkdirSync(out, { recursive: true })
  const checks = []
  const check = (name, value) => {
    checks.push({ name, result: value ? 'PASS' : 'FAIL' })
    assert.ok(value, name)
  }
  const origin = await startHermitReleaseOrigin(path.join(out, 'origin'))
  const gw = await startGateway({ env: { KIN_KERNEL_TEST_ENDPOINTS: '1', KIN_HERMIT_RELEASES_URL: origin.url } })
  const endpoint = '/api/panel/kernel-packages/pull'
  const catalog = async () => (await api(gw, 'GET', '/api/panel/kernel-packages')).json.data
  const pull = (body = {}) => api(gw, 'POST', endpoint, { body })
  const recordFile = path.join(gw.project, 'vms/vm-sim-01.json')
  const before = fs.readFileSync(recordFile)
  try {
    const anonymous = await fetch(gw.baseUrl + endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    })
    check('anonymous_denied', anonymous.status === 401)
    const user = await api(gw, 'POST', '/api/panel/users', {
      body: { username: 'remote-reader', password: 'reader-pass', role: 'user' },
    })
    check('reader_created', user.status === 201)
    const login = await fetch(gw.baseUrl + '/api/panel/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: 'remote-reader', password: 'reader-pass' }),
    })
    const reader = await fetch(gw.baseUrl + endpoint, {
      method: 'POST',
      headers: { cookie: login.headers.get('set-cookie'), 'content-type': 'application/json' },
      body: '{}',
    })
    check('reader_denied_without_remote_fetch', reader.status === 403 && origin.requests.length === 0)
    check(
      'request_url_override_rejected',
      (await pull({ url: origin.url })).status === 400 && origin.requests.length === 0,
    )
    const first = await pull()
    check('pull_installs_real_package', first.status === 200 && (await catalog()).item.version === origin.version)
    check('cli_cache_used', origin.requests.filter((r) => r.path === '/cli').length === 1)
    check(
      'pinned_download_path',
      origin.requests.some((r) => r.path === `/v1/releases/${origin.version}/download`) &&
        !origin.requests.some((r) => r.path === '/v1/releases/latest/download'),
    )
    check(
      'credentials_not_forwarded',
      origin.requests.every((r) => !r.authorization),
    )
    const pointer = path.join(gw.project, 'share/kernel-packages/current.json')
    const current = fs.readFileSync(pointer)
    check('repeat_pull_idempotent', (await pull()).json.data.idempotent === true)
    for (const mode of [
      'unsafe-url',
      'other-origin',
      'redirect',
      'wrong-target',
      'too-large',
      'huge-metadata',
      'release-hash',
      'receipt-identity',
      'manifest-hash',
      'corrupt',
      'short',
      'oversized-stream',
      'oversized-header',
      'invalid-package',
      'unavailable',
    ]) {
      origin.setMode(mode)
      const result = await pull()
      check(mode + '_rejected', result.status >= 400 && result.json.ok === false)
      check(mode + '_preserves_current', current.equals(fs.readFileSync(pointer)))
    }
    origin.setMode('normal')
    const concurrent = await Promise.all([pull(), pull()])
    check(
      'concurrent_pulls_serialize',
      concurrent.every((result) => result.status === 200),
    )
    check('no_forbidden_requests', !origin.requests.some((r) => r.path === '/forbidden'))
    check('one_shared_cli_download', origin.requests.filter((r) => r.path === '/cli').length === 1)
    check('running_vm_and_credentials_preserved', before.equals(fs.readFileSync(recordFile)))
    fs.writeFileSync(path.join(out, 'catalog.json'), JSON.stringify(await catalog(), null, 2))
    fs.writeFileSync(
      path.join(out, 'summary.json'),
      JSON.stringify(
        { result: 'PASS', checks: checks.length, vm_activation: 'NOT RUN', live_provider: 'NOT RUN' },
        null,
        2,
      ),
    )
  } finally {
    fs.writeFileSync(path.join(out, 'checks.json'), JSON.stringify(checks, null, 2))
    fs.writeFileSync(path.join(out, 'remote-requests.json'), JSON.stringify(origin.requests, null, 2))
    await gw.stop()
    await origin.close()
    fs.rmSync(gw.project, { recursive: true, force: true })
  }
})
