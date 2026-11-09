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
import { writeWorkerCredentialFile, readWorkerCredentialFile } from '../../src/lib/oauth/oauth-credentials.mjs'
import { startGateway, seedVm, api, pickFreePort, REPO_ROOT } from '../harness.mjs'

const [out, archive, receiptFile, cliSource, apiKernel] = process.argv.slice(2)
const tlsMode = process.env.HERMIT_E2E_TLS === '1'
const oauthMode = process.env.HERMIT_E2E_OAUTH === '1'
const OAUTH_AT = 'sk-ant-oat01-runtime-old'
const OAUTH_RT = 'sk-ant-ort01-runtime-old'
let oauthRefreshBoundary = -1
let oauthAutoBoundary = -1
const refreshRequests = []
const slotApiKey = process.env.HERMIT_E2E_SLOT_API_KEY === '1' && !oauthMode
const SLOT_KEY = 'sk-ant-api03-p1-slot-owned-synthetic-key'
let expectedSlotKey = SLOT_KEY
const factory = process.env.HERMIT_E2E_FACTORY === '1'
const managed = process.env.HERMIT_E2E_MANAGED === '1'
const controlMode = process.env.HERMIT_E2E_CONTROL === '1'
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
const modelRequests = []
let gw, outer, mock, proxy
let helperPID
let completed = false
let ownerRoot
let factoryProxyId
let managedFixture
let controlFixture
let httpsFixture
let restartToolIssued = false
const restartRelease = path.join(out, 'restart-tool-release')
let socksUsername = 'fixture'
const factoryProbeServers = []
const factoryProbeSockets = new Set()
const processes = []
try {
  fs.mkdirSync(project, { recursive: true })
  const vm = seedVm({ project, id: 'vm-hermit' })
  if (factory) vm.status = 'stopped'
  if (slotApiKey) vm.claude.mode = 'apikey'
  if (oauthMode) {
    vm.claude.mode = 'oauth'
    vm.claude.has_refresh = true
  }
  vm.claude.account_uuid = 'account-hermit'
  vm.claude.email = 'hermit@fixture.invalid'
  vm.claude_code_version = '2.1.318'
  vm.proxy = { id: 'px-local', scheme: 'direct' }
  vm.runtime.container = process.env.HERMIT_E2E_DOCKER_CONTAINER || 'kin-hermit'
  if (controlMode) {
    vm.runtime.worker_run_dir = '/opt/vm2api/vms/vm-hermit/run'
    vm.runtime.worker_socket = '/opt/vm2api/vms/vm-hermit/run/worker.sock'
    vm.runtime.worker_token_file = '/opt/vm2api/vms/vm-hermit/run/internal.token'
  }
  fs.writeFileSync(path.join(project, 'vms/vm-hermit.json'), JSON.stringify(vm))
  const credentialHome = path.join(project, 'vms/vm-hermit/cli-home')
  const credentialFile = path.join(credentialHome, '.claude/credentials.json')
  if (slotApiKey) writeWorkerCredentialFile(credentialHome, { type: 'apikey', api_key: SLOT_KEY })
  if (oauthMode)
    writeWorkerCredentialFile(credentialHome, {
      type: 'oauth',
      access_token: OAUTH_AT,
      refresh_token: OAUTH_RT,
      expires_at: Date.now() + 3600000,
      email: vm.claude.email,
      account_uuid: vm.claude.account_uuid,
      scope: 'user:profile user:inference user:sessions:claude_code',
    })
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
    const restartTool =
      tlsMode && !restartToolIssued && JSON.stringify(requests.at(-1).body.messages).includes('HERMIT_MANAGER_TURN_30')
    if (restartTool) restartToolIssued = true
    const blocks = restartTool
      ? [
          {
            type: 'tool_use',
            id: 'toolu_01HermitRestartPending0001',
            name: tools.find((tool) => tool.name.includes('ExternalProbe')).name,
            input: { label: 'WAIT_FOR_RESTART' },
          },
        ]
      : ordinal === 1
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
        delta: {
          stop_reason: blocks.some((block) => block.type === 'tool_use') ? 'tool_use' : 'end_turn',
          stop_sequence: null,
        },
        usage: { output_tokens: 10 },
      },
      { type: 'message_stop' },
    )
    return events.map((row) => `event: ${row.type}\ndata: ${JSON.stringify(row)}\n\n`).join('')
  }
  const mockHandler = async (req, res) => {
    if (factory && req.url === '/geo') {
      res.setHeader('content-type', 'application/json')
      res.end(JSON.stringify({ status: 'success', query: req.socket.remoteAddress, timezone: 'Etc/UTC' }))
      return
    }
    if (tlsMode && req.url.startsWith('/api/claude_code/')) {
      res.writeHead(404, { 'content-type': 'application/json' })
      res.end('{"error":{"type":"not_found_error"}}')
      return
    }
    if (req.method === 'GET' && req.url.split('?')[0].endsWith('/v1/models')) {
      modelRequests.push({
        path: req.url,
        host: req.headers.host,
        tls: !!req.socket.encrypted,
        source: req.socket.remoteAddress,
        api_key: req.headers['x-api-key'],
        authorization: req.headers.authorization || null,
      })
      save('native-model-requests.json', modelRequests)
      res.setHeader('content-type', 'application/json')
      res.end(
        JSON.stringify({
          data: [{ id: 'claude-native-helper-fixture', type: 'model', display_name: 'Native helper fixture' }],
          has_more: false,
        }),
      )
      return
    }
    if (req.method === 'GET') {
      res.setHeader('content-type', 'application/json')
      res.end(
        JSON.stringify(
          req.url.includes('/usage')
            ? { five_hour: { utilization: 0.1 }, seven_day: { utilization: 0.2 } }
            : {
                account: { uuid: 'account-hermit', email_address: 'hermit@fixture.invalid' },
                organization: { uuid: '11111111-2222-4333-8444-555555555555', organization_type: 'claude_max' },
              },
        ),
      )
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
    if (req.url.endsWith('/v1/oauth/token')) {
      refreshRequests.push({
        ...body,
        source: req.socket.remoteAddress,
        host: req.headers.host,
        tls: !!req.socket.encrypted,
      })
      save('oauth-refresh-requests.json', refreshRequests)
      res.setHeader('content-type', 'application/json')
      res.end(
        JSON.stringify({
          access_token: 'sk-ant-oat01-runtime-new-' + refreshRequests.length,
          refresh_token: 'sk-ant-ort01-runtime-new-' + refreshRequests.length,
          expires_in: 3600,
          scope: 'user:profile user:inference user:sessions:claude_code',
        }),
      )
      return
    }
    if (!req.url.split('?')[0].endsWith('/v1/messages')) {
      res.end('{"input_tokens":100}')
      return
    }
    requests.push({
      auth: { api_key: req.headers['x-api-key'], authorization: req.headers.authorization || null },
      body,
      source: req.socket.remoteAddress,
      host: req.headers.host,
      tls: !!req.socket.encrypted,
      wire_base64: bytes.toString('base64'),
    })
    save('native-requests.json', requests)
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    res.end(sse(requests.length))
  }
  mock = http.createServer(mockHandler)
  if (tlsMode) {
    const { prepareHTTPSFixture } = await import('../fixtures/hermit-https.mjs')
    httpsFixture = await prepareHTTPSFixture({ root, project, out, handler: mockHandler })
  }
  mock.listen(0, factory ? '0.0.0.0' : '127.0.0.1')
  await once(mock, 'listening')
  let socksPort
  let factoryDnsReplies = 0
  if (factory) {
    for (const [host, port] of [
      ['1.1.1.1', 443],
      ['8.8.8.8', 53],
    ]) {
      const server = net.createServer((socket) => {
        factoryProbeSockets.add(socket)
        socket.on('close', () => factoryProbeSockets.delete(socket))
        if (port !== 53) return socket.end()
        let query = Buffer.alloc(0)
        socket.on('data', (chunk) => {
          query = Buffer.concat([query, chunk])
          if (query.length < 2 || query.length < 2 + query.readUInt16BE(0)) return
          const response = Buffer.from(query.subarray(2, 2 + query.readUInt16BE(0)))
          if (response.length < 12) return socket.destroy()
          // A framed NODATA reply proves application-level reachability.
          response.writeUInt16BE(0x8180, 2)
          const frame = Buffer.alloc(2)
          frame.writeUInt16BE(response.length)
          factoryDnsReplies++
          socket.end(Buffer.concat([frame, response]))
        })
      })
      server.listen(port, host)
      await once(server, 'listening')
      factoryProbeServers.push(server)
    }
    if (managed) {
      const { prepareManagedFixture } = await import('../fixtures/hermit-managed.mjs')
      managedFixture = await prepareManagedFixture({ root, project, out, processes, controlMode })
      check('hysteria_server_started', true)
    } else {
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
raw=config.read_text().replace('/opt/kin-kernel-packages',pool).replace('/run/kin',run).replace('/home/kincli/.claude/credentials.json',str(Path(run).parent/'cli-home/.claude/credentials.json'))
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
  if (controlMode) {
    const { prepareControlFixture } = await import('../fixtures/hermit-control.mjs')
    controlFixture = await prepareControlFixture({
      project,
      repo: REPO_ROOT,
      root,
      out,
      apiKey: KEY,
      apiKernel,
      originPort: mock.address().port,
      tls: tlsMode,
    })
  }
  const launchGateway = () =>
    controlMode
      ? controlFixture.launch()
      : startGateway({
          project,
          apiKey: KEY,
          readyMs: 12000,
          timeoutMs: 45000,
          env: {
            ...(managed ? { VM2API_CONTAINER_NAME: managedFixture.control } : {}),
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
      body: managed ? managedFixture.importBody : { text: `socks5://fixture:isolated-password@127.0.0.1:${socksPort}` },
    })
    save('proxy-import.json', imported)
    factoryProxyId = imported.json?.data?.items?.[0]?.id
    check('authenticated_proxy_imported', imported.status === 200 && Boolean(factoryProxyId))
    if (managed && !controlMode) {
      check('unsafe_managed_mount_not_applied', imported.json.data.application_status === 'pending')
      const rejected = await api(gw, 'POST', `/api/panel/proxies/${factoryProxyId}/bind`, {
        headers: { cookie },
        body: { vm_id: 'vm-hermit' },
      })
      save('managed-pending-bind.json', rejected)
      check('unready_managed_exit_rejects_bind', rejected.status !== 200)
      check(
        'unready_exit_preserves_slot',
        JSON.parse(fs.readFileSync(path.join(project, 'vms/vm-hermit.json'))).proxy.id !== factoryProxyId,
      )
      managedFixture.repairMount()
      const applied = await api(gw, 'POST', '/api/panel/proxies/apply', {
        headers: { cookie },
        body: { host_id: 'control-plane' },
      })
      save('managed-apply.json', applied)
      check('managed_configuration_applied', applied.status === 200 && applied.json.ok)
      const inbound = managedFixture.credentials()
      socksPort = inbound.listen_port
      socksUsername = inbound.users[0].username
      const listing = await api(gw, 'GET', '/api/panel/proxies')
      save('managed-ready.json', listing)
      const row = listing.json.data.proxies.find((row) => row.id === factoryProxyId)
      check('managed_exit_ready', row.exit_status === 'ready' && row.blocked_reason === null)
      check(
        'managed_credentials_hidden',
        row.username === undefined && row.password === undefined && row.managed_config === undefined,
      )
    }

    if (controlMode) {
      check('compose_managed_import_applied', imported.json.data.application_status === 'applied')
      const inbound = managedFixture.credentials()
      socksPort = inbound.listen_port
      socksUsername = inbound.users[0].username
    }
    const bound = await api(gw, 'POST', `/api/panel/proxies/${factoryProxyId}/bind`, {
      headers: { cookie: login.headers.get('set-cookie') },
      body: { vm_id: 'vm-hermit' },
    })
    save('proxy-bind.json', bound)
    check('standard_proxy_bind', bound.status === 200)
    const dnsBeforeProbe = factoryDnsReplies
    const probe = await api(gw, 'POST', `/api/panel/proxies/${factoryProxyId}/probe`, {
      headers: { cookie: login.headers.get('set-cookie') },
    })
    save('proxy-probe.json', probe)
    check('authenticated_proxy_probe', probe.status === 200 && probe.json?.data?.probe?.ok === true)
    check('proxy_probe_received_dns_response', factoryDnsReplies > dnsBeforeProbe)
    if (managed) {
      const helperConfig = JSON.parse(
        fs.readFileSync(path.join(project, 'data/run/egress', factoryProxyId, 'egress.json')),
      )
      check(
        'managed_helper_control_preserved',
        helperConfig.control_socket ===
          path.join(controlMode ? '/opt/vm2api' : project, 'data/run/egress', factoryProxyId, 'drain.sock'),
      )
    }
    const { lookupProxyGeo } = await import('../../src/lib/vm/proxy-geo.mjs')
    const wrong = await lookupProxyGeo(
      `socks5://${encodeURIComponent(socksUsername)}:wrong-password@127.0.0.1:${socksPort}`,
      {
        endpoint: `http://198.18.0.1:${mock.address().port}/geo`,
        timeoutMs: 1000,
      },
    )
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
  if (slotApiKey) {
    const valid = fs.readFileSync(credentialFile)
    const validMode = fs.statSync(credentialFile).mode & 0o777
    const choose = async () =>
      api(gw, 'POST', '/api/panel/dataplane', {
        headers: { cookie },
        body: {
          dataplane: 'hermit',
          ids: ['vm-hermit'],
          target: 'linux-amd64',
          version: expected.version,
          restart: true,
        },
      })
    const cases = [
      ['missing', () => fs.unlinkSync(credentialFile)],
      ['empty', () => fs.writeFileSync(credentialFile, '{"type":"apikey","anthropicApiKey":{"apiKey":""}}')],
      [
        'bearer',
        () =>
          fs.writeFileSync(
            credentialFile,
            JSON.stringify({
              type: 'apikey',
              authScheme: 'authorization_bearer',
              anthropicApiKey: { apiKey: SLOT_KEY },
            }),
          ),
      ],
      ['public', () => fs.chmodSync(credentialFile, 0o644)],
      [
        'symlink',
        () => {
          fs.unlinkSync(credentialFile)
          fs.symlinkSync(path.join(root, 'synthetic-target'), credentialFile)
        },
      ],
      [
        'oauth',
        () =>
          fs.writeFileSync(
            credentialFile,
            '{"type":"oauth","claudeAiOauth":{"accessToken":"synthetic","refreshToken":"never-forward"}}',
          ),
      ],
      [
        'mixed',
        () =>
          fs.writeFileSync(
            credentialFile,
            JSON.stringify({
              type: 'apikey',
              anthropicApiKey: { apiKey: SLOT_KEY },
              claudeAiOauth: { accessToken: 'never-forward' },
            }),
          ),
      ],
      [
        'custom_endpoint',
        () =>
          fs.writeFileSync(
            credentialFile,
            JSON.stringify({
              type: 'apikey',
              anthropicApiKey: { apiKey: SLOT_KEY, baseUrl: 'https://custom.invalid' },
            }),
          ),
      ],
    ]
    for (const [name, change] of cases) {
      change()
      const rejection = await choose()
      save(`auth-rejected-${name}.json`, rejection)
      check(
        `slot_auth_${name}_rejected_without_fallback`,
        rejection.status !== 200 && rejection.json.error?.code === 'hermit_authentication_invalid',
      )
      check(`slot_auth_${name}_creates_no_owner`, !fs.existsSync(path.join(run, 'native-slot.json')))
      fs.rmSync(credentialFile, { force: true })
      fs.writeFileSync(credentialFile, valid, { mode: validMode })
      if (process.getuid?.() === 0) {
        const stat = fs.statSync(credentialHome)
        fs.chownSync(credentialFile, stat.uid, stat.gid)
      }
    }
  }
  if (tlsMode && slotApiKey) {
    const validCA = fs.readFileSync(httpsFixture.ca)
    const select = () =>
      api(gw, 'POST', '/api/panel/dataplane', {
        headers: { cookie },
        body: {
          dataplane: 'hermit',
          ids: ['vm-hermit'],
          target: 'linux-amd64',
          version: expected.version,
          restart: true,
        },
      })
    for (const [name, replace] of [
      ['missing', () => fs.unlinkSync(httpsFixture.ca)],
      [
        'symlink',
        () => {
          fs.unlinkSync(httpsFixture.ca)
          fs.symlinkSync(path.join(root, 'origin-ca.key'), httpsFixture.ca)
        },
      ],
      ['oversize', () => fs.writeFileSync(httpsFixture.ca, Buffer.alloc(1024 * 1024 + 1))],
      ['invalid', () => fs.writeFileSync(httpsFixture.ca, 'invalid pem')],
    ]) {
      replace()
      const denied = await select()
      save('tls-ca-' + name + '.json', denied)
      check('tls_ca_' + name + '_rejected', denied.status !== 200 && denied.json.error?.code === 'hermit_ca_invalid')
      check('tls_ca_' + name + '_creates_no_owner', !fs.existsSync(path.join(run, 'native-slot.json')))
      fs.rmSync(httpsFixture.ca, { force: true })
      fs.writeFileSync(httpsFixture.ca, validCA)
    }
  }
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
      if (controlMode) {
        check(
          'package_mount_translated_to_host',
          inspection.Mounts.find((m) => m.Destination === '/opt/kin-kernel-packages')?.Source === pool,
        )
        check(
          'run_mount_translated_to_host',
          inspection.Mounts.find((m) => m.Destination === '/run/kin')?.Source === run,
        )
        const persisted = JSON.parse(fs.readFileSync(path.join(project, 'vms/vm-hermit.json')))
        check('runtime_uses_container_paths', persisted.runtime.worker_run_dir === '/opt/vm2api/vms/vm-hermit/run')
      }
      const standardStart = await api(gw, 'POST', '/api/panel/vms/vm-hermit/start', { headers: { cookie } })
      save('standard-start.json', standardStart)
      check('standard_slot_start_endpoint', standardStart.status === 200)
      if (tlsMode) {
        const { configureTLSSlot } = await import('../fixtures/hermit-https.mjs')
        check('tls_slot_dns_configured', configureTLSSlot(vm.runtime.container) === 'configured')
      } else {
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

    if (slotApiKey) {
      const valid = fs.readFileSync(credentialFile)
      writeWorkerCredentialFile(credentialHome, { type: 'apikey', api_key: SLOT_KEY + '-rotated' })
      const changed = await api(gw, 'POST', '/api/panel/dataplane', {
        headers: { cookie },
        body: {
          dataplane: 'hermit',
          ids: ['vm-hermit'],
          target: 'linux-amd64',
          version: expected.version,
          restart: true,
        },
      })
      save('auth-changed.json', changed)
      check(
        'credential_rotation_requires_restart',
        changed.status !== 200 && changed.json.error?.code === 'hermit_authentication_changed',
      )
      fs.writeFileSync(credentialFile, valid)
      if (factory) {
        const stopped = await api(gw, 'POST', '/api/panel/vms/vm-hermit/stop', { headers: { cookie } })
        check('credential_rotation_stops_slot', stopped.status === 200)
        expectedSlotKey = SLOT_KEY + '-rotated'
        writeWorkerCredentialFile(credentialHome, { type: 'apikey', api_key: expectedSlotKey })
        const restarted = await api(gw, 'POST', '/api/panel/vms/vm-hermit/start', { headers: { cookie } })
        save('auth-restarted.json', restarted)
        check('credential_rotation_starts_with_new_key', restarted.status === 200 && restarted.json.ok === true)
        if (tlsMode) {
          const { configureTLSSlot } = await import('../fixtures/hermit-https.mjs')
          check('tls_slot_dns_restored_after_restart', configureTLSSlot(vm.runtime.container) === 'configured')
        } else {
          // 模拟上游转发进程属于槽位；Docker stop 会终止该测试进程。
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
          const relayReady = execFileSync(
            '/usr/bin/docker',
            [
              'exec',
              vm.runtime.container,
              'python3',
              '-c',
              "import socket,time;\nfor _ in range(30):\n try:\n  s=socket.create_connection(('127.0.0.1',19081),.2);s.close();print('ready');break\n except OSError:time.sleep(.1)\nelse:raise SystemExit(1)",
            ],
            { encoding: 'utf8' },
          )
          check('mock_origin_relay_restarted', relayReady.trim() === 'ready')
        }
      }
      check('activation_response_contains_no_slot_key', !JSON.stringify(result).includes(SLOT_KEY))
    }
    const config = JSON.parse(
      fs.readFileSync(path.join(run, realDocker ? 'native-slot.json' : 'native-translated.json')),
    )
    if (slotApiKey) {
      check('canonical_credential_seal_preserved', (fs.statSync(credentialFile).mode & 0o777) === 0o444)
      check('config_uses_slot_key', config.session.managed.environment.includes('ANTHROPIC_API_KEY=' + expectedSlotKey))
      check('config_is_private', (fs.statSync(path.join(run, 'native-slot.json')).mode & 0o777) === 0o600)
      check('config_contains_no_refresh_token', !JSON.stringify(config).includes('never-forward'))
    }
    if (tlsMode) {
      check(
        'config_uses_fixed_https_origins',
        config.session.managed.upstream_url === 'https://api.anthropic.com' &&
          config.helper.oauth_token_url === 'https://platform.claude.com/v1/oauth/token',
      )
      check(
        'config_uses_slot_ca',
        config.session.managed.environment.includes('NODE_EXTRA_CA_CERTS=/run/kin/native-ca.pem'),
      )
      check(
        'slot_ca_matches_control_ca',
        fs.readFileSync(path.join(run, 'native-ca.pem')).equals(fs.readFileSync(httpsFixture.ca)),
      )
    }
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
    if (factory && (slotApiKey || oauthMode)) {
      if (tlsMode) {
        const before = modelRequests.length
        httpsFixture.certificate('wrong-name')
        const denied = await api(gw, 'POST', '/api/panel/model-policy/sync-worker', { headers: { cookie }, body: {} })
        save('tls-wrong-certificate.json', denied)
        check('managed_tls_wrong_certificate_rejected', denied.status !== 200 && modelRequests.length === before)
        httpsFixture.certificate('normal')
      }
      const helper = await api(gw, 'POST', '/api/panel/model-policy/sync-worker', { headers: { cookie }, body: {} })
      save('native-helper-rejected.json', helper)
      if (manifest.capabilities.helper_integration) {
        const nativeStatus = await api(gw, 'GET', '/admin/vm/oauth')
        check(
          'all_seven_helpers_are_live',
          nativeStatus.json.worker?.helper_protocol === 'hermit-helper-1' &&
            nativeStatus.json.worker?.helper_operations?.length === 7,
        )
      }
      const supportsModels = Boolean(manifest.source?.files?.['internal/nativebridge/models.go'])
      check(
        supportsModels ? 'active_native_models_sync_succeeds' : 'active_native_helper_rejects_legacy_fallback',
        supportsModels
          ? helper.status === 200
          : helper.status === 501 && helper.json.error?.code === 'native_operation_unsupported',
      )
      if (supportsModels) {
        check(
          'model_helper_uses_slot_key_and_exit',
          modelRequests.length > 0 &&
            modelRequests.every(
              (row) =>
                (oauthMode
                  ? row.authorization === 'Bearer ' + OAUTH_AT && !row.api_key
                  : row.api_key === expectedSlotKey && row.authorization === null) && row.source === '127.0.0.2',
            ),
        )
        check(
          'model_helper_keeps_cli_unlaunched',
          !JSON.parse(fs.readFileSync(path.join(ownerRoot, 'owner.json'))).runtime_launch_attempted,
        )
      }
    }
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
              ...(tlsMode ? ['--wait-label', 'WAIT_FOR_RESTART', '--release-path', restartRelease] : []),
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
    async function sendTurn(turn, timeoutMs = 45000) {
      const before = lines.filter((row) => row.type === 'result').length
      outer.stdin.write(
        JSON.stringify({
          type: 'user',
          uuid: crypto.randomUUID(),
          message: { role: 'user', content: [{ type: 'text', text: 'HERMIT_MANAGER_TURN_' + turn }] },
        }) + '\n',
      )
      const until = Date.now() + timeoutMs
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
    if (oauthMode) {
      oauthRefreshBoundary = requests.length
      const refreshed = await api(gw, 'POST', '/api/panel/vms/vm-hermit/oauth/refresh', {
        headers: { cookie },
        body: {},
      })
      save('oauth-explicit-refresh.json', refreshed)
      check(
        'oauth_explicit_refresh_and_owner_restart',
        refreshed.status === 200 &&
          refreshed.json.data.refresh_owner === 'hermit-native-slot' &&
          refreshed.json.data.refreshed === true,
      )
      const updated = JSON.parse(
        fs.readFileSync(path.join(run, realDocker ? 'native-slot.json' : 'native-translated.json')),
      )
      const freshRoot = realDocker ? updated.session.root.replace('/run/kin', run) : updated.session.root
      check('oauth_refresh_replaces_owner', freshRoot !== ownerRoot)
      check('refresh_token_never_enters_native_config', !JSON.stringify(updated).includes('sk-ant-ort01'))
      ownerRoot = freshRoot
      await sendTurn(20)
      check('oauth_request_uses_new_token', requests.at(-1).auth.authorization === 'Bearer sk-ant-oat01-runtime-new-1')
      const liveCredential = readWorkerCredentialFile(credentialHome)
      writeWorkerCredentialFile(credentialHome, { ...liveCredential, expires_at: 1 })
      oauthAutoBoundary = requests.length
      await sendTurn(21)
      check(
        'oauth_expiry_recovers_before_native_request',
        requests.at(-1).auth.authorization === 'Bearer sk-ant-oat01-runtime-new-2' && refreshRequests.length === 2,
      )
      const finalConfig = JSON.parse(
        fs.readFileSync(path.join(run, realDocker ? 'native-slot.json' : 'native-translated.json')),
      )
      ownerRoot = realDocker ? finalConfig.session.root.replace('/run/kin', run) : finalConfig.session.root
    }
    if (realDocker) {
      let pendingTurn
      let pendingToolID
      if (tlsMode) {
        pendingTurn = sendTurn(30, 240000)
        pendingTurn.catch(() => {})
        const until = Date.now() + 45000
        while (!fs.existsSync(path.join(out, 'mcp-pending.json')) && Date.now() < until)
          await new Promise((resolve) => setTimeout(resolve, 50))
        check('outer_tool_pending_before_restart', fs.existsSync(path.join(out, 'mcp-pending.json')))
        const call = lines
          .flatMap((row) => (Array.isArray(row.message?.content) ? row.message.content : []))
          .find((block) => block.type === 'tool_use' && block.input?.label === 'WAIT_FOR_RESTART')
        pendingToolID = call?.id
        check(
          'pending_tool_id_observed_by_outer_client',
          typeof pendingToolID === 'string' && pendingToolID.startsWith('toolu_'),
        )
        save('pending-tool-link.json', { model_id: 'toolu_01HermitRestartPending0001', outer_id: pendingToolID })
      }
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
      if (managed) {
        let ready = false
        const until = Date.now() + 12000
        while (Date.now() < until) {
          const listing = await api(gw, 'GET', '/api/panel/proxies')
          const row = listing.json?.data?.proxies?.find((row) => row.id === factoryProxyId)
          if (row?.exit_status === 'ready' && row.blocked_reason === null) {
            ready = true
            save('managed-after-restart.json', listing)
            break
          }
          await new Promise((resolve) => setTimeout(resolve, 100))
        }
        check('managed_readiness_restored_after_restart', ready)
      }
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
      if (tlsMode) {
        fs.writeFileSync(restartRelease, 'release')
        await pendingTurn
        check(
          'pending_tool_result_restored_after_restart',
          requests
            .at(-1)
            .body.messages.some(
              (message) =>
                Array.isArray(message.content) &&
                message.content.some(
                  (block) =>
                    block.type === 'tool_result' &&
                    block.tool_use_id === pendingToolID &&
                    JSON.stringify(block.content).includes('WAIT_FOR_RESTART') &&
                    JSON.stringify(block.content).includes('P1_DYNAMIC_MCP_RESULT'),
                ),
            ),
        )
        const receipts = fs
          .readFileSync(effects, 'utf8')
          .trim()
          .split('\n')
          .map((line) => JSON.parse(line))
        check(
          'pending_outer_tool_not_reexecuted',
          receipts.filter((row) => row.arguments?.label === 'WAIT_FOR_RESTART').length === 1,
        )
      }
      await sendTurn(3)
      check(
        'restart_restores_outer_history',
        JSON.stringify(requests.at(-1).body.messages).includes('ONLY_OUTER_EXECUTES_READ'),
      )
    }
    if (factory) {
      const { stopEgressProcess, egressPidsForProxyConfig } = await import('../../src/lib/vm/egress.mjs')
      const stopHelper = () =>
        controlMode ? controlFixture.stopHelper(factoryProxyId) : stopEgressProcess(project, factoryProxyId)
      const helperPids = () =>
        controlMode ? controlFixture.helperPids(factoryProxyId) : egressPidsForProxyConfig(project, factoryProxyId)
      save('helper-stop-for-failure.json', stopHelper())
      const deadline = Date.now() + 3000
      while (helperPids().length && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 25))
      check('transparent_helper_stopped_for_failure', helperPids().length === 0)
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
    if (managed) {
      const login = await api(gw, 'POST', '/api/panel/login', { body: { username: 'admin', password: 'testpass' } })
      const headers = { cookie: login.headers.get('set-cookie') }
      const bad = await api(gw, 'POST', '/api/panel/proxies/import', {
        headers,
        body: {
          ...managedFixture.importBody,
          config: { ...managedFixture.importBody.config, password: 'wrong-hysteria-password' },
        },
      })
      save('managed-wrong-h2-password.json', bad)
      const badId = bad.json?.data?.items?.[0]?.id
      check(
        'invalid_hysteria_password_not_ready',
        bad.status === 200 &&
          badId &&
          bad.json.data.application_status === 'pending' &&
          bad.json.data.items[0].exit_status !== 'ready',
      )
      const rejected = await api(gw, 'POST', `/api/panel/proxies/${badId}/bind`, {
        headers,
        body: { vm_id: 'vm-hermit' },
      })
      save('managed-wrong-h2-bind.json', rejected)
      check('invalid_hysteria_password_cannot_bind', rejected.status !== 200)
      check(
        'invalid_hysteria_preserves_bound_exit',
        JSON.parse(fs.readFileSync(path.join(project, 'vms/vm-hermit.json'))).proxy.id === factoryProxyId,
      )
      const removed = await api(gw, 'DELETE', `/api/panel/proxies/${badId}`, { headers })
      check('invalid_hysteria_exit_removed', removed.status === 200)
      const reapplied = await api(gw, 'POST', '/api/panel/proxies/apply', {
        headers,
        body: { host_id: 'control-plane' },
      })
      save('managed-reapply-after-auth-failure.json', reapplied)
      check('managed_recovery_after_auth_failure', reapplied.status === 200 && reapplied.json.ok)
      const listing = await api(gw, 'GET', '/api/panel/proxies')
      save('managed-recovered.json', listing)
      const row = listing.json.data.proxies.find((row) => row.id === factoryProxyId)
      check('managed_bound_exit_ready_after_recovery', row.exit_status === 'ready' && row.blocked_reason === null)
      await sendTurn(4)
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
  if (tlsMode) fs.writeFileSync(restartRelease, 'cleanup release')
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
  if (oauthMode && completed) {
    check(
      'oauth_all_requests_use_expected_token',
      requests.every(
        (row, index) =>
          row.auth.authorization ===
            'Bearer ' +
              (index < oauthRefreshBoundary
                ? OAUTH_AT
                : index < oauthAutoBoundary
                  ? 'sk-ant-oat01-runtime-new-1'
                  : 'sk-ant-oat01-runtime-new-2') && !row.auth.api_key,
      ),
    )
    check(
      'refresh_tokens_rotated_by_single_owner',
      refreshRequests.length === 2 &&
        refreshRequests[0].refresh_token === OAUTH_RT &&
        refreshRequests[1].refresh_token === 'sk-ant-ort01-runtime-new-1',
    )
    if (factory)
      check(
        'oauth_refresh_uses_assigned_exit',
        refreshRequests.every((row) => row.source === '127.0.0.2'),
      )
  }
  if (tlsMode && completed) {
    check(
      'messages_and_models_use_fixed_tls_api_host',
      [...requests, ...modelRequests].every(
        (row) => row.tls && row.host === 'api.anthropic.com' && row.source === '127.0.0.2',
      ),
    )
    if (oauthMode)
      check(
        'refresh_uses_separate_tls_host',
        refreshRequests.length === 2 &&
          refreshRequests.every((row) => row.tls && row.host === 'platform.claude.com' && row.source === '127.0.0.2'),
      )
    check(
      'tls_sni_uses_expected_domains',
      httpsFixture.connections.some((row) => row.sni === 'api.anthropic.com') &&
        (!oauthMode || httpsFixture.connections.some((row) => row.sni === 'platform.claude.com')),
    )
  }
  if (slotApiKey && completed) {
    check(
      'native_requests_use_slot_key',
      requests.length > 0 &&
        requests.every((row) => row.auth.api_key === expectedSlotKey && row.auth.authorization === null),
    )
    check('slot_key_not_in_server_logs', !gw.stderr().includes(SLOT_KEY) && !gw.stdout().includes(SLOT_KEY))
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
  if (httpsFixture) {
    httpsFixture.server.closeAllConnections()
    await new Promise((resolve) => httpsFixture.server.close(resolve))
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
  if (managedFixture) managedFixture.stop()
  if (controlFixture) controlFixture.stop()
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
    managed_hysteria2: managed,
    control_container: controlMode,
    mock_docker_boundary: !realDocker,
    real_provider: 'NOT RUN',
    physical_docker: realDocker ? 'RUN' : 'NOT RUN',
  })
}
process.exit(completed && checks.every((row) => row.result === 'PASS') ? 0 : 1)
