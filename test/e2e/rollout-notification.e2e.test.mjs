import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import https from 'node:https'
import http from 'node:http'
import { execFileSync, spawn } from 'node:child_process'
import { once } from 'node:events'

// 失败方式：CI 把入队当部署成功、HTTPS 证书未验证、代理路径签名不一致、任务失联仍报成功。
test('真实 HTTPS 通知先入队，查询到完成后才生成 DEPLOYED 回执', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-rollout-notify-'))
  const out = path.resolve(process.env.ROLLOUT_NOTIFICATION_OUT || path.join('.tmp', path.basename(root)))
  fs.mkdirSync(out, { recursive: true })
  const secret = 'isolated-notification-secret-at-least-32-bytes',
    spool = path.join(root, 'spool'),
    checks = [],
    children = []
  const check = (name, ok) => {
    checks.push({ name, result: ok ? 'PASS' : 'FAIL' })
    assert.ok(ok, name)
  }
  let proxy,
    result = 'FAIL'
  try {
    fs.writeFileSync(path.join(root, 'secret'), secret, { mode: 0o600 })
    fs.writeFileSync(
      path.join(root, 'agent.json'),
      JSON.stringify({
        spool,
        notification_secret_file: path.join(root, 'secret'),
        sources: { vm2api: { repository: 'isolated/vm2api', image: 'ghcr.io/isolated/vm2api' } },
      }),
      { mode: 0o600 },
    )
    const receiver = spawn(
      'python3',
      ['-u', 'deploy/rollout-agent.py', 'receive', '--config', path.join(root, 'agent.json'), '--port', '0'],
      { stdio: ['ignore', 'pipe', 'pipe'] },
    )
    children.push(receiver)
    const base = await new Promise((resolve, reject) => {
      receiver.stdout.on('data', (b) => {
        try {
          resolve(JSON.parse(String(b)).url)
        } catch {}
      })
      receiver.once('exit', reject)
    })
    fs.writeFileSync(
      path.join(root, 'openssl.conf'),
      '[req]\ndistinguished_name=dn\nx509_extensions=v3\nprompt=no\n[dn]\nCN=127.0.0.1\n[v3]\nsubjectAltName=IP:127.0.0.1\nbasicConstraints=critical,CA:TRUE\nkeyUsage=critical,digitalSignature,keyEncipherment,keyCertSign\n',
    )
    execFileSync(
      'openssl',
      [
        'req',
        '-x509',
        '-newkey',
        'rsa:2048',
        '-nodes',
        '-days',
        '1',
        '-keyout',
        path.join(root, 'key.pem'),
        '-out',
        path.join(root, 'cert.pem'),
        '-config',
        path.join(root, 'openssl.conf'),
      ],
      { stdio: 'ignore' },
    )
    proxy = https.createServer(
      { key: fs.readFileSync(path.join(root, 'key.pem')), cert: fs.readFileSync(path.join(root, 'cert.pem')) },
      (req, res) => {
        const upstream = http.request(
          base + req.url.replace('/internal/rollout', ''),
          { method: req.method, headers: req.headers },
          (response) => {
            res.writeHead(response.statusCode, response.headers)
            response.pipe(res)
          },
        )
        req.pipe(upstream)
        upstream.on('error', () => res.destroy())
      },
    )
    await new Promise((r) => proxy.listen(0, '127.0.0.1', r))
    const commit = 'b'.repeat(40),
      image = 'ghcr.io/isolated/vm2api@sha256:' + 'a'.repeat(64)
    const event = {
      workflow_run: {
        id: 1,
        event: 'push',
        conclusion: 'success',
        head_branch: 'v1.2.3',
        head_sha: commit,
        head_repository: { full_name: 'isolated/vm2api' },
      },
    }
    fs.writeFileSync(path.join(root, 'event.json'), JSON.stringify(event))
    fs.writeFileSync(
      path.join(root, 'qualification.json'),
      JSON.stringify({ result: 'PASS', commit, image, migration: 'compatible', evidence_sha256: 'c'.repeat(64) }),
    )
    const sender = spawn('python3', [path.resolve('.github/scripts/notify-rollout.py')], {
      cwd: root,
      env: {
        ...process.env,
        GITHUB_EVENT_PATH: path.join(root, 'event.json'),
        GITHUB_REPOSITORY: 'isolated/vm2api',
        ROLLOUT_COMPONENT: 'vm2api',
        ROLLOUT_QUALIFICATION: path.join(root, 'qualification.json'),
        ROLLOUT_ENDPOINT: `https://127.0.0.1:${proxy.address().port}/internal/rollout/events`,
        ROLLOUT_NOTIFICATION_SECRET: secret,
        SSL_CERT_FILE: path.join(root, 'cert.pem'),
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    children.push(sender)
    let error = ''
    sender.stderr.on('data', (b) => {
      error += b
    })
    const receipt = path.join(root, 'rollout-notification.json')
    for (let i = 0; i < 200 && !fs.existsSync(receipt) && sender.exitCode === null; i++)
      await new Promise((r) => setTimeout(r, 20))
    check('verified_tls_notification', fs.existsSync(receipt))
    const queued = JSON.parse(fs.readFileSync(receipt))
    check('queued_is_not_success', queued.state === 'SUBMITTED' && sender.exitCode === null)
    // worker 的完成状态为受控故障边界；生产 worker 在真实退休后才写入。
    fs.writeFileSync(path.join(spool, queued.id, 'worker.json'), JSON.stringify({ state: 'completed' }))
    await once(sender, 'exit')
    check('sender_succeeded_after_completion', sender.exitCode === 0 && error === '')
    const final = JSON.parse(fs.readFileSync(receipt))
    check('deployed_receipt_source_bound', final.state === 'DEPLOYED' && final.commit === commit)
    fs.copyFileSync(receipt, path.join(out, 'notification.json'))
    result = 'PASS'
  } finally {
    for (const child of children)
      if (child.exitCode === null && child.signalCode === null) {
        child.kill('SIGTERM')
        await once(child, 'exit')
      }
    if (proxy) {
      proxy.closeAllConnections()
      await new Promise((r) => proxy.close(r))
    }
    fs.writeFileSync(
      path.join(out, 'summary.json'),
      JSON.stringify(
        {
          result,
          checks,
          boundary:
            '真实 CI 脚本、HTTPS 证书校验、反向代理、认证接收器与状态查询；worker 完成状态受控，无真实 GitHub 或生产发布',
          cleanup: children.every((c) => c.exitCode !== null || c.signalCode !== null),
        },
        null,
        2,
      ),
    )
    fs.rmSync(root, { recursive: true, force: true })
  }
})
