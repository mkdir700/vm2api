import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import http from 'node:http'
import { spawn } from 'node:child_process'
import { once } from 'node:events'

// 实施前失败方式：入口切换失败、旧流未结束、错误实例证明、重复发布和回滚丢原入口。
test('应用发布器保留未排空版本并可恢复切流与回滚', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-app-rollout-'))
  const out = path.resolve(process.env.ROLLOUT_APPLICATION_OUT || path.join('.tmp', path.basename(root)))
  fs.mkdirSync(out, { recursive: true })
  const secret = 'isolated-application-publisher-secret-32-bytes',
    servers = [],
    children = [],
    profiles = [],
    states = { old: { active: 1, accepting: true }, new: { active: 0, accepting: true } },
    checks = []
  const check = (name, ok) => {
    checks.push({ name, result: ok ? 'PASS' : 'FAIL' })
    assert.ok(ok, name)
  }
  let result = 'FAIL'
  try {
    fs.writeFileSync(path.join(root, 'secret'), secret, { mode: 0o600 })
    fs.writeFileSync(path.join(root, 'service.env'), 'AUTO_SETUP=true\n', { mode: 0o600 })
    for (const id of ['old', 'new']) {
      const server = http.createServer((req, res) => {
        if (req.url === '/health') return res.end('{"status":"ok"}')
        if (req.url === '/_rollout/drain') states[id].accepting = false
        if (req.url === '/_rollout/resume') states[id].accepting = true
        res.end(
          JSON.stringify({
            schema: 1,
            instance: id,
            active_requests: states[id].active,
            pending_usage_records: 0,
            accepting: states[id].accepting,
            drained: !states[id].accepting && states[id].active === 0,
          }),
        )
      })
      await new Promise((r) => server.listen(0, '127.0.0.1', r))
      servers.push(server)
      profiles.push({
        id,
        instance: id,
        url: `http://127.0.0.1:${server.address().port}`,
        port: server.address().port,
        project: 'isolated-app-' + id,
        service_env: path.join(root, 'service.env'),
        network: 'isolated-network',
        resources: { root: path.join(root, id), containers: ['isolated-app-' + id] },
      })
    }
    const include = path.join(root, 'upstream.conf')
    fs.writeFileSync(include, `upstream truerouter_app { server 127.0.0.1:${profiles[0].port}; }\n`)
    const docker = path.join(root, 'isolated-docker')
    fs.writeFileSync(
      docker,
      '#!/usr/bin/env python3\nimport sys,json\nif sys.argv[1:3]==["image","inspect"]:print(json.dumps([{ "Config":{"Labels":{"org.opencontainers.image.revision":"' +
        'b'.repeat(40) +
        '"}}}]))\nelif sys.argv[1]=="inspect":print(json.dumps([{"Id":"id-"+n,"Name":"/"+n} for n in sys.argv[2:]]))\n',
      { mode: 0o700 },
    )
    const config = {
      schema: 1,
      state_dir: path.join(root, 'state'),
      lock_file: path.join(root, 'production.lock'),
      secret_file: path.join(root, 'secret'),
      gateway_url: 'http://127.0.0.1:1',
      docker_bin: docker,
      profiles,
      application_active: 'old',
      upstream_include: include,
      proxy_container: 'isolated-openresty',
      drain_timeout_seconds: 0.1,
    }
    const image = 'ghcr.io/isolated/sub2api@sha256:' + 'a'.repeat(64),
      release = {
        schema: 1,
        id: 'application-test',
        component: 'sub2api',
        commit: 'b'.repeat(40),
        image,
        candidate: 'new',
        qualification: { result: 'PASS', commit: 'b'.repeat(40), image, migration: 'compatible' },
      }
    const cfg = path.join(root, 'config.json'),
      rel = path.join(root, 'release.json')
    fs.writeFileSync(cfg, JSON.stringify(config), { mode: 0o600 })
    fs.writeFileSync(rel, JSON.stringify(release))
    async function run(command) {
      const child = spawn('python3', ['deploy/rollout.py', command, '--config', cfg, '--release', rel], {
        stdio: ['ignore', 'pipe', 'pipe'],
      })
      children.push(child)
      let log = ''
      child.stdout.on('data', (b) => {
        log += b
      })
      child.stderr.on('data', (b) => {
        log += b
      })
      await once(child, 'exit')
      fs.writeFileSync(path.join(out, command + '-' + children.length + '.log'), log)
      return child.exitCode
    }
    check('old_busy_preserved', (await run('apply')) === 2)
    check('new_upstream_selected', fs.readFileSync(include, 'utf8').includes(':' + profiles[1].port))
    check('old_admission_stopped', states.old.accepting === false)
    states.old.active = 0
    check('resume_completed', (await run('apply')) === 0)
    check('rollback_completed', (await run('rollback')) === 0)
    check('old_upstream_restored', fs.readFileSync(include, 'utf8').includes(':' + profiles[0].port))
    check('old_admission_resumed', states.old.accepting === true)
    result = 'PASS'
  } finally {
    for (const child of children)
      if (child.exitCode === null && child.signalCode === null) {
        child.kill('SIGTERM')
        await once(child, 'exit')
      }
    for (const server of servers) {
      server.closeAllConnections()
      await new Promise((r) => server.close(r))
    }
    fs.writeFileSync(
      path.join(out, 'summary.json'),
      JSON.stringify(
        { result, checks, boundary: '真实发布器、HTTP 与配置文件；应用与 OpenResty/Docker 为受控夹具，非生产切流' },
        null,
        2,
      ),
    )
    fs.rmSync(root, { recursive: true, force: true })
  }
})
