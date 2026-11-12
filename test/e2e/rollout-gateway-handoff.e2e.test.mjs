import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import http from 'node:http'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { createDatabase } from '../../src/lib/db/database.mjs'
import { ApiKeyStore } from '../../src/lib/admin/api-keys.mjs'

// 失败方式：旧流被截断、两个网关重复放行或计费、过早停旧网关、错误实例被排空。
test('真实双网关共享准入并在旧流结束后交接', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-gateway-handoff-'))
  const out = path.resolve(process.env.ROLLOUT_HANDOFF_OUT || path.join('.tmp', path.basename(root)))
  fs.mkdirSync(out, { recursive: true })
  const secret = 'isolated-gateway-handoff-secret-32-bytes'
  fs.writeFileSync(path.join(root, 'secret'), secret, { mode: 0o600 })
  const db = createDatabase({ dataDir: root }),
    keys = new ApiKeyStore({ db, hashSecret: 'isolated-handoff-hash' })
  const key = keys.create({ name: 'handoff', max_concurrency: 1 })
  db.close()
  const checks = [],
    children = [],
    reports = new Map()
  let result = 'FAIL',
    release
  const check = (name, ok) => {
    checks.push({ name, result: ok ? 'PASS' : 'FAIL' })
    assert.ok(ok, name)
  }
  const backend = http.createServer(async (req, res) => {
    if (req.url === '/_rollout/status')
      return res.end(
        JSON.stringify({
          schema: 1,
          group: 'backend',
          instance: 'backend',
          ready: true,
          inventory: { accounts: ['account'] },
        }),
      )
    if (req.url.startsWith('/_rollout/results/'))
      return res.end(JSON.stringify(reports.get(req.url.split('/').pop()) || { state: 'unknown' }))
    let raw = ''
    for await (const chunk of req) raw += chunk
    const claim = JSON.parse(Buffer.from(req.headers['x-kin-rollout-admission'].split('.')[0], 'base64url')),
      body = JSON.parse(raw)
    const done = () =>
      reports.set(claim.request_id, {
        request_id: claim.request_id,
        group: 'backend',
        instance: 'backend',
        state: 'completed',
        outcome: 'success',
        usage: { input_tokens: 1 },
        model: 'isolated',
        official_cost: 0.02,
      })
    if (body.stream) {
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      res.write('data: start\n\n')
      release = () => {
        done()
        res.end('data: completed\n\n')
      }
    } else {
      done()
      res.end('{"done":true}')
    }
  })
  await new Promise((r) => backend.listen(0, '127.0.0.1', r))
  try {
    async function start(instance, port = 0) {
      const child = spawn(process.execPath, ['src/session-gateway.mjs'], {
        env: {
          ...process.env,
          HOST: '127.0.0.1',
          PORT: String(port),
          KIN_ROLLOUT_ADMIN_PORT: '0',
          KIN_ROLLOUT_REUSE_PORT: process.platform === 'linux' ? '1' : '0',
          KIN_ROLLOUT_INSTANCE: instance,
          KIN_ROLLOUT_STATE: root,
          KIN_ROLLOUT_SECRET_FILE: path.join(root, 'secret'),
          KIN_API_KEY_HASH_SECRET: 'isolated-handoff-hash',
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      })
      children.push(child)
      let error = ''
      child.stderr.on('data', (b) => {
        error += b
      })
      const info = await new Promise((resolve, reject) => {
        child.stdout.on('data', (b) => {
          try {
            resolve(JSON.parse(String(b)))
          } catch {}
        })
        child.once('exit', () => reject(new Error(error)))
      })
      return { child, ...info }
    }
    async function admin(base, route, body) {
      const res = await fetch(base + '/_rollout/' + route, {
        method: body ? 'POST' : 'GET',
        headers: { authorization: `Bearer ${secret}`, 'content-type': 'application/json' },
        ...(body ? { body: JSON.stringify(body) } : {}),
      })
      return { status: res.status, body: await res.json() }
    }
    const old = await start('old')
    await admin(old.admin_url, 'groups', {
      id: 'backend',
      instance: 'backend',
      url: `http://127.0.0.1:${backend.address().port}`,
      artifact: 'sha256:isolated',
      resources: { root: path.join(root, 'backend'), accounts: ['account'], containers: ['backend'] },
    })
    await admin(old.admin_url, 'policy', { expected_generation: 0, target: 'backend' })
    const headers = {
        authorization: 'Bearer ' + key.key,
        'content-type': 'application/json',
        'x-claude-code-session-id': 'handoff',
      },
      messages = [{ role: 'user', content: 'ISOLATED' }]
    const stream = await fetch(old.url + '/v1/messages', {
      method: 'POST',
      headers,
      body: JSON.stringify({ stream: true, messages }),
    })
    const reader = stream.body.getReader()
    await reader.read()
    const next = await start('new', process.platform === 'linux' ? Number(new URL(old.url).port) : 0)
    check(
      'wrong_instance_not_drained',
      (await admin(old.admin_url, 'gateway/drain', { instance: 'wrong' })).status === 409,
    )
    const draining = await admin(old.admin_url, 'gateway/drain', { instance: 'old' })
    check('active_old_stream_preserved', draining.body.drained === false && draining.body.active_requests === 1)
    check(
      'global_concurrency_shared',
      (await fetch(next.url + '/v1/messages', { method: 'POST', headers, body: JSON.stringify({ messages }) }))
        .status === 429,
    )
    release()
    let text = ''
    for (;;) {
      const part = await reader.read()
      if (part.done) break
      text += Buffer.from(part.value).toString()
    }
    check('old_stream_finished', text.includes('completed'))
    let status
    for (let i = 0; i < 100; i++) {
      status = await admin(old.admin_url, 'gateway/status')
      if (status.body.drained) break
      await new Promise((r) => setTimeout(r, 20))
    }
    check('old_gateway_drain_confirmed', status.body.drained === true)
    old.child.kill('SIGTERM')
    await once(old.child, 'exit')
    for (
      let i = 0;
      i < 150 && (await admin(next.admin_url, 'snapshot')).body.requests.some((r) => r.state !== 'settled');
      i++
    )
      await new Promise((r) => setTimeout(r, 20))
    const response = await fetch(next.url + '/v1/messages', {
      method: 'POST',
      headers,
      body: JSON.stringify({ messages }),
    })
    await response.text()
    check('new_gateway_serves_after_old_exit', response.status === 200)
    for (
      let i = 0;
      i < 100 && (await admin(next.admin_url, 'snapshot')).body.requests.some((r) => r.state !== 'settled');
      i++
    )
      await new Promise((r) => setTimeout(r, 20))
    check(
      'shared_settlement_exactly_once',
      Math.abs((await admin(next.admin_url, 'keys')).body[0].quota_usd_used - 0.04) < 1e-10,
    )
    result = 'PASS'
  } finally {
    for (const child of children)
      if (child.exitCode === null && child.signalCode === null) {
        child.kill('SIGTERM')
        await once(child, 'exit')
      }
    backend.closeAllConnections()
    await new Promise((r) => backend.close(r))
    fs.writeFileSync(
      path.join(out, 'summary.json'),
      JSON.stringify(
        {
          result,
          checks,
          same_port_reuse: process.platform === 'linux',
          boundary: '真实双网关进程与共享 SQLite；业务后端受控。Linux 验证同端口复用；其他平台验证独立端口交接。',
          cleanup: children.every((c) => c.exitCode !== null || c.signalCode !== null),
        },
        null,
        2,
      ),
    )
    fs.rmSync(root, { recursive: true, force: true })
  }
})
