import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import http from 'node:http'
import crypto from 'node:crypto'
import { gunzipSync } from 'node:zlib'
import { once } from 'node:events'
import { installKernelPackage } from '../../src/lib/vm/kernel-packages.mjs'
import { writeWorkerCredentialFile } from '../../src/lib/oauth/oauth-credentials.mjs'
import { startGateway, seedVm, api, REPO_ROOT } from '../harness.mjs'

// Cache failure inventory: docs/operations/native-system-cache-e2e.md.
// 失败方式见 ADR 0071：能力门控失效、预热提前发送模型请求、领取或工具续接
// 使用不同 owner、阶段计时丢失、控制面退出后残留进程。只模拟 Docker 执行边界。
test('HTTP controller uses real Hermit prewarm and preserves native tool ownership', {
  skip: process.platform !== 'linux' || !process.env.HERMIT_PREWARM_ARCHIVE,
  timeout: 180000,
}, async () => {
  const out = path.resolve(process.env.HERMIT_PREWARM_OUT)
  fs.mkdirSync(out, { recursive: true })
  const project = fs.mkdtempSync('/tmp/hp-')
  const key = 'sk-ant-api03-prewarm-isolated-key'
  const checks = [],
    captures = []
  const save = (name, data) => fs.writeFileSync(path.join(out, name), JSON.stringify(data, null, 2) + '\n')
  const check = (name, ok) => {
    checks.push({ name, result: ok ? 'PASS' : 'FAIL' })
    save('checks.json', checks)
    assert.ok(ok, name)
  }
  const server = http.createServer(async (req, res) => {
    const chunks = []
    for await (const chunk of req) chunks.push(chunk)
    if (!req.url.split('?')[0].endsWith('/v1/messages')) {
      res.setHeader('content-type', 'application/json')
      return res.end('{"data":[],"has_more":false,"input_tokens":10}')
    }
    let raw = Buffer.concat(chunks)
    if (req.headers['content-encoding'] === 'gzip') raw = gunzipSync(raw)
    const body = JSON.parse(raw)
    captures.push(body)
    save('provider-requests.json', captures)
    const tool = captures.length === 1
    const block = tool
      ? {
          type: 'tool_use',
          id: 'native_prewarm_probe',
          name: body.tools.find((t) => t.name.endsWith('__Probe')).name,
          input: {},
        }
      : { type: 'text', text: '' }
    const events = [
      {
        type: 'message_start',
        message: {
          id: 'native_prewarm_' + captures.length,
          type: 'message',
          role: 'assistant',
          model: body.model,
          content: [],
          stop_reason: null,
          usage: {
            input_tokens: 10,
            output_tokens: 1,
            cache_read_input_tokens: captures.length === 1 ? 0 : 4096,
            cache_creation_input_tokens: 512,
            cache_creation: { ephemeral_1h_input_tokens: 512, ephemeral_5m_input_tokens: 0 },
          },
        },
      },
      { type: 'content_block_start', index: 0, content_block: block },
      {
        type: 'content_block_delta',
        index: 0,
        delta: tool
          ? { type: 'input_json_delta', partial_json: '{"label":"external"}' }
          : { type: 'text_delta', text: 'PREWARM_DONE' },
      },
      { type: 'content_block_stop', index: 0 },
      {
        type: 'message_delta',
        delta: { stop_reason: tool ? 'tool_use' : 'end_turn', stop_sequence: null },
        usage: { output_tokens: 10 },
      },
      { type: 'message_stop' },
    ]
    res.setHeader('content-type', 'text/event-stream')
    res.end(events.map((e) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join(''))
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  let gw,
    nativeRoot,
    passed = false
  try {
    const receipt = JSON.parse(fs.readFileSync(process.env.HERMIT_PREWARM_RECEIPT))
    const cli = process.env.HERMIT_PREWARM_CLI
    const digest = crypto.createHash('sha256').update(fs.readFileSync(cli)).digest('hex')
    const cache = path.join(project, 'share/kernel-packages/cli', digest)
    fs.mkdirSync(cache, { recursive: true })
    fs.copyFileSync(cli, path.join(cache, 'claude'))
    fs.chmodSync(path.join(cache, 'claude'), 0o555)
    process.env.KIN_KERNEL_TEST_ENDPOINTS = '1'
    await installKernelPackage(project, fs.readFileSync(process.env.HERMIT_PREWARM_ARCHIVE), {
      ...receipt.archive,
      manifest_sha256: receipt.manifest_sha256,
    })
    const vm = seedVm({ project, id: 'vm-hermit' })
    vm.dataplane = 'hermit'
    vm.proxy = { id: 'px-local', scheme: 'direct' }
    vm.claude.mode = 'apikey'
    vm.policy.sessionSlots = 2
    vm.kernel_package = {
      runtime: 'hermit',
      target: 'linux-amd64',
      version: receipt.version,
      manifest_sha256: receipt.manifest_sha256,
      native_session_pool: true,
    }
    fs.writeFileSync(path.join(project, 'vms/vm-hermit.json'), JSON.stringify(vm))
    writeWorkerCredentialFile(path.join(project, 'vms/vm-hermit/cli-home'), { type: 'apikey', api_key: key })
    const routing = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'src/config/routing.json')))
    routing.compatibility.official_cc_passthrough = true
    routing.compatibility.persona_preset = 'native_server'
    routing.compatibility.cache_ttl = '1h'
    routing.kernel_watchdog = { enabled: false }
    routing.credential_refresh = { enabled: false }
    routing.inference = { ...routing.inference, session_slots: 2, health_ttl_ms: 0 }
    fs.mkdirSync(path.join(project, 'config'))
    fs.writeFileSync(path.join(project, 'config/routing.json'), JSON.stringify(routing))
    const run = path.join(project, 'vms/vm-hermit/run'),
      pool = path.join(project, 'share/kernel-packages')
    fs.mkdirSync(run, { recursive: true })
    const docker = path.join(project, 'docker')
    // 使用真实 Hermit 子进程。仅将槽内路径映射至本次隔离临时目录。
    fs.writeFileSync(
      docker,
      `#!/usr/bin/python3
import sys,os,json
from pathlib import Path
pool=${JSON.stringify(pool)};run=${JSON.stringify(run)}
a=sys.argv[1:]
if a[0]=='inspect':
 if 'HostConfig.Init' in ' '.join(a):print('true');raise SystemExit(0)
 print(json.dumps([{'Destination':'/opt/kin-kernel-packages','RW':False}]) if 'Mounts' in ' '.join(a) else json.dumps(['sleep','infinity']));raise SystemExit(0)
if a[0]!='exec':raise SystemExit(1)
a=a[1:]
while a and a[0].startswith('-'):
 flag=a.pop(0)
 if flag in ['-u','-e','-w']:a.pop(0)
a.pop(0)
if a[0]=='python3':os.execv('/usr/bin/python3',a)
binary=a[0].replace('/opt/kin-kernel-packages',pool)
raw=(Path(run)/'native-slot.json').read_text().replace('/opt/kin-kernel-packages',pool).replace('/run/kin',run).replace('/home/kincli/.claude/credentials.json',str(Path(run).parent/'cli-home/.claude/credentials.json'))
translated=Path(run)/'translated.json';translated.write_text(raw);translated.chmod(0o600)
os.execv(binary,[binary,'--mode','vm2api-slot','--config',str(translated)])
`,
      { mode: 0o700 },
    )
    gw = await startGateway({
      project,
      apiKey: key,
      readyMs: 25000,
      timeoutMs: 60000,
      env: {
        KIN_CRS_MOCK: '0',
        KIN_KERNEL_BIN: process.execPath,
        KIN_API_KERNEL_BIN: process.env.HERMIT_PREWARM_API_KERNEL,
        KIN_DOCKER_BIN: docker,
        KIN_KERNEL_TEST_ENDPOINTS: '1',
        KIN_HERMIT_UPSTREAM_URL: `http://127.0.0.1:${server.address().port}/inner`,
      },
    })
    const login = await api(gw, 'POST', '/api/panel/login', { body: { username: 'admin', password: 'testpass' } })
    check('admin_login', login.status === 200)
    const headers = { cookie: login.headers.get('set-cookie') }
    const snapshot = async () => {
      const response = await api(gw, 'GET', '/api/panel/vms/vm-hermit/session-cache', { headers })
      save('session-cache.json', response.json)
      return response.json?.data
    }
    let state
    const deadline = Date.now() + 25000
    do {
      state = await snapshot()
      if (state?.pool?.prewarm_ready === 1) break
      await new Promise((resolve) => setTimeout(resolve, 100))
    } while (Date.now() < deadline)
    check(
      'controller_exposes_real_prewarm',
      state?.pool?.prewarm_ready === 1 && state.pool.prewarm_stage === 'cli_ready',
    )
    check('prewarm_makes_no_model_request', captures.length === 0)
    const config = JSON.parse(fs.readFileSync(path.join(run, 'native-slot.json')))
    nativeRoot = config.session.root.replace('/run/kin', run)
    check('capability_sets_private_flag', config.session_prewarm === true && config.session_capacity === 2)
    const initial = [{ role: 'user', content: 'PREWARM_INTEGRATION' }]
    const request = (messages, { stream = false, system = 'SYNTHETIC_FIXED_CACHE_PREFIX' } = {}) =>
      api(gw, 'POST', '/v1/messages', {
        headers: { 'x-claude-code-session-id': '10101010-1010-4010-8010-101010101010' },
        body: {
          model: 'claude-sonnet-4-6',
          max_tokens: 128,
          stream,
          system,
          metadata: {
            user_id: JSON.stringify({
              device_id: 'prewarm-device',
              session_id: '10101010-1010-4010-8010-101010101010',
            }),
          },
          tools: [{ name: 'Probe', input_schema: { type: 'object', properties: { label: { type: 'string' } } } }],
          messages,
        },
      })
    const first = await request(initial)
    save('first.json', first.json)
    check('real_cli_returns_external_tool', first.status === 200 && first.json.stop_reason === 'tool_use')
    const use = first.json.content.find((block) => block.type === 'tool_use')
    const continued = [
      ...initial,
      { role: 'assistant', content: first.json.content },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: use.id, content: 'EXTERNAL_RECEIPT' }] },
      { role: 'system', content: 'SYNTHETIC_PER_TURN_BUDGET_9000' },
    ]
    const second = await request(continued)
    save('second.json', second.json)
    check('real_cli_continues_tool_result', second.status === 200 && second.json.stop_reason === 'end_turn')
    state = await snapshot()
    check(
      'claim_and_reuse_visible_in_panel',
      state.requests.length === 2 &&
        state.requests[0].selection === 'prewarm_claimed' &&
        state.requests[1].selection === 'owner_reused',
    )
    check('same_owner_retains_tool_history', state.requests[0].native_owner === state.requests[1].native_owner)
    check(
      'actual_upstream_timing_visible_in_panel',
      state.requests.every((r) => r.upstream_timing?.first_protocol_ms != null && r.timings_ms?.pool_wait != null),
    )
    check('exact_provider_count', captures.length === 2)
    check(
      'assembled_cache_usage_preserved',
      second.json.usage.cache_read_input_tokens === 4096 && second.json.usage.cache_creation_input_tokens === 512,
    )
    const clean = (value) =>
      JSON.parse(JSON.stringify(value, (key, item) => (key === 'cache_control' ? undefined : item)))
    const fixedSystem = JSON.stringify(clean(captures[0].system))
    const fixedTools = JSON.stringify(clean(captures[0].tools))
    let history = [...continued, { role: 'assistant', content: second.json.content }]
    for (let round = 2; round <= 5; round++) {
      history.push(
        { role: 'user', content: `SYNTHETIC_CONTINUE_${round}` },
        { role: 'system', content: `SYNTHETIC_PER_TURN_BUDGET_${9000 - round}` },
      )
      const reply = await request(history, { stream: true })
      check(`stream_${round}_completed`, reply.status === 200)
      const events = reply.text
        .split('\n')
        .filter((line) => line.startsWith('data:'))
        .map((line) => JSON.parse(line.slice(5)))
      const start = events.find((event) => event.type === 'message_start')
      check(
        `stream_${round}_cache_usage`,
        start?.message?.usage?.cache_read_input_tokens === 4096 &&
          start?.message?.usage?.cache_creation_input_tokens === 512,
      )
      const content = events
        .filter((event) => event.type === 'content_block_delta' && event.delta?.type === 'text_delta')
        .map((event) => event.delta.text)
        .join('')
      history.push({ role: 'assistant', content: [{ type: 'text', text: content }] })
    }
    state = await snapshot()
    check(
      'all_append_only_turns_reuse_owner',
      state.requests.length === 6 &&
        new Set(state.requests.map((row) => row.native_owner)).size === 1 &&
        state.requests.slice(1).every((row) => row.selection === 'owner_reused'),
    )
    for (let i = 1; i < captures.length; i++) {
      check(`provider_${i}_fixed_system`, JSON.stringify(clean(captures[i].system)) === fixedSystem)
      check(`provider_${i}_fixed_tools`, JSON.stringify(clean(captures[i].tools)) === fixedTools)
      check(
        `provider_${i}_retains_history`,
        JSON.stringify(clean(captures[i].messages.slice(0, captures[i - 1].messages.length))) ===
          JSON.stringify(clean(captures[i - 1].messages)),
      )
    }
    check(
      'provider_ttl_1h',
      captures.every((body) => JSON.stringify(body).includes('"ttl":"1h"')),
    )
    const negative = await request([...history, { role: 'user', content: 'SYNTHETIC_CHANGED_PREFIX' }], {
      system: 'SYNTHETIC_REPLACED_CACHE_PREFIX',
    })
    check('changed_system_completes', negative.status === 200)
    state = await snapshot()
    check(
      'changed_system_replaces_owner',
      state.requests.at(-1).selection === 'context_replacement' &&
        state.requests.at(-1).native_owner !== state.requests[0].native_owner,
    )
    check('negative_control_changes_provider_system', JSON.stringify(clean(captures.at(-1).system)) !== fixedSystem)
    save('cache-contract.json', {
      simulated_usage_only: true,
      real_provider_cache: 'NOT RUN',
      calls: captures.length,
      owners: state.requests.map((row) => row.native_owner),
    })
    passed = true
  } finally {
    try {
      if (gw) {
        save('server-stderr.json', gw.stderr())
        await gw.stop()
      }
      if (nativeRoot && fs.existsSync(nativeRoot)) {
        const readOwners = () =>
          fs
            .readdirSync(nativeRoot)
            .filter((n) => n.startsWith('s-'))
            .map((n) => JSON.parse(fs.readFileSync(path.join(nativeRoot, n, 'owner.json'))))
        let owners = readOwners()
        const stoppedBy = Date.now() + 30000
        while (owners.some((owner) => !owner.groups_gone) && Date.now() < stoppedBy) {
          await new Promise((resolve) => setTimeout(resolve, 100))
          owners = readOwners()
        }
        save('owners-after-stop.json', owners)
        const stopped = owners.length >= 2 && owners.every((owner) => owner.groups_gone)
        if (!stopped) passed = false
        check('all_owned_process_groups_stopped', stopped)
      }
    } catch (error) {
      passed = false
      throw error
    } finally {
      const closed = once(server, 'close')
      server.closeAllConnections()
      server.close()
      await closed
      save('summary.json', {
        result: passed ? 'PASS' : 'FAIL',
        checks,
        real_provider: 'NOT RUN',
        boundary: '真实 HTTP 控制面、Hermit、CLI 和模拟上游；Docker 执行边界由独立可执行夹具模拟',
      })
      fs.rmSync(project, { recursive: true, force: true })
    }
  }
})
