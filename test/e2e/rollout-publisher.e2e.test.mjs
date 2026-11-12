import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import http from 'node:http'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { startHermitReleaseOrigin } from '../fixtures/hermit-release-origin.mjs'

// 失败方式已固定于实施契约。实际网关与发布器进程；Docker 命令为隔离可重复故障夹具。
test('发布事务：排空超时保留旧组，恢复后退休；回滚只切新会话', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-publisher-'))
  const out = path.resolve(process.env.ROLLOUT_PUBLISHER_OUT || path.join('.tmp', path.basename(root)))
  fs.mkdirSync(out, { recursive: true })
  const secret = 'isolated-publisher-control-secret-32-bytes',
    secretFile = path.join(root, 'secret')
  fs.writeFileSync(secretFile, secret, { mode: 0o600 })
  const checks = [],
    servers = [],
    children = [],
    runtime = { old: { pending: 1 }, new: { pending: 0 } },
    specs = []
  const check = (name, ok) => {
    checks.push({ name, result: ok ? 'PASS' : 'FAIL' })
    assert.ok(ok, name)
  }
  let result = 'FAIL',
    base,
    origin
  try {
    for (const id of ['old', 'new']) {
      const server = http.createServer(async (req, res) => {
        const identitiesFile = path.join(root, 'backend-identities.json')
        const identities = fs.existsSync(identitiesFile) ? JSON.parse(fs.readFileSync(identitiesFile)) : {}
        const identity = identities[id]
        if (req.url.startsWith('/_rollout/gateway/')) {
          const front = identities['front-' + id] || { instance: 'gateway-' + id, draining: false }
          if (req.method === 'POST') {
            let raw = ''
            for await (const b of req) raw += b
            if (JSON.parse(raw).instance !== front.instance) {
              res.statusCode = 409
              return res.end('{}')
            }
            front.draining = true
            identities['front-' + id] = front
            fs.writeFileSync(identitiesFile, JSON.stringify(identities))
          }
          return res.end(
            JSON.stringify({
              schema: 1,
              authority_schema: 1,
              instance: front.instance,
              ready: !front.draining,
              draining: front.draining,
              drained: front.draining,
              active_requests: 0,
            }),
          )
        }
        res.end(
          JSON.stringify({
            schema: 1,
            inventory: { accounts: [id] },
            group: identity?.group || id,
            instance: identity?.instance || id,
            ready: true,
            active_requests: 0,
            queued_requests: 0,
            pending_tool_results: runtime[id].pending,
            helper_active: false,
            recovering: false,
            switch_ready: runtime[id].pending === 0,
            session_restore_protocol: 'anthropic-full-history-v1',
          }),
        )
      })
      await new Promise((r) => server.listen(0, '127.0.0.1', r))
      servers.push(server)
      specs.push({
        id,
        url: `http://127.0.0.1:${server.address().port}`,
        instance: id,
        artifact: 'sha256:' + 'a'.repeat(64),
        resources: { root: path.join(root, id), accounts: [id], containers: ['isolated-' + id] },
      })
    }
    const gateway = spawn(process.execPath, ['src/session-gateway.mjs'], {
      env: {
        ...process.env,
        PORT: '0',
        HOST: '127.0.0.1',
        KIN_ROLLOUT_STATE: path.join(root, 'authority'),
        KIN_ROLLOUT_SECRET_FILE: secretFile,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    children.push(gateway)
    base = await new Promise((resolve, reject) => {
      gateway.stdout.on('data', (b) => {
        try {
          resolve(JSON.parse(String(b)).url)
        } catch {}
      })
      gateway.once('exit', reject)
    })
    const admin = async (route, body) => {
      const res = await fetch(base + '/_rollout/' + route, {
        method: body ? 'POST' : 'GET',
        headers: { authorization: `Bearer ${secret}`, 'content-type': 'application/json' },
        ...(body ? { body: JSON.stringify(body) } : {}),
      })
      return { status: res.status, body: await res.json() }
    }
    for (const spec of specs) await admin('groups', spec)
    await admin('policy', { expected_generation: 0, target: 'old' })
    const docker = path.join(root, 'isolated-docker')
    fs.writeFileSync(
      docker,
      `#!/usr/bin/env python3\nimport json,sys\nfrom pathlib import Path\np=Path(${JSON.stringify(path.join(root, 'docker-calls.jsonl'))})\nwith p.open('a') as f:f.write(json.dumps(sys.argv[1:])+'\\n')\nif sys.argv[1:3]==['image','inspect']: print(json.dumps([{'Id':'sha256:'+'a'*64,'Config':{'Labels':{'org.opencontainers.image.revision':'b'*40}}}]))\nelif sys.argv[1]=='inspect': print(json.dumps([{'Id':'isolated-id-'+n,'Name':'/'+n,'State':{'Running':False}} for n in sys.argv[2:]]))\n`,
      { mode: 0o700 },
    )
    fs.appendFileSync(
      docker,
      `\nif sys.argv[1]=='compose' and 'up' in sys.argv:\n env={}\n for line in Path(sys.argv[sys.argv.index('--env-file')+1]).read_text().splitlines():\n  k,v=line.split('=',1);env[k]=v.strip('"')\n identities=Path(${JSON.stringify(path.join(root, 'backend-identities.json'))})\n previous=json.loads(identities.read_text()) if identities.exists() else {}\n if 'ROLLOUT_GATEWAY_CONTAINER' in env:previous['front-new']={'instance':env['ROLLOUT_GATEWAY_INSTANCE'],'draining':False}\n else:previous[Path(env['ROLLOUT_ROOT']).name]={'group':env['ROLLOUT_GROUP'],'instance':env['ROLLOUT_INSTANCE']}\n identities.write_text(json.dumps(previous))\n`,
    )
    const config = {
      schema: 1,
      state_dir: path.join(root, 'publisher'),
      lock_file: path.join(root, 'production.lock'),
      secret_file: secretFile,
      gateway_url: base,
      docker_bin: docker,
      drain_timeout_seconds: 0.1,
      ready_timeout_seconds: 3,
      profiles: specs.map((s) => ({
        ...s,
        project: 'isolated-' + s.id,
        service_env: path.join(root, 'service.env'),
        authority_dir: path.join(root, 'authority'),
        port: Number(new URL(s.url).port),
      })),
    }
    fs.writeFileSync(config.profiles[0].service_env, 'KIN_ADMIN_PASSWORD=ISOLATED\n', { mode: 0o600 })
    const configFile = path.join(root, 'publisher.json')
    fs.writeFileSync(configFile, JSON.stringify(config), { mode: 0o600 })
    const release = {
      schema: 1,
      id: 'isolated-release',
      component: 'vm2api',
      commit: 'b'.repeat(40),
      image: 'ghcr.io/isolated/vm2api@sha256:' + 'a'.repeat(64),
      candidate: 'new',
      qualification: {
        result: 'PASS',
        commit: 'b'.repeat(40),
        image: 'ghcr.io/isolated/vm2api@sha256:' + 'a'.repeat(64),
        migration: 'compatible',
      },
    }
    const releaseFile = path.join(root, 'release.json')
    fs.writeFileSync(releaseFile, JSON.stringify(release))
    async function publish(command) {
      const proc = spawn('python3', ['deploy/rollout.py', command, '--config', configFile, '--release', releaseFile], {
        stdio: ['ignore', 'pipe', 'pipe'],
      })
      children.push(proc)
      let stdout = '',
        stderr = ''
      proc.stdout.on('data', (b) => {
        stdout += b
      })
      proc.stderr.on('data', (b) => {
        stderr += b
      })
      await once(proc, 'exit')
      fs.writeFileSync(path.join(out, `${command}-${children.length}.log`), stdout + stderr)
      return proc.exitCode
    }
    check('timeout_preserves_old', (await publish('apply')) === 2)
    const first = await admin('snapshot')
    check('new_policy_active_while_draining', first.body.policy.target === 'new')
    let calls = fs.readFileSync(path.join(root, 'docker-calls.jsonl'), 'utf8')
    check('old_not_stopped_early', !calls.split('\n').some((l) => l && JSON.parse(l)[0] === 'stop'))
    runtime.old.pending = 0
    check('resume_completes', (await publish('apply')) === 0)
    calls = fs.readFileSync(path.join(root, 'docker-calls.jsonl'), 'utf8')
    check('only_confirmed_old_stopped', calls.includes('"stop", "--time", "30", "isolated-old"'))
    check('duplicate_job_idempotent', (await publish('apply')) === 0)
    check('rollback_completes', (await publish('rollback')) === 0)
    check('rollback_policy_old', (await admin('snapshot')).body.policy.target === 'old')
    const task = JSON.parse(fs.readFileSync(path.join(root, 'publisher', release.id, 'task.json')))
    check('durable_release_receipt', task.state === 'rolled_back' && task.release.commit === release.commit)
    fs.copyFileSync(path.join(root, 'publisher', release.id, 'task.json'), path.join(out, 'task.json'))
    const spool = path.join(root, 'spool'),
      jobId = 'vm2api-v2.3.4-' + 'b'.repeat(12)
    fs.mkdirSync(path.join(spool, jobId), { recursive: true })
    fs.writeFileSync(
      path.join(spool, jobId, 'event.json'),
      JSON.stringify({
        schema: 1,
        component: 'vm2api',
        repository: 'isolated/vm2api',
        tag: 'v2.3.4',
        commit: release.commit,
        image: release.image,
        qualification: { ...release.qualification, evidence_sha256: 'c'.repeat(64) },
      }),
    )
    const agentConfig = path.join(root, 'agent.json')
    config.gateway_profiles = specs.map((s) => ({
      id: 'gateway-' + s.id,
      instance: 'gateway-' + s.id,
      container: 'isolated-gateway-' + s.id,
      admin_url: s.url,
      admin_port: Number(new URL(s.url).port),
    }))
    config.gateway_active = 'gateway-old'
    config.gateway_env = config.profiles[0].service_env
    config.gateway_authority_dir = path.join(root, 'authority')
    fs.writeFileSync(configFile, JSON.stringify(config), { mode: 0o600 })
    origin = await startHermitReleaseOrigin(path.join(root, 'package-origin'))
    const metadata = await fetch(origin.url + '/v1/releases/latest').then((r) => r.json())
    fs.mkdirSync(path.join(root, 'new', 'vms'), { recursive: true })
    fs.writeFileSync(
      agentConfig,
      JSON.stringify({
        spool,
        publisher_config: configFile,
        initial_components: {
          vm2api_image: release.image,
          hermit: { version: metadata.version, commit: metadata.commit, manifest_sha256: metadata.manifest_sha256 },
        },
        sources: { vm2api: { repository: 'isolated/vm2api', image: 'ghcr.io/isolated/vm2api' } },
      }),
      { mode: 0o600 },
    )
    const worker = spawn('python3', ['deploy/rollout-agent.py', 'work', '--config', agentConfig], {
      env: {
        ...process.env,
        PATH: path.dirname(process.execPath) + path.delimiter + process.env.PATH,
        KIN_KERNEL_TEST_ENDPOINTS: '1',
        KIN_HERMIT_RELEASES_URL: origin.url,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    children.push(worker)
    let workerLog = ''
    worker.stderr.on('data', (b) => {
      workerLog += b
    })
    await once(worker, 'exit')
    fs.copyFileSync(path.join(spool, jobId, 'worker.json'), path.join(out, 'worker.json'))
    fs.writeFileSync(path.join(out, 'worker.log'), workerLog)
    check(
      'queue_worker_executes_publisher',
      worker.exitCode === 0 &&
        JSON.parse(fs.readFileSync(path.join(spool, jobId, 'worker.json'))).state === 'completed',
    )
    check(
      'worker_selected_new_group_identity',
      (await admin('snapshot')).body.policy.target === 'group-' + 'b'.repeat(16),
    )
    check(
      'release_combination_persisted',
      JSON.parse(fs.readFileSync(path.join(spool, 'active-components.json'))).hermit.version === metadata.version,
    )
    check(
      'gateway_version_retired_with_backend',
      JSON.parse(fs.readFileSync(path.join(root, 'publisher/gateway-active.json'))).id === 'gateway-new',
    )
    result = 'PASS'
  } finally {
    await origin?.close()
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
        {
          result,
          checks,
          boundary: '真实网关、SQLite、发布器和 HTTP；Docker 命令为隔离夹具，非真实容器发布',
          cleanup: children.every((c) => c.exitCode !== null || c.signalCode !== null),
        },
        null,
        2,
      ),
    )
    fs.rmSync(root, { recursive: true, force: true })
  }
})
