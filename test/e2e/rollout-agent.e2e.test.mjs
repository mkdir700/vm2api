import test from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { spawn } from 'node:child_process'
import { once } from 'node:events'

test('真实发布接收器：认证、来源限制、重复通知与 tag 固定', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-rollout-agent-'))
  const out = path.resolve(process.env.ROLLOUT_AGENT_OUT || path.join('.tmp', path.basename(root)))
  fs.mkdirSync(out, { recursive: true })
  const secret = 'isolated-agent-notification-secret-32-bytes'
  fs.writeFileSync(path.join(root, 'secret'), secret, { mode: 0o600 })
  const config = {
    spool: path.join(root, 'spool'),
    notification_secret_file: path.join(root, 'secret'),
    sources: { vm2api: { repository: 'isolated/vm2api', image: 'ghcr.io/isolated/vm2api' } },
  }
  const configFile = path.join(root, 'agent.json')
  fs.writeFileSync(configFile, JSON.stringify(config), { mode: 0o600 })
  const child = spawn('python3', ['-u', 'deploy/rollout-agent.py', 'receive', '--config', configFile, '--port', '0'], {
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let stderr = ''
  child.stderr.on('data', (b) => {
    stderr += b
  })
  const checks = []
  const check = (name, ok) => {
    checks.push({ name, result: ok ? 'PASS' : 'FAIL' })
    assert.ok(ok, name + stderr.slice(-300))
  }
  let result = 'FAIL'
  try {
    const base = await new Promise((resolve, reject) => {
      child.stdout.on('data', (b) => {
        try {
          resolve(JSON.parse(String(b)).url)
        } catch {}
      })
      child.once('exit', () => reject(new Error(stderr)))
      setTimeout(() => reject(new Error('receiver timeout')), 10000).unref()
    })
    const image = 'ghcr.io/isolated/vm2api@sha256:' + 'a'.repeat(64),
      commit = 'b'.repeat(40)
    const payload = {
      schema: 1,
      component: 'vm2api',
      repository: 'isolated/vm2api',
      tag: 'v1.2.3',
      commit,
      image,
      qualification: { result: 'PASS', commit, image, migration: 'compatible', evidence_sha256: 'c'.repeat(64) },
    }
    async function post(body, valid = true, timestamp = Math.floor(Date.now() / 1000)) {
      const raw = JSON.stringify(body),
        signature = crypto.createHmac('sha256', secret).update(`${timestamp}.${raw}`).digest('hex')
      const res = await fetch(base + '/events', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-rollout-timestamp': String(timestamp),
          'x-rollout-signature': valid ? signature : 'invalid',
        },
        body: raw,
      })
      return { status: res.status, body: await res.json() }
    }
    check('unsigned_rejected', (await post(payload, false)).status === 401)
    check('stale_rejected', (await post(payload, true, 1)).status === 401)
    check('wrong_repository_rejected', (await post({ ...payload, repository: 'untrusted/fork' })).status === 400)
    check(
      'mutable_image_rejected',
      (await post({ ...payload, image: 'ghcr.io/isolated/vm2api:latest' })).status === 400,
    )
    check('unqualified_rejected', (await post({ ...payload, qualification: { result: 'FAIL' } })).status === 400)
    const accepted = await post(payload)
    check('qualified_queued', accepted.status === 202 && accepted.body.state === 'queued')
    check('notification_idempotent', (await post(payload)).body.id === accepted.body.id)
    check(
      'retag_rejected',
      (
        await post({
          ...payload,
          commit: 'd'.repeat(40),
          qualification: { ...payload.qualification, commit: 'd'.repeat(40) },
        })
      ).status === 409,
    )
    check('durable_queue', fs.existsSync(path.join(config.spool, accepted.body.id, 'event.json')))
    const query = '/events/' + accepted.body.id,
      stamp = String(Math.floor(Date.now() / 1000))
    check('unauthorized_status_rejected', (await fetch(base + query)).status === 401)
    const signature = crypto.createHmac('sha256', secret).update(`${stamp}.GET ${query}`).digest('hex')
    const queued = await fetch(base + query, {
      headers: { 'x-rollout-timestamp': stamp, 'x-rollout-signature': signature },
    }).then((r) => r.json())
    check('query_reports_queue_only', queued.state === 'queued')
    check('receiver_does_not_deploy', !fs.existsSync(path.join(config.spool, accepted.body.id, 'task.json')))
    result = 'PASS'
  } finally {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill('SIGTERM')
      await once(child, 'exit')
    }
    fs.writeFileSync(
      path.join(out, 'summary.json'),
      JSON.stringify(
        {
          result,
          checks,
          boundary: '真实 HTTP 接收进程与持久队列；无 GitHub、镜像仓库或生产连接',
          cleanup: child.exitCode !== null || child.signalCode !== null,
        },
        null,
        2,
      ),
    )
    fs.rmSync(root, { recursive: true, force: true })
  }
})
