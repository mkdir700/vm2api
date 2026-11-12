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

// 失败方式：控制平面重启后没有恢复内核；调度暂停阻止恢复；恢复重建容器；恢复修改凭据。
// 真实 HTTP 控制平面与进程租约。Docker 和内核由独立进程夹具模拟。
for (const prewarm of [false, true]) test(`controller startup restores a running Hermit owner (prewarm=${prewarm})`, {
  skip: process.platform !== 'linux',
  timeout: 90000,
}, async () => {
  const project = fs.mkdtempSync(path.join(os.tmpdir(), 'hermit-restart-'))
  const out = path.resolve(process.env.HERMIT_RESTART_E2E_OUT || `.tmp/hermit-restart-${prewarm}-${Date.now()}`)
  fs.mkdirSync(out, { recursive: true })
  const checks = []
  const save = (name, value) => fs.writeFileSync(path.join(out, name), JSON.stringify(value, null, 2))
  const check = (name, ok) => {
    checks.push({ name, result: ok ? 'PASS' : 'FAIL' })
    save('checks.json', checks)
    assert.ok(ok, name)
  }
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
    ...(prewarm ? ['prewarm'] : []),
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
    let previousRoot
    for (let boot = 0; boot < 2; boot++) {
      gw = await start()
      check(`boot_${boot}_kernel_ready_before_first_request`, fs.existsSync(socket))
      const config = JSON.parse(fs.readFileSync(path.join(run, 'native-slot.json')))
      check(`boot_${boot}_capacity`, config.session_capacity === 20)
      check(`boot_${boot}_prewarm_capability_gated`, prewarm ? config.session_prewarm === true : !Object.hasOwn(config, 'session_prewarm'))
      check(`boot_${boot}_fresh_owner`, config.session.root !== previousRoot)
      previousRoot = config.session.root
      const login = await api(gw, 'POST', '/api/panel/login', { body: { username: 'admin', password: 'testpass' } })
      const response = await api(gw, 'GET', `/api/panel/vms/${vm.id}`, {
        headers: { cookie: login.headers.get('set-cookie') },
      })
      save(`boot-${boot}-panel.json`, response.json)
      const data = response.json.data || response.json
      check(
        `boot_${boot}_panel_kernel_healthy`,
        data.kernel?.rust_health?.status === 200 && data.kernel?.rust_health?.healthy !== false,
      )
      check(
        `boot_${boot}_container_preserved`,
        JSON.parse(fs.readFileSync(path.join(project, 'docker-state.json')))['kin-sim-01'].Id === 'fixture-pool',
      )
      const record = JSON.parse(fs.readFileSync(path.join(project, 'vms', `${vm.id}.json`)))
      check(`boot_${boot}_scheduling_pause_preserved`, record.schedule_off === true)
      check(
        `boot_${boot}_credentials_preserved`,
        createHash('sha256').update(fs.readFileSync(credential)).digest('hex') === credentialSha,
      )
      save(`boot-${boot}-stderr.json`, gw.stderr())
      await gw.stop()
      gw = null
      stopApiFixture()
      const until = Date.now() + 5000
      while (fs.existsSync(socket) && Date.now() < until) await new Promise((resolve) => setTimeout(resolve, 25))
      check(`boot_${boot}_owner_lease_stopped`, !fs.existsSync(socket))
    }
    const commands = fs
      .readFileSync(path.join(project, 'docker-commands.jsonl'), 'utf8')
      .trim()
      .split('\n')
      .map(JSON.parse)
    save('docker-commands.json', commands)
    check(
      'restoration_uses_two_owner_leases',
      commands.filter((args) => args[0] === 'exec' && args.includes('vm2api-slot')).length === 2,
    )
    check(
      'restoration_sends_no_container_lifecycle_command',
      commands.every((args) => !['run', 'start', 'stop', 'rm', 'rename', 'update'].includes(args[0])),
    )
    passed = true
  } finally {
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
