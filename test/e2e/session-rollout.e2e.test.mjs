import assert from 'node:assert/strict'
import test from 'node:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import http from 'node:http'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { createDatabase } from '../../src/lib/db/database.mjs'
import { ApiKeyStore } from '../../src/lib/admin/api-keys.mjs'

// 失败方式在 docs/operations/session-rollout.md 中先于实现固定。
test('真实进程：会话固定、切流、重启、准入、结算去重与保守排空', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-rollout-'))
  const artifact = path.resolve(process.env.ROLLOUT_E2E_OUT || path.join('.tmp', path.basename(root)))
  fs.mkdirSync(artifact, { recursive: true })
  const checks = []
  const children = []
  const servers = []
  const runtime = { old: { pending: 0, cold: false }, new: { pending: 0, cold: false } }
  const reportsByGroup = {}
  let holdResponse = null
  let lastClaim = null
  const verify = (name, ok) => {
    checks.push({ name, result: ok ? 'PASS' : 'FAIL' })
    assert.ok(ok, name)
  }
  let result = 'FAIL'
  try {
    const db = createDatabase({ dataDir: root })
    const keys = new ApiKeyStore({ db, hashSecret: 'isolated-rollout-hash' })
    const created = keys.create({ name: 'isolated', max_concurrency: 1, quota_requests: 100 })
    const token = created.key
    assert.ok(token)
    db.close()
    fs.writeFileSync(path.join(root, 'secret'), 'isolated-rollout-secret-32-bytes-minimum', { mode: 0o600 })
    const backends = {}
    for (const id of ['old', 'new']) {
      const reports = new Map()
      reportsByGroup[id] = reports
      const server = http.createServer(async (req, res) => {
        if (req.url === '/_rollout/status')
          return res.end(
            JSON.stringify({
              schema: 1,
              inventory: { accounts: [id] },
              group: id,
              instance: id,
              ready: true,
              active_requests: 0,
              queued_requests: 0,
              pending_tool_results: runtime[id].pending,
              helper_active: false,
              recovering: false,
              switch_ready: runtime[id].pending === 0,
              ...(runtime[id].cold ? { session_restore_protocol: 'anthropic-full-history-v1' } : {}),
            }),
          )
        if (req.url.startsWith('/_rollout/results/'))
          return res.end(JSON.stringify(reports.get(req.url.split('/').pop()) || { state: 'unknown' }))
        let raw = ''
        for await (const chunk of req) raw += chunk
        const body = raw ? JSON.parse(raw) : {}
        const claim = JSON.parse(Buffer.from(req.headers['x-kin-rollout-admission'].split('.')[0], 'base64url'))
        lastClaim = claim
        if (body.stream) {
          res.writeHead(200, { 'content-type': 'text/event-stream' })
          res.write('event: message_start\ndata: {"type":"message_start"}\n\n')
          holdResponse = () => {
            reports.set(claim.request_id, {
              request_id: claim.request_id,
              group: id,
              instance: id,
              state: 'completed',
              outcome: 'success',
              usage: { input_tokens: 1, output_tokens: 1 },
              model: body.model,
            })
            res.end('event: message_stop\ndata: {"type":"message_stop"}\n\n')
          }
          return
        }
        if (body.model === 'isolated-unknown') {
          res.destroy()
          return
        }
        reports.set(claim.request_id, {
          request_id: claim.request_id,
          group: id,
          instance: id,
          state: 'completed',
          outcome: 'success',
          usage: { input_tokens: 3, output_tokens: 2 },
          model: body.model,
          official_cost: 0.031,
        })
        res.setHeader('content-type', 'application/json')
        res.end(
          JSON.stringify({ group: id, request_id: claim.request_id, content: [{ type: 'text', text: 'isolated' }] }),
        )
      })
      await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
      servers.push(server)
      backends[id] = `http://127.0.0.1:${server.address().port}`
    }
    let child, base
    async function start() {
      child = spawn(process.execPath, ['src/session-gateway.mjs'], {
        env: {
          ...process.env,
          HOST: '127.0.0.1',
          PORT: '0',
          KIN_ROLLOUT_STATE: root,
          KIN_ROLLOUT_SECRET_FILE: path.join(root, 'secret'),
          KIN_API_KEY_HASH_SECRET: 'isolated-rollout-hash',
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      })
      children.push(child)
      let log = ''
      child.stderr.on('data', (b) => {
        log += b
      })
      base = await new Promise((resolve, reject) => {
        child.stdout.on('data', (b) => {
          try {
            const row = JSON.parse(String(b))
            if (row.event === 'listening') resolve(row.url)
          } catch {}
        })
        child.once('exit', () => reject(new Error(log)))
        setTimeout(() => reject(new Error('gateway readiness timeout')), 10000).unref()
      })
    }
    async function admin(route, body) {
      const res = await fetch(base + '/_rollout/' + route, {
        method: body ? 'POST' : 'GET',
        headers: {
          authorization: 'Bearer isolated-rollout-secret-32-bytes-minimum',
          'content-type': 'application/json',
        },
        ...(body ? { body: JSON.stringify(body) } : {}),
      })
      return { status: res.status, body: await res.json() }
    }
    async function call(session) {
      const res = await fetch(base + '/v1/messages', {
        method: 'POST',
        headers: {
          authorization: `Bearer ${token}`,
          'content-type': 'application/json',
          ...(session ? { 'x-claude-code-session-id': session } : {}),
        },
        body: JSON.stringify({ model: 'claude-sonnet-4-6', messages: [{ role: 'user', content: 'ISOLATED' }] }),
      })
      const body = await res.json()
      if (body.request_id)
        for (let i = 0; i < 100; i++) {
          const snapshot = await admin('snapshot')
          if (snapshot.body.requests.find((r) => r.id === body.request_id)?.state === 'settled') break
          await new Promise((resolve) => setTimeout(resolve, 20))
        }
      return { status: res.status, body }
    }
    await start()
    for (const id of ['old', 'new'])
      verify(
        'register_' + id,
        (
          await admin('groups', {
            id,
            url: backends[id],
            instance: id,
            artifact: 'sha256:' + id,
            resources: { root: path.join(root, id), accounts: [id], containers: [id] },
          })
        ).status === 200,
      )
    verify('activate_old', (await admin('policy', { expected_generation: 0, target: 'old' })).status === 200)
    const first = await call('session-A')
    verify('first_old', first.body.group === 'old')
    verify('activate_new', (await admin('policy', { expected_generation: 1, target: 'new' })).status === 200)
    verify('existing_stays_old', (await call('session-A')).body.group === 'old')
    verify('new_goes_new', (await call('session-B')).body.group === 'new')
    verify('stale_policy_rejected', (await admin('policy', { expected_generation: 1, target: 'old' })).status === 409)
    verify('bound_sessions_block_drain', (await admin('drain/old')).body.drained === false)
    child.kill('SIGTERM')
    await once(child, 'exit')
    await start()
    verify('restart_keeps_binding', (await call('session-A')).body.group === 'old')
    const receipt = await admin('snapshot')
    verify(
      'exactly_once_settlement',
      receipt.body.requests.length === 4 && receipt.body.requests.every((r) => r.state === 'settled'),
    )
    verify('official_cost_preserved_once', Math.abs((await admin('keys')).body[0].quota_usd_used - 0.124) < 1e-10)
    const models = await fetch(base + '/v1/models', { headers: { authorization: `Bearer ${token}` } })
    await models.text()
    verify('model_discovery_supported', models.status === 200)
    for (let i = 0; i < 100 && (await admin('snapshot')).body.requests.some((r) => r.state !== 'settled'); i++)
      await new Promise((r) => setTimeout(r, 20))
    verify('metadata_not_billed', (await admin('keys')).body[0].quota_used === 4)
    verify('no_prompt_in_receipt', !JSON.stringify(receipt).includes('ISOLATED'))
    verify('unauthorized_admin', (await fetch(base + '/_rollout/snapshot')).status === 401)
    const headers = {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
      'x-claude-code-session-id': 'long-stream',
    }
    const stream = await fetch(base + '/v1/messages', {
      method: 'POST',
      headers,
      body: JSON.stringify({
        stream: true,
        model: 'claude-sonnet-4-6',
        messages: [{ role: 'user', content: 'ISOLATED' }],
      }),
    })
    const reader = stream.body.getReader()
    verify('stream_started', !(await reader.read()).done)
    verify('global_concurrency', (await call('blocked')).status === 429)
    verify(
      'rollback_new_sessions_only',
      (await admin('policy', { expected_generation: 2, target: 'old' })).status === 200,
    )
    verify('active_stream_blocks_retirement', (await admin('drain/new')).body.drained === false)
    holdResponse()
    let tail = ''
    for (;;) {
      const part = await reader.read()
      if (part.done) break
      tail += Buffer.from(part.value).toString()
    }
    verify('stream_survives_cutover', tail.includes('message_stop'))
    for (let i = 0; i < 100 && (await admin('snapshot')).body.requests.some((r) => r.state !== 'settled'); i++)
      await new Promise((r) => setTimeout(r, 20))
    const anonymous = await call()
    verify('conservative_first_binding', anonymous.body.group === 'old')
    verify('activate_new_again', (await admin('policy', { expected_generation: 3, target: 'new' })).status === 200)
    verify('conservative_binding_stays_old', (await call()).body.group === 'old')
    runtime.old.cold = true
    runtime.old.pending = 1
    verify('pending_tools_block_retire', (await admin('drain/old')).body.drained === false)
    runtime.old.pending = 0
    verify('anonymous_prevents_automatic_retire', (await admin('drain/old')).body.drained === false)
    runtime.new.cold = true
    const unknown = await fetch(base + '/v1/messages', {
      method: 'POST',
      headers: { ...headers, 'x-claude-code-session-id': 'unknown' },
      body: JSON.stringify({ model: 'isolated-unknown', messages: [{ role: 'user', content: 'ISOLATED' }] }),
    })
    verify('unknown_explicit', unknown.status === 502)
    const unresolved = lastClaim
    child.kill('SIGKILL')
    await once(child, 'exit')
    await start()
    verify('crash_preserves_occupancy', (await call('after-crash')).status === 429)
    reportsByGroup.new.set(unresolved.request_id, {
      request_id: unresolved.request_id,
      group: 'new',
      instance: 'new',
      state: 'completed',
      outcome: 'success',
      usage: { input_tokens: 1, output_tokens: 1 },
      model: 'claude-sonnet-4-6',
    })
    for (let i = 0; i < 150 && (await admin('snapshot')).body.requests.some((r) => r.state !== 'settled'); i++)
      await new Promise((r) => setTimeout(r, 20))
    verify('reconciliation_recovers', (await call('after-reconcile')).status === 200)
    verify('rollback_to_old', (await admin('policy', { expected_generation: 4, target: 'old' })).status === 200)
    const drained = await admin('drain/new')
    verify('certified_full_history_can_drain', drained.body.drained === true)
    verify('atomic_retire', (await admin('retire', { expected_generation: 5, group: 'new' })).status === 200)
    verify(
      'resource_overlap_rejected',
      (
        await admin('groups', {
          id: 'overlap',
          url: 'http://127.0.0.1:12345',
          instance: 'overlap',
          artifact: 'sha256:overlap',
          resources: { root: path.join(root, 'newer'), accounts: ['old'], containers: ['another'] },
        })
      ).status === 409,
    )
    result = 'PASS'
  } finally {
    for (const child of children)
      if (child.exitCode === null && child.signalCode === null) {
        child.kill('SIGTERM')
        await once(child, 'exit')
      }
    for (const server of servers) {
      server.closeAllConnections()
      await new Promise((resolve) => server.close(resolve))
    }
    fs.writeFileSync(
      path.join(artifact, 'summary.json'),
      JSON.stringify(
        {
          result,
          checks,
          boundary: '真实网关进程和 SQLite；两个业务后端为受控 HTTP 服务，无真实 CLI 或模型上游',
          cleanup: children.every((c) => c.exitCode !== null || c.signalCode !== null),
        },
        null,
        2,
      ),
    )
    fs.rmSync(root, { recursive: true, force: true })
  }
})
