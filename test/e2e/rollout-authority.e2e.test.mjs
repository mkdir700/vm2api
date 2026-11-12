import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { spawn, execFileSync } from 'node:child_process'
import { once } from 'node:events'
import { createDatabase } from '../../src/lib/db/database.mjs'
import { ApiKeyStore } from '../../src/lib/admin/api-keys.mjs'

// 失败方式：源仍运行、复制账号凭据、覆盖已迁移账本、密钥失效、目标事务不完整。
test('冻结身份迁移后原 API Key 通过真实网关鉴权', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-authority-'))
  const out = path.resolve(process.env.ROLLOUT_AUTHORITY_OUT || path.join('.tmp', path.basename(root)))
  fs.mkdirSync(out, { recursive: true })
  const source = path.join(root, 'old'),
    target = path.join(root, 'authority'),
    secretFile = path.join(root, 'secret')
  const db = createDatabase({ dataDir: source }),
    keys = new ApiKeyStore({ db, hashSecret: 'isolated-import-hash' })
  const key = keys.create({ name: 'preserved', max_concurrency: 2 })
  db.prepare('INSERT OR REPLACE INTO settings(key,value) VALUES(?,?)').run('PRIVATE_PROVIDER_SENTINEL', 'DO_NOT_IMPORT')
  db.close()
  const docker = path.join(root, 'docker')
  fs.writeFileSync(
    docker,
    '#!/usr/bin/env python3\nimport json,sys\nif sys.argv[1]=="inspect":print(json.dumps([{"Id":"isolated","State":{"Running":False},"Mounts":[{"Source":' +
      JSON.stringify(source) +
      ',"Destination":"/opt/vm2api/data"}]}]))\n',
    { mode: 0o700 },
  )
  fs.writeFileSync(secretFile, 'isolated-authority-secret-at-least-32-bytes', { mode: 0o600 })
  const checks = [],
    children = []
  const check = (name, ok) => {
    checks.push({ name, result: ok ? 'PASS' : 'FAIL' })
    assert.ok(ok, name)
  }
  let result = 'FAIL'
  try {
    const args = [
      'deploy/rollout-authority.mjs',
      '--source',
      path.join(source, 'kin.db'),
      '--target',
      target,
      '--stopped-container',
      'isolated',
      '--receipt',
      path.join(out, 'import.json'),
      '--apply',
    ]
    execFileSync(process.execPath, args, { env: { ...process.env, KIN_DOCKER_BIN: docker } })
    const imported = createDatabase({ dataDir: target })
    check(
      'identity_preserved',
      new ApiKeyStore({ db: imported, hashSecret: 'isolated-import-hash' }).authenticate(key.key).ok,
    )
    check(
      'provider_settings_not_copied',
      !imported.prepare('SELECT value FROM settings WHERE key=?').get('PRIVATE_PROVIDER_SENTINEL'),
    )
    imported.close()
    let rejected = false
    try {
      execFileSync(process.execPath, args, { env: { ...process.env, KIN_DOCKER_BIN: docker }, stdio: 'pipe' })
    } catch {
      rejected = true
    }
    check('existing_authority_not_overwritten', rejected)
    const child = spawn(process.execPath, ['src/session-gateway.mjs'], {
      env: {
        ...process.env,
        PORT: '0',
        HOST: '127.0.0.1',
        KIN_ROLLOUT_STATE: target,
        KIN_ROLLOUT_SECRET_FILE: secretFile,
        KIN_API_KEY_HASH_SECRET: 'isolated-import-hash',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    children.push(child)
    let err = ''
    child.stderr.on('data', (b) => {
      err += b
    })
    const base = await new Promise((resolve, reject) => {
      child.stdout.on('data', (b) => {
        try {
          resolve(JSON.parse(String(b)).url)
        } catch {}
      })
      child.once('exit', () => reject(new Error(err)))
    })
    const response = await fetch(base + '/v1/messages', {
      method: 'POST',
      headers: { authorization: 'Bearer ' + key.key, 'content-type': 'application/json' },
      body: JSON.stringify({ messages: [{ role: 'user', content: 'ISOLATED' }] }),
    })
    check(
      'preserved_key_reaches_admission',
      response.status === 503 && (await response.json()).error.code === 'no_accepting_group',
    )
    result = 'PASS'
  } finally {
    for (const child of children)
      if (child.exitCode === null && child.signalCode === null) {
        child.kill('SIGTERM')
        await once(child, 'exit')
      }
    fs.writeFileSync(
      path.join(out, 'summary.json'),
      JSON.stringify(
        { result, checks, boundary: '真实 SQLite 迁移与 HTTP 网关；Docker 停止证明为隔离夹具，未迁移生产状态' },
        null,
        2,
      ),
    )
    fs.rmSync(root, { recursive: true, force: true })
  }
})
