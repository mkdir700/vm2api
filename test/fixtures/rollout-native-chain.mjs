import fs from 'node:fs'
import path from 'node:path'
import http from 'node:http'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { startGateway, seedVm } from '../harness.mjs'

const config = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'))
const checks = [], children = [], groups = []
const check = (name, ok) => { checks.push({ name, result: ok ? 'PASS' : 'FAIL' }); if (!ok) throw new Error(name) }
const secret = fs.readFileSync(config.secret_file, 'utf8').trim()
let gateway, base, result = 'FAIL'
try {
  const authority = path.join(config.root, 'authority')
  gateway = spawn(process.execPath, ['src/session-gateway.mjs'], { env: { ...process.env, HOST: '127.0.0.1', PORT: '0', KIN_ROLLOUT_STATE: authority, KIN_ROLLOUT_SECRET_FILE: config.secret_file, KIN_API_KEY: 'isolated-public-key' }, stdio: ['ignore', 'pipe', 'pipe'] }); children.push(gateway)
  let error = ''; gateway.stderr.on('data', b => { error += b })
  base = await new Promise((resolve, reject) => { gateway.stdout.on('data', b => { try { resolve(JSON.parse(String(b)).url) } catch {} }); gateway.once('exit', () => reject(new Error(error))); setTimeout(() => reject(new Error('gateway startup')), 10000).unref() })
  async function admin(route, body) { const res = await fetch(base + '/_rollout/' + route, { method: body ? 'POST' : 'GET', headers: { authorization: `Bearer ${secret}`, 'content-type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) }); const value = await res.json(); if (!res.ok) throw new Error('admin ' + route + ' ' + JSON.stringify(value)); return value }
  for (const id of ['old', 'new']) {
    const project = path.join(config.root, id), vm = seedVm({ project })
    vm.proxy = { id: 'isolated-direct', scheme: 'direct' }
    vm.claude.account_uuid = 'isolated-' + id
    vm.runtime.kernel_socket = config.sockets[id]
    fs.writeFileSync(path.join(project, 'vms', `${vm.id}.json`), JSON.stringify(vm))
    fs.mkdirSync(vm.runtime.worker_run_dir, { recursive: true }); fs.writeFileSync(vm.runtime.worker_token_file, config.token, { mode: 0o600 })
    const group = await startGateway({ project, readyMs: 30000, timeoutMs: 45000, env: { KIN_ROLLOUT_GROUP: id, KIN_ROLLOUT_INSTANCE: id, KIN_ROLLOUT_SECRET_FILE: config.secret_file, KIN_ROLLOUT_AUTHORITY_DB: path.join(authority, 'kin.db'), KIN_CRS_MOCK: '0', KIN_API_KERNEL_BIN: config.api_kernel, KIN_KERNEL_BIN: process.execPath, KIN_AUTO_SYNC_WRAP: '0' } })
    groups.push(group)
    fs.appendFileSync(path.join(config.out, 'owned-api-kernels.jsonl'), JSON.stringify({ binary: config.api_kernel, socket: path.join(project, 'data/run/api-kernel.sock') }) + '\n')
    await admin('groups', { id, instance: id, url: group.baseUrl, artifact: 'sha256:' + config.hermit_sha256, resources: { root: project, accounts: ['isolated-' + id], containers: ['isolated-' + id] } })
  }
  await admin('policy', { expected_generation: 0, target: 'old' })
  async function message(session, messages, tools = []) {
    const res = await fetch(base + '/v1/messages', { method: 'POST', headers: { authorization: 'Bearer isolated-public-key', 'content-type': 'application/json', 'x-claude-code-session-id': session }, body: JSON.stringify({ model: 'claude-sonnet-4-6', max_tokens: 128, messages, ...(tools.length ? { tools } : {}) }), signal: AbortSignal.timeout(60000) })
    const body = await res.json()
    if (res.status !== 200) throw new Error('business ' + res.status + ' ' + JSON.stringify(body))
    for (let i = 0; i < 150; i++) { const snapshot = await admin('snapshot'); if (snapshot.requests.every(r => r.state === 'settled')) break; await new Promise(r => setTimeout(r, 20)) }
    return body
  }
  const tools = [{ name: 'Probe', description: 'Isolated caller-owned tool', input_schema: { type: 'object', properties: { label: { type: 'string' } }, required: ['label'] } }]
  let history = [{ role: 'user', content: 'ROLLOUT_WAIT_TOOL' }]
  const first = await message('old-session', history, tools)
  const tool = first.content.find(c => c.type === 'tool_use'); check('real_cli_returned_external_tool', !!tool)
  await admin('policy', { expected_generation: 1, target: 'new' })
  const waiting = await admin('drain/old'); check('tool_wait_prevents_retirement', waiting.drained === false)
  await message('new-session', [{ role: 'user', content: 'ROLLOUT_NEW_SESSION' }])
  history.push({ role: 'assistant', content: first.content }, { role: 'user', content: [{ type: 'tool_result', tool_use_id: tool.id, content: 'ISOLATED_TOOL_DONE' }] })
  const continued = await message('old-session', history, tools); check('tool_result_continues_old', continued.content.some(c => c.type === 'text'))
  let snapshot = await admin('snapshot'); check('old_had_two_requests_new_one', snapshot.requests.filter(r => r.group_id === 'old').length === 2 && snapshot.requests.filter(r => r.group_id === 'new').length === 1)
  let drained
  for (let i = 0; i < 100; i++) { drained = await admin('drain/old'); if (drained.drained) break; await new Promise(r => setTimeout(r, 50)) }
  check('real_native_proof_allows_drain', drained.drained === true)
  await admin('retire', { expected_generation: 2, group: 'old' })
  const stopped = await fetch(config.provider + '/fixture/stop-old', { method: 'POST' }).then(r => r.json()); check('old_native_stopped_before_recovery', stopped.stopped === true)
  history.push({ role: 'assistant', content: continued.content }, { role: 'user', content: 'ROLLOUT_AFTER_RETIREMENT' })
  const recovered = await message('old-session', history, tools); check('full_history_restores_on_new', recovered.content.some(c => c.type === 'text'))
  snapshot = await admin('snapshot'); check('restored_request_only_on_new', snapshot.requests.filter(r => r.group_id === 'old').length === 2 && snapshot.requests.filter(r => r.group_id === 'new').length === 2)
  check('all_execution_receipts_settled', snapshot.requests.every(r => r.state === 'settled'))
  fs.writeFileSync(path.join(config.out, 'gateway-snapshot.json'), JSON.stringify(snapshot, null, 2))
  result = 'PASS'
} catch (error) {
  fs.writeFileSync(path.join(config.out, 'driver-failure.txt'), String(error.stack || error))
  throw error
} finally {
  for (const [index, group] of groups.entries()) { await group.stop(); if (group.child.exitCode === null && group.child.signalCode === null) await once(group.child, 'exit'); if (result !== 'PASS') fs.writeFileSync(path.join(config.out, `group-${index}-stderr.txt`), group.stderr().slice(-8000)) }
  for (const child of children) if (child.exitCode === null && child.signalCode === null) { child.kill('SIGTERM'); await once(child, 'exit') }
  fs.writeFileSync(path.join(config.out, 'driver-summary.json'), JSON.stringify({ result, checks, cleanup: [...groups.map(g => g.child), ...children].every(c => c.exitCode !== null || c.signalCode !== null) }, null, 2))
}
