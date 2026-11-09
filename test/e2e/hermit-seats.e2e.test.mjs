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

// 失败方式：子 agent 共用席位；工具返回后提前释放；续接占新席位；容量满时拒绝原 agent。
// 使用真实 HTTP 服务、身份改写和调度器。仅模拟内核响应。
test('Hermit reserves one seat per agent until the tool continuation completes', {
  skip: process.platform !== 'linux',
  timeout: 90000,
}, async () => {
  const project = fs.mkdtempSync(path.join(os.tmpdir(), 'hermit-seats-'))
  const out = path.resolve(process.env.HERMIT_SEATS_E2E_OUT || `.tmp/hermit-seats-${Date.now()}`)
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
  try {
    gw = await startGateway({
      project,
      scenario: 'tool_cycle',
      env: {
        KIN_DOCKER_BIN: path.join(bin, 'docker'),
        KIN_API_KERNEL_BIN: path.join(bin, 'docker'),
        KERNEL_INSTALL_FIXTURE: project,
        KIN_KERNEL_TEST_ENDPOINTS: '1',
        KIN_HERMIT_UPSTREAM_URL: `http://127.0.0.1:${upstream.address().port}`,
      },
    })
    const login = await api(gw, 'POST', '/api/panel/login', { body: { username: 'admin', password: 'testpass' } })
    const panelHeaders = { cookie: login.headers.get('set-cookie') }
    const snapshot = async (name) => {
      const response = await api(gw, 'GET', `/api/panel/vms/${vm.id}`, { headers: panelHeaders })
      save(name, response.json)
      return response.json.data?.vm || response.json.data || response.json
    }
    const root = '10101010-1010-4010-8010-101010101010'
    const request = (agent, messages, stream = false) =>
      api(gw, 'POST', '/v1/messages', {
        headers: { 'x-claude-code-session-id': root, 'x-claude-code-agent-id': agent },
        body: {
          model: 'claude-haiku-4-5-20251001',
          max_tokens: 32,
          stream,
          metadata: { user_id: JSON.stringify({ device_id: 'pool-device', session_id: root }) },
          tools: [{ name: 'read_file', input_schema: { type: 'object' } }],
          messages,
        },
      })
    const initial = [{ role: 'user', content: 'POOL_WORKFLOW' }]
    const responses = []
    for (let index = 0; index < 20; index++) {
      const response = await request(index === 0 ? '' : `child-${index}`, initial, index === 1)
      responses.push({ status: response.status, body: response.json || response.text })
      save('responses.json', responses)
      check(
        `agent_${index}_tool_call`,
        response.status === 200 &&
          (response.json?.stop_reason === 'tool_use' || response.text.includes('"stop_reason":"tool_use"')),
      )
    }
    const full = await snapshot('seats-full.json')
    check('twenty_distinct_pending_seats', full.seats_used === 20 && full.seats_max === 20)
    const overflow = await request('child-overflow', initial)
    save('overflow.json', { status: overflow.status, body: overflow.json })
    check('twenty_first_agent_waits_or_rejects', overflow.status !== 200)
    const first = responses[0].body
    const use = first.content.find((block) => block.type === 'tool_use')
    const finished = await request('', [
      ...initial,
      { role: 'assistant', content: first.content },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: use.id, content: 'external receipt' }] },
    ])
    save('parent-finished.json', finished.json)
    check('parent_continues_at_full_capacity', finished.status === 200 && finished.json.stop_reason === 'end_turn')
    check('only_parent_seat_released', (await snapshot('seats-after-parent.json')).seats_used === 19)
    const replacement = await request('child-overflow', initial)
    check('new_agent_uses_released_seat', replacement.status === 200 && replacement.json.stop_reason === 'tool_use')
    check('capacity_returns_to_twenty', (await snapshot('seats-after-replacement.json')).seats_used === 20)
    const config = JSON.parse(fs.readFileSync(path.join(project, 'vms', vm.id, 'run/native-slot.json')))
    save('native-slot.json', {
      session_capacity: config.session_capacity,
      session_idle_ttl_seconds: config.session_idle_ttl_seconds,
    })
    check('kernel_receives_vm_capacity', config.session_capacity === 20 && config.session_idle_ttl_seconds === 600)
    passed = true
  } finally {
    if (gw) {
      save('server-stderr.json', gw.stderr())
      await gw.stop()
    }
    upstream.close()
    if (fs.existsSync(path.join(project, 'api-fixture.pid'))) {
      try {
        process.kill(Number(fs.readFileSync(path.join(project, 'api-fixture.pid'))), 'SIGTERM')
      } catch {}
    }
    save('summary.json', {
      result: passed ? 'PASS' : 'FAIL',
      checks,
      boundary: 'real gateway HTTP and scheduler; mock kernel; no provider calls',
    })
    fs.rmSync(project, { recursive: true, force: true })
  }
})
