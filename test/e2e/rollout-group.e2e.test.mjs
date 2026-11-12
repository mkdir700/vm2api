import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createDatabase } from '../../src/lib/db/database.mjs'
import { ApiKeyStore } from '../../src/lib/admin/api-keys.mjs'
import { sign, digest } from '../../src/lib/rollout/protocol.mjs'
import { startGateway } from '../harness.mjs'

// 先验证实际 HTTP 控制面。模型执行器为现有隔离 mock，不代表原生运行时验收。
test('真实 vm2api 部署组只接收签名准入，持久化执行回执并拒绝重放', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-group-'))
  const out = path.resolve(process.env.ROLLOUT_GROUP_OUT || path.join('.tmp', path.basename(root)))
  fs.mkdirSync(out, { recursive: true })
  const secret = 'isolated-rollout-secret-at-least-32-bytes'
  const secretFile = path.join(root, 'secret')
  fs.writeFileSync(secretFile, secret, { mode: 0o600 })
  const authority = path.join(root, 'authority'),
    project = path.join(root, 'group')
  const db = createDatabase({ dataDir: authority })
  const keys = new ApiKeyStore({ db })
  const key = keys.create({ name: 'group-test' })
  db.close()
  const checks = []
  let gw,
    result = 'FAIL'
  const check = (name, ok) => {
    checks.push({ name, result: ok ? 'PASS' : 'FAIL' })
    assert.ok(ok, name)
  }
  try {
    gw = await startGateway({
      readyMs: 30000, // Linux amd64 模拟运行也必须在有限期限内就绪。
      project,
      env: {
        KIN_ROLLOUT_GROUP: 'old',
        KIN_ROLLOUT_INSTANCE: 'old-1',
        KIN_ROLLOUT_SECRET_FILE: secretFile,
        KIN_ROLLOUT_AUTHORITY_DB: path.join(authority, 'kin.db'),
        KIN_KERNEL_BIN: process.execPath,
        KIN_AUTO_SYNC_WRAP: '0',
      },
    })
    const raw = JSON.stringify({
      model: 'claude-sonnet-4-6',
      max_tokens: 64,
      messages: [{ role: 'user', content: 'ISOLATED_GROUP_TEST' }],
    })
    const url = gw.baseUrl + '/v1/messages'
    const headers = { 'content-type': 'application/json', authorization: `Bearer ${gw.apiKey}` }
    check('unsigned_rejected', (await fetch(url, { method: 'POST', headers, body: raw })).status === 401)
    check(
      'legacy_alias_rejected',
      (await fetch(gw.baseUrl + '/completions', { method: 'POST', headers, body: raw })).status === 404,
    )
    check(
      'identity_writes_redirected_to_authority',
      (await fetch(gw.baseUrl + '/api/panel/api-keys', { method: 'POST', headers, body: '{"name":"bypass"}' }))
        .status === 409,
    )
    const claim = {
      request_id: 'isolated-request-0001',
      group: 'old',
      instance: 'old-1',
      generation: 1,
      key_id: key.id,
      master: false,
      method: 'POST',
      path: '/v1/messages',
      body_sha256: digest(raw),
      expires: Date.now() + 60000,
    }
    const admitted = { ...headers, 'x-kin-rollout-admission': sign(secret, claim) }
    const response = await fetch(url, { method: 'POST', headers: admitted, body: raw })
    await response.text()
    check('signed_request_completed', response.status === 200)
    const report = await fetch(gw.baseUrl + '/_rollout/results/' + claim.request_id, {
      headers: { authorization: `Bearer ${secret}` },
    }).then((r) => r.json())
    check(
      'durable_completed_report',
      report.state === 'completed' && report.group === 'old' && report.instance === 'old-1',
    )
    check('successful_outcome_recorded', report.outcome === 'success')
    const helper = {
      ...claim,
      request_id: 'isolated-helper-0001',
      billable: false,
      method: 'GET',
      path: '/v1/models',
      body_sha256: digest(''),
    }
    check(
      'signed_model_discovery',
      (await fetch(gw.baseUrl + '/v1/models', { headers: { 'x-kin-rollout-admission': sign(secret, helper) } }))
        .status === 200,
    )
    check('no_content_in_report', !JSON.stringify(report).includes('ISOLATED_GROUP_TEST'))
    check('duplicate_not_executed', (await fetch(url, { method: 'POST', headers: admitted, body: raw })).status === 409)
    check(
      'body_tamper_rejected',
      (
        await fetch(url, {
          method: 'POST',
          headers: {
            ...headers,
            'x-kin-rollout-admission': sign(secret, { ...claim, request_id: 'isolated-request-0002' }),
          },
          body: raw + ' ',
        })
      ).status === 401,
    )
    check(
      'wrong_group_rejected',
      (
        await fetch(url, {
          method: 'POST',
          headers: { ...headers, 'x-kin-rollout-admission': sign(secret, { ...claim, group: 'new' }) },
          body: raw,
        })
      ).status === 401,
    )
    check('unauthorized_status', (await fetch(gw.baseUrl + '/_rollout/status')).status === 401)
    const status = await fetch(gw.baseUrl + '/_rollout/status', {
      headers: { authorization: `Bearer ${secret}` },
    }).then((r) => r.json())
    check(
      'uncertified_runtime_blocks_stop',
      status.schema === 1 && status.switch_ready === false && status.pending_tool_results === null,
    )
    result = 'PASS'
  } finally {
    await gw?.stop()
    if (gw?.child.exitCode === null) await new Promise((resolve) => gw.child.once('exit', resolve))
    fs.writeFileSync(
      path.join(out, 'summary.json'),
      JSON.stringify(
        {
          result,
          checks,
          boundary: '真实 vm2api HTTP、鉴权、SQLite 与隔离 mock 执行器；无真实 CLI 和上游',
          cleanup: !gw || gw.child.exitCode !== null || gw.child.signalCode !== null,
        },
        null,
        2,
      ),
    )
    fs.rmSync(root, { recursive: true, force: true })
  }
})
