// 完整 HTTP 服务与真实内层、外层 CLI。Docker 边界由独立可执行适配器模拟。
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import http from 'node:http'
import net from 'node:net'
import crypto from 'node:crypto'
import { spawn, execFileSync } from 'node:child_process'
import { once } from 'node:events'
import { DatabaseSync } from 'node:sqlite'
import { startGateway, seedVm, api, pickFreePort, REPO_ROOT } from '../harness.mjs'

const [out, archive, receiptFile, cliSource, apiKernel] = process.argv.slice(2)
const factory = process.env.HERMIT_E2E_FACTORY === '1'
const realDocker = factory || Boolean(process.env.HERMIT_E2E_DOCKER_CONTAINER)
const dockerFailure = process.env.HERMIT_E2E_DOCKER_FAILURE || ''
let containerExited = false
const root = realDocker ? process.env.HERMIT_E2E_FIXTURE_ROOT : fs.mkdtempSync('/tmp/hm-')
const project = path.join(root, 'p')
const save = (name, value) => fs.writeFileSync(path.join(out, name), JSON.stringify(value, null, 2) + '\n')
const checks = []
let cleaning = false
const check = (name, value) => {
  checks.push({ name, result: value ? 'PASS' : 'FAIL' })
  save('checks.json', checks)
  if (!value && !cleaning) throw new Error(name)
}
const KEY = 'sk-ant-api03-p1-isolated-synthetic-key'
const expected = JSON.parse(fs.readFileSync(receiptFile))
const requests = []
let gw, outer, mock, proxy
let helperPID
let completed = false
let ownerRoot
let factoryProxyId
const factoryProbeServers = []
const factoryProbeSockets = new Set()
const processes = []
try {
  fs.mkdirSync(project, { recursive: true })
  const vm = seedVm({ project, id: 'vm-hermit' })
  if (factory) vm.status = 'stopped'
  vm.claude.account_uuid = 'account-hermit'
  vm.claude.email = 'hermit@fixture.invalid'
  vm.claude_code_version = '2.1.318'
  vm.proxy = { id: 'px-local', scheme: 'direct' }
  vm.runtime.container = process.env.HERMIT_E2E_DOCKER_CONTAINER || 'kin-hermit'
  fs.writeFileSync(path.join(project, 'vms/vm-hermit.json'), JSON.stringify(vm))
  const routing = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'src/config/routing.json')))
  routing.compatibility = { ...routing.compatibility, official_cc_passthrough: true, cache_ttl: '1h' }
  routing.kernel_watchdog = { enabled: false }
  routing.credential_refresh = { enabled: false }
  routing.pool = { ...routing.pool, worker_health_ttl_ms: 5000 }
  routing.inference = { ...routing.inference, health_ttl_ms: 0, slot_wait_ms: 500, session_slots: 20 }
  routing.failover = {
    ...routing.failover,
    eager_tool_streaming: false,
    total_retry_deadline_ms: 15000,
    queue_keepalive_delay_ms: 60000,
  }
  fs.mkdirSync(path.join(project, 'config'))
  fs.writeFileSync(path.join(project, 'config/routing.json'), JSON.stringify(routing))
  const cache = path.join(project, 'share/kernel-packages/cli')
  fs.mkdirSync(cache, { recursive: true })
  const hash = crypto.createHash('sha256')
  for await (const chunk of fs.createReadStream(cliSource)) hash.update(chunk)
  const digest = hash.digest('hex')
  const cached = path.join(cache, digest)
  fs.mkdirSync(cached)
  fs.copyFileSync(cliSource, path.join(cached, 'claude'))
  fs.chmodSync(path.join(cached, 'claude'), 0o555)
  const work = path.join(root, 'outer')
  for (const dir of [work, path.join(work, 'home'), path.join(work, 'config')]) fs.mkdirSync(dir, { recursive: true })
  const source = path.join(work, 'source.txt')
  fs.writeFileSync(source, 'ONLY_OUTER_EXECUTES_READ\n')
  function sse(ordinal) {
    const tools = requests.at(-1).body.tools
    const blocks =
      ordinal === 1
        ? [
            { type: 'tool_use', id: 'native-read-1', name: 'mcp__outer__Read', input: { file_path: source } },
            {
              type: 'tool_use',
              id: 'native-external-1',
              name: tools.find((t) => t.name.includes('ExternalProbe')).name,
              input: { label: 'MANAGER_ROUND' },
            },
          ]
        : [{ type: 'text', text: 'MANAGER_DONE_' + ordinal }]
    const events = [
      {
        type: 'message_start',
        message: {
          id: 'native_' + ordinal,
          type: 'message',
          role: 'assistant',
          model: 'claude-sonnet-4-6',
          content: [],
          stop_reason: null,
          usage: { input_tokens: 10, output_tokens: 1 },
        },
      },
    ]
    for (const [index, block] of blocks.entries())
      events.push(
        {
          type: 'content_block_start',
          index,
          content_block: block.type === 'tool_use' ? { ...block, input: {} } : { ...block, text: '' },
        },
        {
          type: 'content_block_delta',
          index,
          delta:
            block.type === 'tool_use'
              ? { type: 'input_json_delta', partial_json: JSON.stringify(block.input) }
              : { type: 'text_delta', text: block.text },
        },
        { type: 'content_block_stop', index },
      )
    events.push(
      {
        type: 'message_delta',
        delta: { stop_reason: ordinal === 1 ? 'tool_use' : 'end_turn', stop_sequence: null },
        usage: { output_tokens: 10 },
      },
      { type: 'message_stop' },
    )
    return events.map((row) => `event: ${row.type}\ndata: ${JSON.stringify(row)}\n\n`).join('')
  }
  mock = http.createServer(async (req, res) => {
    if (factory && req.url === '/geo') {
      res.setHeader('content-type', 'application/json')
      res.end(JSON.stringify({ status: 'success', query: req.socket.remoteAddress, timezone: 'Etc/UTC' }))
      return
    }
    const chunks = []
    for await (const chunk of req) chunks.push(chunk)
    let bytes = Buffer.concat(chunks)
    if (req.headers['content-encoding'] === 'gzip') {
      const { gunzipSync } = await import('node:zlib')
      bytes = gunzipSync(bytes)
    }
    const body = JSON.parse(bytes)
    if (!req.url.split('?')[0].endsWith('/v1/messages')) {
      res.end('{"input_tokens":100}')
      return
    }
    requests.push({ body, source: req.socket.remoteAddress, wire_base64: bytes.toString('base64') })
    save('native-requests.json', requests)
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    res.end(sse(requests.length))
  })
  mock.listen(0, factory ? '0.0.0.0' : '127.0.0.1')
  await once(mock, 'listening')
  let socksPort
  if (factory) {
    for (const [host, port] of [
      ['1.1.1.1', 443],
      ['8.8.8.8', 53],
    ]) {
      const server = net.createServer((socket) => {
        factoryProbeSockets.add(socket)
        socket.on('close', () => factoryProbeSockets.delete(socket))
        socket.end()
      })
      server.listen(port, host)
      await once(server, 'listening')
      factoryProbeServers.push(server)
    }
    socksPort = await pickFreePort()
    const file = path.join(root, 'socks.json')
    fs.writeFileSync(
      file,
      JSON.stringify({
        log: { level: 'debug' },
        inbounds: [
          {
            type: 'socks',
            listen: '127.0.0.1',
            listen_port: socksPort,
            users: [{ username: 'fixture', password: 'isolated-password' }],
          },
        ],
        outbounds: [{ type: 'direct', inet4_bind_address: '127.0.0.2' }],
      }),
      { mode: 0o600 },
    )
    const log = fs.openSync(path.join(out, 'socks.log'), 'w')
    const socks = spawn(process.env.HERMIT_E2E_SING_BOX, ['run', '-c', file], { stdio: ['ignore', log, log] })
    fs.closeSync(log)
    processes.push(socks)
    await new Promise((resolve) => setTimeout(resolve, 300))
    check('authenticated_socks_fixture_started', socks.exitCode === null)
  }
  const pool = path.join(project, 'share/kernel-packages')
  const run = path.join(project, 'vms/vm-hermit/run')
  fs.mkdirSync(run, { recursive: true })
  const fake = path.join(root, 'docker')
  const fakeCode = `#!/usr/bin/python3
import sys,os,json,subprocess
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
if not a[0].startswith('/opt/kin-kernel-packages/'):raise SystemExit(1)
binary=a[0].replace('/opt/kin-kernel-packages',pool)
config=Path(run)/'native-slot.json'
raw=config.read_text().replace('/opt/kin-kernel-packages',pool).replace('/run/kin',run)
translated=Path(run)/'native-translated.json';translated.write_text(raw);translated.chmod(0o600)
os.execv(binary,[binary,'--mode','vm2api-slot','--config',str(translated)])
`
  if (!realDocker) fs.writeFileSync(fake, fakeCode, { mode: 0o700 })
  const launcher = path.join(root, 'api-launch')
  const pidFile = path.join(root, 'api.pid')
  // 路径来自受控 mkdtemp，仍使用独立参数编码生成启动脚本。
  const quote = (s) => "'" + s.replaceAll("'", "'\"'\"'") + "'"
  fs.writeFileSync(launcher, `#!/bin/sh\nprintf '%s' "$$" > ${quote(pidFile)}\nexec ${quote(apiKernel)} "$@"\n`, {
    mode: 0o700,
  })
  const launchGateway = () =>
    startGateway({
      project,
      apiKey: KEY,
      readyMs: 12000,
      timeoutMs: 45000,
      env: {
        KIN_CRS_MOCK: '0',
        KIN_KERNEL_BIN: process.execPath,
        KIN_API_KERNEL_BIN: launcher,
        KIN_KERNEL_TEST_ENDPOINTS: '1',
        KIN_HERMIT_API_KEY: KEY,
        KIN_HERMIT_UPSTREAM_URL: factory
          ? 'http://127.0.0.1:19081/inner'
          : `http://127.0.0.1:${mock.address().port}/inner`,
        KIN_DOCKER_BIN: realDocker ? '/usr/bin/docker' : fake,
        ...(factory ? { KIN_PROXY_GEO_URL: `http://198.18.0.1:${mock.address().port}/geo` } : {}),
        NODE_NO_WARNINGS: '1',
      },
    })
  gw = await launchGateway()
  const login = await api(gw, 'POST', '/api/panel/login', { body: { username: 'admin', password: 'testpass' } })
  check('admin_login', login.status === 200)
  const cookie = login.headers.get('set-cookie')
  if (factory) {
    const imported = await api(gw, 'POST', '/api/panel/proxies/import', {
      headers: { cookie: login.headers.get('set-cookie') },
      body: { text: `socks5://fixture:isolated-password@127.0.0.1:${socksPort}` },
    })
    save('proxy-import.json', imported)
    factoryProxyId = imported.json?.data?.items?.[0]?.id
    check('authenticated_proxy_imported', imported.status === 200 && Boolean(factoryProxyId))
    const bound = await api(gw, 'POST', `/api/panel/proxies/${factoryProxyId}/bind`, {
      headers: { cookie: login.headers.get('set-cookie') },
      body: { vm_id: 'vm-hermit' },
    })
    save('proxy-bind.json', bound)
    check('standard_proxy_bind', bound.status === 200)
    const probe = await api(gw, 'POST', `/api/panel/proxies/${factoryProxyId}/probe`, {
      headers: { cookie: login.headers.get('set-cookie') },
    })
    save('proxy-probe.json', probe)
    check('authenticated_proxy_probe', probe.status === 200 && probe.json?.data?.probe?.ok === true)
    const { lookupProxyGeo } = await import('../../src/lib/vm/proxy-geo.mjs')
    const wrong = await lookupProxyGeo(`socks5://fixture:wrong-password@127.0.0.1:${socksPort}`, {
      endpoint: `http://198.18.0.1:${mock.address().port}/geo`,
      timeoutMs: 1000,
    })
    save('wrong-password.json', wrong)
    check('wrong_socks_password_rejected', wrong.ok === false)
  }

  const bytes = fs.readFileSync(archive)
  let res = await fetch(gw.baseUrl + '/api/panel/kernel-packages', {
    method: 'POST',
    headers: {
      cookie,
      'content-type': 'application/gzip',
      'x-kernel-sha256': expected.archive.sha256,
      'x-kernel-bytes': String(expected.archive.bytes),
      'x-kernel-manifest-sha256': expected.manifest_sha256,
    },
    body: bytes,
  })
  let result = await res.json()
  save('install.json', result)
  check('real_thin_package_installed', res.status === 200)
  check('shared_cli_cache_hit', result.data.cached_cli === true)
  const manifest = JSON.parse(
    fs.readFileSync(path.join(pool, 'versions/hermit/linux-amd64', expected.version, 'payload/manifest.json')),
  )
  res = await fetch(gw.baseUrl + '/api/panel/dataplane', {
    method: 'POST',
    headers: { cookie, 'content-type': 'application/json' },
    body: JSON.stringify({
      dataplane: 'hermit',
      ids: ['vm-hermit'],
      target: 'linux-amd64',
      version: expected.version,
      restart: true,
    }),
  })
  result = await res.json()
  save('activate.json', result)
  if (realDocker && ['missing-tmux', 'no-init'].includes(dockerFailure)) {
    const expectedCode = dockerFailure === 'missing-tmux' ? 'hermit_guest_preflight_failed' : 'hermit_init_required'
    check('invalid_container_rejected', res.status !== 200 && result.error?.code === expectedCode)
    const record = JSON.parse(fs.readFileSync(path.join(project, 'vms/vm-hermit.json')))
    check('rejected_activation_preserves_slot', !record.dataplane && !record.kernel_package)
    check('rejected_activation_creates_no_owner', !fs.existsSync(path.join(run, 'native-slot.json')))
    completed = true
  } else {
    check('manager_starts_hermit', res.status === 200 && result.data.activated === true)
    if (factory) {
      const inspection = JSON.parse(
        execFileSync('/usr/bin/docker', ['inspect', vm.runtime.container], { encoding: 'utf8' }),
      )[0]
      save('factory-container.json', inspection)
      check(
        'standard_factory_created_hermit',
        inspection.Config.Labels['kin.vm.role'] === 'hermit' && inspection.HostConfig.Init === true,
      )
      check('standard_factory_bound_exit', inspection.HostConfig.NetworkMode === `kin-eg-${factoryProxyId}`)
      const standardStart = await api(gw, 'POST', '/api/panel/vms/vm-hermit/start', { headers: { cookie } })
      save('standard-start.json', standardStart)
      check('standard_slot_start_endpoint', standardStart.status === 200)
      fs.copyFileSync(
        path.join(REPO_ROOT, 'test/fixtures/hermit-origin-relay.py'),
        path.join(run, 'mock-origin-relay.py'),
      )
      execFileSync('/usr/bin/docker', [
        'exec',
        '-d',
        '-u',
        '10001:987',
        vm.runtime.container,
        'python3',
        '/run/kin/mock-origin-relay.py',
        String(mock.address().port),
      ])
      await new Promise((resolve) => setTimeout(resolve, 200))
    }
    const duplicate = await Promise.all(
      [1, 2].map(() =>
        fetch(gw.baseUrl + '/api/panel/dataplane', {
          method: 'POST',
          headers: { cookie, 'content-type': 'application/json' },
          body: JSON.stringify({
            dataplane: 'hermit',
            ids: ['vm-hermit'],
            target: 'linux-amd64',
            version: expected.version,
            restart: true,
          }),
        }),
      ),
    )
    check(
      'concurrent_reselection_idempotent',
      duplicate.every((response) => response.status === 200),
    )

    const config = JSON.parse(
      fs.readFileSync(path.join(run, realDocker ? 'native-slot.json' : 'native-translated.json')),
    )
    ownerRoot = realDocker ? config.session.root.replace('/run/kin', run) : config.session.root
    check(
      'config_uses_shared_cli',
      config.session.managed.native_binary ===
        (realDocker ? `/opt/kin-kernel-packages/cli/${digest}/claude` : path.join(cached, 'claude')),
    )
    check(
      'config_uses_package_hooks',
      config.session.managed.hook_directory.includes(`/versions/hermit/linux-amd64/${expected.version}/payload/hooks`),
    )
    if (realDocker) {
      const execute = (argv) =>
        execFileSync('/usr/bin/docker', ['exec', '-u', '10001:987', vm.runtime.container, ...argv], {
          encoding: 'utf8',
        })
      const identity = JSON.parse(
        execute(['python3', '-c', "import os,json; print(json.dumps({'uid':os.getuid(),'gid':os.getgid()}))"]),
      )
      save('container-user.json', identity)
      check('non_root_slot_user', identity.uid === 10001 && identity.gid === 987)
      const denial = execute([
        'python3',
        '-c',
        "import os,errno; p='/opt/kin-kernel-packages/.write-probe';\ntry: open(p,'w').close(); print('WRITABLE')\nexcept OSError as e: print(e.errno)",
      ])
      check('package_mount_read_only', denial.trim() === '30')
    }
    const nativeOwner = JSON.parse(fs.readFileSync(path.join(ownerRoot, 'owner.json')))
    check('actual_binary_matches_package', nativeOwner.executable_sha256 === manifest.files['bin/hermit'].sha256)
    save('routing-before-outer.json', await api(gw, 'GET', '/admin/routing'))
    const publicVms = await api(gw, 'GET', '/api/panel/vms')
    save('vms-before-outer.json', publicVms)
    const items = publicVms.json?.data?.vms || publicVms.json?.vms || publicVms.json?.data?.items || []
    check('native_capacity_overrides_wrap_default', items.find((vm) => vm.id === 'vm-hermit')?.session_slots === 1)
    const record = JSON.parse(fs.readFileSync(path.join(project, 'vms/vm-hermit.json')))
    check(
      'existing_slot_selected',
      record.dataplane === 'hermit' && record.kernel_package.manifest_sha256 === expected.manifest_sha256,
    )
    const preferences = {
      hasCompletedOnboarding: true,
      lastOnboardingVersion: '2.1.318',
      customApiKeyResponses: { approved: [KEY.slice(-20)], rejected: [] },
      projects: { [work]: { hasTrustDialogAccepted: true } },
    }
    for (const dir of ['home', 'config'])
      fs.writeFileSync(path.join(work, dir, '.claude.json'), JSON.stringify(preferences))
    const effects = path.join(out, 'external-effects.jsonl')
    const mcp = path.join(work, 'mcp.json')
    fs.writeFileSync(
      mcp,
      JSON.stringify({
        mcpServers: {
          fixture: {
            command: '/usr/bin/python3',
            args: [
              path.join(REPO_ROOT, 'test/fixtures/hermit-mcp.py'),
              effects,
              '--name',
              'ExternalProbe',
              '--echo-label',
            ],
          },
        },
      }),
    )
    let forwarded = 0
    proxy = http.createServer(async (req, res) => {
      const chunks = []
      for await (const chunk of req) chunks.push(chunk)
      const wire = Buffer.concat(chunks)
      const ordinal = ++forwarded
      const headers = {
        ...req.headers,
        host: new URL(gw.baseUrl).host,
        'x-kin-delivery': 'realtime',
        'x-kin-debug': '1',
      }
      delete headers.connection
      save('outer-request-' + ordinal + '.json', { path: req.url, body: wire.toString() })
      try {
        const result = await fetch(gw.baseUrl + req.url, {
          method: req.method,
          headers,
          body: req.method === 'POST' ? wire : undefined,
        })
        res.writeHead(result.status, { 'content-type': result.headers.get('content-type') || 'application/json' })
        const response = []
        for await (const chunk of result.body) {
          response.push(Buffer.from(chunk))
          res.write(chunk)
        }
        res.end()
        save('outer-response-' + ordinal + '.json', { status: result.status, body: Buffer.concat(response).toString() })
      } catch (error) {
        save('proxy-error-' + ordinal + '.json', { error: String(error) })
        res.destroy()
      }
    })
    proxy.listen(0, '127.0.0.1')
    await once(proxy, 'listening')
    outer = spawn(
      path.join(cached, 'claude'),
      [
        '--print',
        '--verbose',
        '--input-format',
        'stream-json',
        '--output-format',
        'stream-json',
        '--model',
        'claude-sonnet-4-6',
        '--tools',
        'Read',
        '--allowedTools',
        'Read,mcp__fixture__ExternalProbe',
        '--permission-mode',
        'acceptEdits',
        '--mcp-config',
        mcp,
        '--strict-mcp-config',
      ],
      {
        cwd: work,
        stdio: ['pipe', 'pipe', fs.openSync(path.join(out, 'outer-stderr.txt'), 'w')],
        env: {
          PATH: '/usr/bin:/bin',
          HOME: path.join(work, 'home'),
          CLAUDE_CONFIG_DIR: path.join(work, 'config'),
          TMPDIR: work,
          TERM: 'xterm-256color',
          LANG: 'C.UTF-8',
          ANTHROPIC_API_KEY: KEY,
          ANTHROPIC_BASE_URL: 'http://127.0.0.1:' + proxy.address().port,
          ENABLE_TOOL_SEARCH: 'false',
          CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
          DISABLE_AUTOUPDATER: '1',
          DISABLE_INSTALLATION_CHECKS: '1',
          DISABLE_AUTO_COMPACT: '1',
          CLAUDE_CODE_DISABLE_AUTO_MEMORY: '1',
          CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS: '1',
        },
      },
    )
    processes.push(outer)
    const lines = []
    let partial = ''
    const raw = []
    outer.stdout.on('data', (chunk) => {
      raw.push(chunk)
      fs.appendFileSync(path.join(out, 'outer-stdout.jsonl'), chunk)
      partial += chunk
      let at
      while ((at = partial.indexOf('\n')) >= 0) {
        const line = partial.slice(0, at)
        partial = partial.slice(at + 1)
        if (line) lines.push(JSON.parse(line))
      }
    })
    async function sendTurn(turn) {
      const before = lines.filter((row) => row.type === 'result').length
      outer.stdin.write(
        JSON.stringify({
          type: 'user',
          uuid: crypto.randomUUID(),
          message: { role: 'user', content: [{ type: 'text', text: 'HERMIT_MANAGER_TURN_' + turn }] },
        }) + '\n',
      )
      const until = Date.now() + 45000
      while (Date.now() < until && lines.filter((row) => row.type === 'result').length === before)
        await new Promise((resolve) => setTimeout(resolve, 25))
      const results = lines.filter((row) => row.type === 'result')
      save('outer-turn-' + turn + '.json', results.at(-1) || null)
      check('actual_outer_turn_' + turn, results.length > before && !results.at(-1).is_error)
    }
    for (const turn of [1, 2]) await sendTurn(turn)
    fs.writeFileSync(path.join(out, 'outer-stdout.jsonl'), Buffer.concat(raw))
    save('outer-messages.json', lines)
    check(
      'native_received_tool_results',
      requests.length === 3 && requests[1].body.messages.some((m) => JSON.stringify(m).includes('tool_result')),
    )
    check(
      'only_proxy_tools',
      requests.every((row) => row.body.tools.every((tool) => tool.name.startsWith('mcp__outer__'))),
    )
    check(
      'external_mcp_executed_once',
      fs.existsSync(effects) && fs.readFileSync(effects, 'utf8').trim().split('\n').length === 1,
    )
    check('outer_read_result_preserved', JSON.stringify(requests[1]).includes('ONLY_OUTER_EXECUTES_READ'))
    if (factory)
      check(
        'native_traffic_uses_authenticated_exit',
        requests.every((row) => row.source === '127.0.0.2'),
      )
    check('source_file_unchanged', fs.readFileSync(source, 'utf8') === 'ONLY_OUTER_EXECUTES_READ\n')
    if (realDocker) {
      const previousRoot = ownerRoot
      gw.child.kill('SIGTERM')
      const until = Date.now() + 25000
      while (gw.child.exitCode === null && Date.now() < until) await new Promise((resolve) => setTimeout(resolve, 25))
      check('control_plane_restart_exit', gw.child.exitCode === 0)
      const stopped = JSON.parse(fs.readFileSync(path.join(previousRoot, 'owner.json')))
      save('owner-before-restart.json', stopped)
      save('server-before-restart.json', { stdout: gw.stdout(), stderr: gw.stderr() })
      check('control_plane_restart_drains_owner', stopped.phase === 'stopped' && stopped.groups_gone)
      if (fs.existsSync(pidFile)) {
        try {
          process.kill(Number(fs.readFileSync(pidFile, 'utf8')), 'SIGTERM')
        } catch {}
      }
      gw = await launchGateway()
      const loginAgain = await api(gw, 'POST', '/api/panel/login', {
        body: { username: 'admin', password: 'testpass' },
      })
      const activation = await api(gw, 'POST', '/api/panel/dataplane', {
        headers: { cookie: loginAgain.headers.get('set-cookie') },
        body: {
          dataplane: 'hermit',
          ids: ['vm-hermit'],
          target: 'linux-amd64',
          version: expected.version,
          restart: true,
        },
      })
      save('reactivate.json', activation)
      check('control_plane_restart_reactivates', activation.status === 200 && activation.json.data.activated)
      const fresh = JSON.parse(fs.readFileSync(path.join(run, 'native-slot.json')))
      ownerRoot = fresh.session.root.replace('/run/kin', run)
      check('control_plane_restart_uses_fresh_owner', ownerRoot !== previousRoot)
      await sendTurn(3)
      check(
        'restart_restores_outer_history',
        JSON.stringify(requests.at(-1).body.messages).includes('ONLY_OUTER_EXECUTES_READ'),
      )
    }
    if (factory) {
      const { stopEgressProcess, egressPidsForProxyConfig } = await import('../../src/lib/vm/egress.mjs')
      save('helper-stop-for-failure.json', stopEgressProcess(project, factoryProxyId))
      const deadline = Date.now() + 3000
      while (egressPidsForProxyConfig(project, factoryProxyId).length && Date.now() < deadline)
        await new Promise((resolve) => setTimeout(resolve, 25))
      check('transparent_helper_stopped_for_failure', egressPidsForProxyConfig(project, factoryProxyId).length === 0)
      const attempt = execFileSync(
        '/usr/bin/docker',
        [
          'exec',
          '-u',
          '10001:987',
          vm.runtime.container,
          'python3',
          '-c',
          `import socket\ntry:\n s=socket.create_connection(('198.18.0.1',${mock.address().port}),1);s.close();print('BYPASS')\nexcept OSError: print('BLOCKED')`,
        ],
        { encoding: 'utf8' },
      )
      check('helper_failure_blocks_direct_fallback', attempt.trim() === 'BLOCKED')
      const login = await api(gw, 'POST', '/api/panel/login', { body: { username: 'admin', password: 'testpass' } })
      const recovery = await api(gw, 'POST', `/api/panel/proxies/${factoryProxyId}/probe`, {
        headers: { cookie: login.headers.get('set-cookie') },
      })
      save('helper-recovery.json', recovery)
      check('standard_probe_repairs_helper', recovery.status === 200 && recovery.json?.data?.probe?.ok === true)
    }
    const log = JSON.parse(fs.readFileSync(path.join(ownerRoot, 'owner.json')))
    save('owner-before-stop.json', log)
    if (dockerFailure === 'container-exit') {
      execFileSync('/usr/bin/docker', ['stop', '--time', '3', vm.runtime.container])
      containerExited = true
      await new Promise((resolve) => setTimeout(resolve, 300))
      const unavailable = await api(gw, 'POST', '/api/panel/dataplane', {
        headers: {
          cookie: (
            await api(gw, 'POST', '/api/panel/login', { body: { username: 'admin', password: 'testpass' } })
          ).headers.get('set-cookie'),
        },
        body: {
          dataplane: 'hermit',
          ids: ['vm-hermit'],
          target: 'linux-amd64',
          version: expected.version,
          restart: true,
        },
      })
      save('container-exit-selection.json', unavailable)
      check('stopped_container_rejects_activation', unavailable.status !== 200)
      const record = JSON.parse(fs.readFileSync(path.join(project, 'vms/vm-hermit.json')))
      check(
        'container_exit_preserves_kernel_selection',
        record.dataplane === 'hermit' && record.kernel_package.manifest_sha256 === expected.manifest_sha256,
      )
    }
    completed = true
  }
} catch (error) {
  save('failure.json', { error: String(error), stack: error.stack })
} finally {
  cleaning = true
  if (outer) {
    outer.stdin.end()
    outer.kill('SIGTERM')
  }
  if (gw) {
    gw.child.kill('SIGTERM')
    const until = Date.now() + 25000
    while (gw.child.exitCode === null && Date.now() < until) await new Promise((resolve) => setTimeout(resolve, 25))
    if (gw.child.exitCode === null) gw.child.kill('SIGKILL')
    fs.writeFileSync(path.join(out, 'server-stderr.txt'), gw.stderr())
    fs.writeFileSync(path.join(out, 'server-stdout.txt'), gw.stdout())
    check('gateway_graceful_exit', gw.child.exitCode === 0)
  }
  if (!containerExited && ownerRoot && fs.existsSync(path.join(ownerRoot, 'owner.json'))) {
    const owner = JSON.parse(fs.readFileSync(path.join(ownerRoot, 'owner.json')))
    save('owner-after-stop.json', owner)
    check('stdin_lease_stops_owned_groups', owner.phase === 'stopped' && owner.groups_gone)
  }
  const pid = path.join(root, 'api.pid')
  if (fs.existsSync(pid)) {
    helperPID = Number(fs.readFileSync(pid, 'utf8'))
    try {
      process.kill(helperPID, 'SIGTERM')
    } catch {}
  }
  if (proxy) {
    proxy.closeAllConnections()
    await new Promise((resolve) => proxy.close(resolve))
  }
  if (mock) {
    mock.closeAllConnections()
    await new Promise((resolve) => mock.close(resolve))
  }
  for (const child of processes) if (child.exitCode === null) child.kill('SIGTERM')
  for (const socket of factoryProbeSockets) socket.destroy()
  for (const server of factoryProbeServers) await new Promise((resolve) => server.close(resolve))
  for (const child of processes) {
    if (child.exitCode === null) {
      const until = Date.now() + 3000
      while (child.exitCode === null && Date.now() < until) await new Promise((resolve) => setTimeout(resolve, 25))
      if (child.exitCode === null) child.kill('SIGKILL')
    }
  }
  if (fs.existsSync(path.join(project, 'data/kin.db'))) {
    try {
      const db = new DatabaseSync(path.join(project, 'data/kin.db'), { readOnly: true })
      const tables = {}
      for (const name of ['request_attempts', 'request_log_debug', 'usage_logs', 'sticky_sessions']) {
        if (db.prepare('SELECT name FROM sqlite_master WHERE name=?').get(name))
          tables[name] = db.prepare('SELECT * FROM ' + name).all()
      }
      db.close()
      save('database.json', tables)
    } catch (error) {
      save('database-error.json', { error: String(error) })
    }
  }
  if (factoryProxyId) {
    const { stopProxyEgress } = await import('../../src/lib/vm/egress.mjs')
    const { egressPidsForProxyConfig } = await import('../../src/lib/vm/egress.mjs')
    save('egress-stop.json', stopProxyEgress(project, factoryProxyId))
    const deadline = Date.now() + 3000
    while (egressPidsForProxyConfig(project, factoryProxyId).length && Date.now() < deadline)
      await new Promise((resolve) => setTimeout(resolve, 25))
    check('transparent_helper_cleanup_confirmed', egressPidsForProxyConfig(project, factoryProxyId).length === 0)
  }
  const capture = (source, dest) => {
    fs.mkdirSync(dest, { recursive: true })
    for (const entry of fs.readdirSync(source, { withFileTypes: true })) {
      const from = path.join(source, entry.name),
        to = path.join(dest, entry.name)
      if (entry.isDirectory()) capture(from, to)
      else if (entry.isFile() && fs.statSync(from).size < 4 * 1024 * 1024) fs.copyFileSync(from, to)
    }
  }
  if (ownerRoot && fs.existsSync(ownerRoot)) capture(ownerRoot, path.join(out, 'owner-files'))
  fs.rmSync(root, { recursive: true, force: true })
  save('summary.json', {
    result: completed && checks.every((row) => row.result === 'PASS') ? 'PASS' : 'FAIL',
    checks: checks.length,
    temporary_root_removed: !fs.existsSync(root),
    standard_factory: factory,
    mock_docker_boundary: !realDocker,
    real_provider: 'NOT RUN',
    physical_docker: realDocker ? 'RUN' : 'NOT RUN',
  })
}
process.exit(completed && checks.every((row) => row.result === 'PASS') ? 0 : 1)
