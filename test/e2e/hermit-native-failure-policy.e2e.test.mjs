import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { startGateway, seedVm, api } from '../harness.mjs'

// Failure inventory: a native worker error must remain platform-owned and
// preserve its 502; automatic account switching can rebuild the session and
// replay an uncertain request. Exercise HTTP -> scheduler -> SQLite -> panel.
test('native session failures stop without account hopping or provider blame', async () => {
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'hermit-native-failure-policy-'))
  const checks = []
  try {
    for (const [code, status] of [
      ['native_preparation_failed', 502],
      ['native_control_unavailable', 502],
      ['native_generation_failed', 502],
      ['native_operation_unsupported', 501],
    ]) {
      const project = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-native-failure-'))
      for (const id of ['vm-sim-01', 'vm-sim-02']) {
        const vm = seedVm({ project, id })
        vm.claude.account_uuid = 'account-' + id
        vm.claude.email = id + '@kin.test'
        fs.writeFileSync(path.join(project, 'vms', id + '.json'), JSON.stringify(vm, null, 2))
      }
      const gw = await startGateway({
        project,
        scenario: code,
        env: { KIN_KERNEL_BIN: process.execPath, KIN_REQUEST_LOG_MODE: 'normal' },
      })
      try {
        const response = await api(gw, 'POST', '/v1/messages', {
          body: {
            model: 'claude-haiku-4-5-20251001',
            max_tokens: 16,
            messages: [{ role: 'user', content: 'SYNTHETIC_NATIVE_FAILURE_' + code }],
          },
        })
        fs.writeFileSync(
          path.join(out, code + '-response.json'),
          JSON.stringify({ status: response.status, body: response.json }, null, 2),
        )
        const logs = await api(gw, 'GET', '/api/panel/usage-logs?limit=20')
        assert.equal(logs.status, 200)
        fs.writeFileSync(path.join(out, code + '-logs.json'), JSON.stringify(logs.json, null, 2))
        assert.equal(response.status, status, 'preserve the native platform error')
        assert.equal(response.json.error.code, code)
        const row = logs.json.data.logs.find((row) => row.requestId === response.headers.get('x-request-id'))
        assert.ok(row)
        assert.equal(row.statusCode, status)
        assert.equal(row.errorCode, code)
        assert.equal(row.errorOwner, 'platform')
        assert.equal(row.attemptCount, 1, 'do not switch units or repeat the native request')
        checks.push({ code, result: 'PASS', status: row.statusCode, owner: row.errorOwner, attempts: row.attemptCount })
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
    console.log('native failure policy evidence: ' + out)
  }
})
