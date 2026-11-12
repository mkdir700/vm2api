import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { startGateway, seedVm, api } from '../harness.mjs'

// Failure inventory: generic code/message, automatic replay/account hopping,
// retryable rejection, or loss of the explicit error in usage logs and panel.
test('completed duplicate keeps its explicit error through HTTP, scheduler and panel', async () => {
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'completed-request-duplicate-'))
  const checks = []
  try {
    for (const stream of [false, true]) {
      const project = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-duplicate-'))
      for (const id of ['vm-sim-01', 'vm-sim-02']) {
        const vm = seedVm({ project, id })
        vm.claude.account_uuid = 'account-' + id
        fs.writeFileSync(path.join(project, 'vms', id + '.json'), JSON.stringify(vm))
      }
      const gw = await startGateway({
        project,
        scenario: 'completed_request_duplicate',
        env: { KIN_KERNEL_BIN: process.execPath, KIN_REQUEST_LOG_MODE: 'normal' },
      })
      try {
        const response = await api(gw, 'POST', '/v1/messages', {
          body: {
            model: 'claude-haiku-4-5-20251001',
            max_tokens: 16,
            stream,
            messages: [{ role: 'user', content: 'SYNTHETIC_COMPLETED_DUPLICATE' }],
          },
        })
        const logs = await api(gw, 'GET', '/api/panel/usage-logs?limit=20')
        fs.writeFileSync(
          path.join(out, String(stream) + '-response.json'),
          JSON.stringify({ status: response.status, body: response.json }, null, 2),
        )
        fs.writeFileSync(path.join(out, String(stream) + '-logs.json'), JSON.stringify(logs.json, null, 2))
        assert.equal(response.status, 400)
        assert.equal(response.json.error.code, 'completed_request_duplicate')
        assert.match(response.json.error.message, /请求与已完成请求重复/)
        assert.match(response.json.error.message, /完整历史/)
        assert.equal(response.json.error.details.retryable, false)
        assert.equal(logs.status, 200)
        const row = logs.json.data.logs.find((row) => row.requestId === response.headers.get('x-request-id'))
        assert.ok(row)
        assert.equal(row.errorCode, 'completed_request_duplicate')
        assert.match(row.errorMessage, /请求与已完成请求重复/)
        assert.equal(row.errorClass, 'request')
        assert.equal(row.attemptCount, 1)
        checks.push({
          stream,
          result: 'PASS',
          status: response.status,
          code: row.errorCode,
          attempts: row.attemptCount,
        })
      } finally {
        await gw.stop()
      }
    }
    fs.writeFileSync(path.join(out, 'summary.json'), JSON.stringify({ result: 'PASS', checks }, null, 2))
  } catch (error) {
    fs.writeFileSync(
      path.join(out, 'summary.json'),
      JSON.stringify({ result: 'FAIL', checks, error: error.message }, null, 2),
    )
    throw error
  } finally {
    console.log('completed duplicate evidence: ' + out)
  }
})
