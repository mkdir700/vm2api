import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import http from 'node:http'
import { once } from 'node:events'
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { installKernelPackage } from '../../src/lib/vm/kernel-packages.mjs'
import { writeWorkerCredentialFile } from '../../src/lib/oauth/oauth-credentials.mjs'
import { startGateway, seedVm, api, REPO_ROOT } from '../harness.mjs'

// Failure inventory: missing config; active or pending owners stopped; unknown health allows restart;
// repeated saves lose latest limit; credential/container changes; process leases leak.
// Real HTTP settings and controller process leases; synthetic Docker/kernel adapter.
test('one panel request limit reaches Hermit and applies only after native idle', {
  timeout: 120000,
}, async () => {
  const project = fs.mkdtempSync(path.join('/tmp', 'hrl-gw-'))
  const out = path.resolve(process.env.HERMIT_REQUEST_LIMIT_E2E_OUT || `.tmp/hermit-request-limit-${Date.now()}`)
  fs.mkdirSync(out, { recursive: true })
  const checks = []
  const save = (name, value) => fs.writeFileSync(path.join(out, name), JSON.stringify(value, null, 2))
  const check = (name, ok) => {
    checks.push({ name, result: ok ? 'PASS' : 'FAIL' })
    save('checks.json', checks)
    assert.ok(ok, name)
  }
  const supported = process.env.HERMIT_REQUEST_LIMIT_LEGACY !== '1'
  const vm = seedVm({ project })
  const cli = Buffer.alloc(4096)
  Buffer.from([0x7f, 0x45, 0x4c, 0x46, 2, 1]).copy(cli)
  cli.writeUInt16LE(2, 16)
  cli.writeUInt16LE(62, 18)
  const upstream = http.createServer((_req, res) => res.end(cli))
  upstream.listen(0, '127.0.0.1')
  await once(upstream, 'listening')
  const fixture = path.join(project, 'fixture')
  fs.mkdirSync(fixture)
  execFileSync('python3', [
    path.join(REPO_ROOT, 'test/fixtures/hermit-page-package.py'),
    fixture,
    `http://127.0.0.1:${upstream.address().port}/cli`,
    createHash('sha256').update(cli).digest('hex'),
    'production',
    'pool',
    ...(supported ? ['request-limit'] : []),
  ])
  const receipt = JSON.parse(fs.readFileSync(path.join(fixture, 'release.json')))
  const previous = process.env.KIN_KERNEL_TEST_ENDPOINTS
  process.env.KIN_KERNEL_TEST_ENDPOINTS = '1'
  try {
    await installKernelPackage(project, fs.readFileSync(path.join(fixture, 'package.tar.gz')), {
      ...receipt.archive,
      manifest_sha256: receipt.manifest_sha256,
    })
  } finally {
    if (previous === undefined) delete process.env.KIN_KERNEL_TEST_ENDPOINTS
    else process.env.KIN_KERNEL_TEST_ENDPOINTS = previous
  }
  vm.dataplane = 'hermit'
  vm.kernel_package = {
    runtime: 'hermit',
    target: 'linux-amd64',
    version: '0.2.0-ui-e2e',
    native_session_pool: true,
    manifest_sha256: receipt.manifest_sha256,
  }
  vm.proxy = { id: 'px-local', scheme: 'direct' }
  vm.claude.mode = 'apikey'
  writeWorkerCredentialFile(path.join(project, 'vms', vm.id, 'cli-home'), {
    type: 'apikey',
    api_key: 'sk-ant-api03-synthetic-pool-key',
  })
  const bin = path.join(project, 'bin')
  fs.mkdirSync(bin)
  fs.copyFileSync(path.join(REPO_ROOT, 'test/fixtures/kernel-install-docker.py'), path.join(bin, 'docker'))
  fs.chmodSync(path.join(bin, 'docker'), 0o755)
  fs.writeFileSync(
    path.join(project, 'docker-state.json'),
    JSON.stringify({
      'kin-sim-01': {
        Id: 'fixture-pool',
        State: { Running: true },
        Config: { Labels: { 'kin.vm.id': vm.id, 'kin.vm.role': 'hermit' } },
        HostConfig: { RestartPolicy: { Name: 'unless-stopped' } },
      },
    }),
  )
  vm.policy.sessionSlots = 20
  vm.schedule_off = true
  fs.writeFileSync(path.join(project, 'vms', `${vm.id}.json`), JSON.stringify(vm))
  const routing = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'src/config/routing.json')))
  routing.failover.max_request_mib = 8
  routing.inference.session_slots = 20
  routing.pool.fallback_wait_timeout_ms = 100
  routing.pool.sticky_wait_timeout_ms = 100
  routing.failover.total_retry_deadline_ms = 1000
  fs.mkdirSync(path.join(project, 'config'), { recursive: true })
  fs.writeFileSync(path.join(project, 'config/routing.json'), JSON.stringify(routing))
  let gw
  let passed = false
  const run = path.join(project, 'vms', vm.id, 'run')
  const socket = path.join(run, 'kernel.sock')
  const credential = path.join(project, 'vms', vm.id, 'cli-home/.claude/credentials.json')
  const credentialSha = createHash('sha256').update(fs.readFileSync(credential)).digest('hex')
  const stopApiFixture = () => {
    const file = path.join(project, 'api-fixture.pid')
    if (fs.existsSync(file))
      try {
        process.kill(Number(fs.readFileSync(file)), 'SIGTERM')
      } catch {}
  }
  const start = () =>
    startGateway({
      project,
      readyMs: 30000,
      env: {
        KIN_CRS_MOCK: '0',
        KIN_DOCKER_BIN: path.join(bin, 'docker'),
        KIN_API_KERNEL_BIN: path.join(bin, 'docker'),
        KERNEL_INSTALL_FIXTURE: project,
        KIN_KERNEL_TEST_ENDPOINTS: '1',
        KIN_HERMIT_UPSTREAM_URL: `http://127.0.0.1:${upstream.address().port}`,
        PATH: `${bin}:${process.env.PATH}`,
      },
    })
  try {
    gw = await start()
    const login = await api(gw, 'POST', '/api/panel/login', { body: { username: 'admin', password: 'testpass' } })
    const headers = { cookie: login.headers.get('set-cookie') }
    const configPath = path.join(run, 'native-slot.json')
    const config = () => JSON.parse(fs.readFileSync(configPath))
    const originalRoot = config().session.root
    if (!supported) {
      check('legacy_config_format_preserved', config().max_request_bytes === undefined)
      const saved = await api(gw, 'PUT', '/api/panel/routing', {
        headers,
        body: { failover: { ...routing.failover, max_request_mib: 64 } },
      })
      save('legacy-save.json', saved.json)
      check(
        'legacy_unsupported_is_reported',
        saved.status === 200 && saved.json.data.kernel_persona.unsupported_request_limit.includes(vm.id),
      )
      await new Promise((resolve) => setTimeout(resolve, 500))
      check(
        'legacy_owner_is_not_restarted',
        config().session.root === originalRoot && config().max_request_bytes === undefined,
      )
      await gw.stop()
      gw = null
      stopApiFixture()
      const until = Date.now() + 5000
      while (fs.existsSync(socket) && Date.now() < until) await new Promise((resolve) => setTimeout(resolve, 25))
      check('legacy_owner_stopped_at_fixture_cleanup', !fs.existsSync(socket))
      passed = true
      return
    }
    check('initial_config_gets_panel_limit', config().max_request_bytes === 8 * 1024 * 1024)
    const largeInvalidBody = { synthetic_padding: 'A'.repeat(8 * 1024 * 1024) }
    const outerRejected = await api(gw, 'POST', '/v1/messages', { body: largeInvalidBody })
    save('outer-8mib.json', { status: outerRejected.status, body: outerRejected.json })
    check('external_ingress_enforces_8mib', outerRejected.status === 413)
    const healthFile = path.join(project, 'fixture-health.json')
    const health = (fields) => fs.writeFileSync(healthFile, JSON.stringify(fields))
    const saveLimit = async (mib) => {
      const saved = await api(gw, 'PUT', '/api/panel/routing', {
        headers,
        body: { failover: { ...routing.failover, max_request_mib: mib } },
      })
      save('save-' + mib + '.json', saved.json)
      check('setting_saved_' + mib, saved.status === 200)
      return saved
    }
    health({ active_requests: 0, pending_tool_results: 1, switch_ready: false })
    await saveLimit(64)
    const outerAccepted = await api(gw, 'POST', '/v1/messages', { body: largeInvalidBody })
    save('outer-64mib.json', { status: outerAccepted.status, body: outerAccepted.json })
    check('external_ingress_hot_applies_64mib', outerAccepted.status === 400)
    await new Promise((resolve) => setTimeout(resolve, 500))
    check('pending_tool_owner_not_restarted', config().session.root === originalRoot)
    check('new_limit_written_without_replacing_root', config().max_request_bytes === 64 * 1024 * 1024)
    health({ active_requests: 1, pending_tool_results: 0, switch_ready: false })
    await saveLimit(128)
    await new Promise((resolve) => setTimeout(resolve, 500))
    check('active_request_not_restarted', config().session.root === originalRoot)
    health({ healthy: false, active_requests: 0, pending_tool_results: 0, switch_ready: true })
    await saveLimit(64)
    await new Promise((resolve) => setTimeout(resolve, 500))
    check('unhealthy_kernel_not_restarted', config().session.root === originalRoot)
    health({ healthy: true, active_requests: 0, pending_tool_results: 0, switch_ready: true })
    const deadline = Date.now() + 25000
    while (config().session.root === originalRoot && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 100))
    }
    check('idle_change_restarts_owner', config().session.root !== originalRoot)
    check('latest_limit_survives_restart', config().max_request_bytes === 64 * 1024 * 1024)
    check(
      'credentials_preserved',
      createHash('sha256').update(fs.readFileSync(credential)).digest('hex') === credentialSha,
    )
    check(
      'container_preserved',
      JSON.parse(fs.readFileSync(path.join(project, 'docker-state.json')))['kin-sim-01'].Id === 'fixture-pool',
    )
    await gw.stop()
    gw = null
    stopApiFixture()
    const until = Date.now() + 5000
    while (fs.existsSync(socket) && Date.now() < until) await new Promise((resolve) => setTimeout(resolve, 25))
    check('owner_lease_stopped', !fs.existsSync(socket))
    const commands = fs
      .readFileSync(path.join(project, 'docker-commands.jsonl'), 'utf8')
      .trim()
      .split('\n')
      .map(JSON.parse)
    save('docker-commands.json', commands)
    check(
      'only_one_idle_restart',
      commands.filter((args) => args[0] === 'exec' && args.includes('vm2api-slot')).length === 2,
    )
    check(
      'no_container_lifecycle_command',
      commands.every(
        (args) =>
          !['start', 'stop', 'rm', 'rename', 'update'].includes(args[0]) &&
          (args[0] !== 'run' || (args.includes('--network') && args.includes('none') && args.includes('python3'))),
      ),
    )
    passed = true
  } finally {
    for (const file of ['docker-commands.jsonl', 'docker-state.json']) {
      if (fs.existsSync(path.join(project, file))) fs.copyFileSync(path.join(project, file), path.join(out, file))
    }
    if (fs.existsSync(path.join(run, 'hermit-stderr.log')))
      fs.copyFileSync(path.join(run, 'hermit-stderr.log'), path.join(out, 'hermit-stderr.log'))
    if (gw) {
      save('failure-stderr.json', gw.stderr())
      await gw.stop()
    }
    stopApiFixture()
    upstream.close()
    save('summary.json', {
      result: passed ? 'PASS' : 'FAIL',
      checks,
      boundary:
        'real controller startup, HTTP readiness and owner leases; simulated Docker and kernel; no provider inference',
    })
    fs.rmSync(project, { recursive: true, force: true })
  }
})
