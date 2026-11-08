import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { writeWorkerCredentialFile } from '../../src/lib/oauth/oauth-credentials.mjs'
import { startGateway, seedVm, api, REPO_ROOT } from '../harness.mjs'

// 失败方式先记录于选定计划。完整 HTTP 服务和进程调用收据验证 helper 边界。
test('Hermit rejects legacy helpers while a pending package preserves the active helper', {
  timeout: 60000,
}, async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hermit-helper-'))
  const out = path.resolve(process.env.HERMIT_E2E_OUT || `.tmp/hermit-helper-${Date.now()}`)
  fs.mkdirSync(out, { recursive: true })
  const kernel = path.join(root, 'kin-api-kernel')
  if (process.env.KIN_API_KERNEL_BIN) {
    fs.copyFileSync(process.env.KIN_API_KERNEL_BIN, kernel)
    fs.chmodSync(kernel, 0o700)
  } else
    execFileSync('go', ['build', '-o', kernel, './cmd/kin-api-kernel'], { cwd: path.join(REPO_ROOT, 'api-kernel') })
  const kernelPids = path.join(root, 'kernel-pids')
  const launcher = path.join(root, 'api-launch')
  const quote = (value) => "'" + value.replaceAll("'", "'\"'\"'") + "'"
  fs.writeFileSync(launcher, `#!/bin/sh\nprintf '%s\\n' "$$" >> ${quote(kernelPids)}\nexec ${quote(kernel)} "$@"\n`, {
    mode: 0o700,
  })
  const stopKernels = () => {
    if (fs.existsSync(kernelPids))
      for (const pid of fs.readFileSync(kernelPids, 'utf8').trim().split('\n')) {
        try {
          process.kill(Number(pid), 'SIGTERM')
        } catch {}
      }
    if (fs.existsSync(kernelPids)) fs.writeFileSync(kernelPids, '')
  }
  const callsFile = path.join(root, 'docker-calls.jsonl')
  const docker = path.join(root, 'docker')
  fs.writeFileSync(
    docker,
    `#!/usr/bin/env python3
import sys,json
with open(${JSON.stringify(callsFile)},'a') as f:f.write(json.dumps(sys.argv[1:])+'\\n')
if 'oauth' not in sys.argv:raise SystemExit(1)
op=sys.argv[sys.argv.index('oauth')+1]
body={'data':[{'id':'legacy-fixture-model'}]} if op=='models' else {'refreshed':True,'has_access':True,'has_refresh':True}
print(json.dumps({'ok':True,'status':200,'body':body,'headers':{}}))
`,
    { mode: 0o700 },
  )
  const checks = []
  const check = (name, value) => {
    checks.push({ name, result: value ? 'PASS' : 'FAIL' })
    assert.ok(value, name)
  }
  let gw
  let completed = false
  const responses = []
  const helperCalls = () =>
    fs.existsSync(callsFile)
      ? fs
          .readFileSync(callsFile, 'utf8')
          .trim()
          .split('\n')
          .filter(Boolean)
          .map(JSON.parse)
          .filter((argv) => argv.includes('oauth'))
      : []
  try {
    const project = path.join(root, 'p')
    const vm = seedVm({ project })
    vm.dataplane = 'hermit'
    vm.claude.mode = 'oauth'
    vm.claude.has_access = true
    vm.claude.has_refresh = true
    delete vm.claude.access_token
    delete vm.claude.refresh_token
    const vmFile = path.join(project, 'vms/vm-sim-01.json')
    fs.writeFileSync(vmFile, JSON.stringify(vm))
    const credentialFile = path.join(project, 'vms/vm-sim-01/cli-home/.claude/credentials.json')
    fs.writeFileSync(
      credentialFile,
      JSON.stringify({
        type: 'oauth',
        claudeAiOauth: {
          accessToken: 'synthetic-helper-access',
          refreshToken: 'synthetic-helper-refresh',
          expiresAt: 1,
        },
      }),
      { mode: 0o444 },
    )
    gw = await startGateway({
      project,
      timeoutMs: 6000,
      env: { KIN_CRS_MOCK: '0', KIN_DOCKER_BIN: docker, KIN_API_KERNEL_BIN: launcher },
    })
    const login = await api(gw, 'POST', '/api/panel/login', { body: { username: 'admin', password: 'testpass' } })
    check('admin_login', login.status === 200)
    const credentialBefore = createHash('sha256').update(fs.readFileSync(credentialFile)).digest('hex')
    const cookie = login.headers.get('set-cookie')
    const status = await api(gw, 'GET', '/admin/vm/oauth')
    check('status_does_not_claim_refresh_owner', status.json.refresh_owner === null)
    for (const endpoint of [
      '/api/panel/model-policy/sync-worker',
      '/admin/vm/oauth/refresh',
      '/api/panel/vms/vm-sim-01/oauth/refresh',
    ]) {
      const response = await api(gw, 'POST', endpoint, { headers: { cookie }, body: { force: true } })
      responses.push({ endpoint, status: response.status, body: response.json })
      check(
        `unsupported_${endpoint}`,
        response.status === 501 && response.json?.error?.code === 'native_operation_unsupported',
      )
      if (endpoint.includes('refresh'))
        check(`no_refresh_owner_${endpoint}`, (response.json.data || response.json).refresh_owner === null)
    }
    check('no_legacy_helper_for_active_hermit', helperCalls().length === 0)
    check(
      'unsupported_responses_do_not_expose_secrets_or_paths',
      !/synthetic-helper-(access|refresh)|worker\.json|kin-worker/.test(JSON.stringify(responses)),
    )
    check(
      'credential_unchanged',
      credentialBefore === createHash('sha256').update(fs.readFileSync(credentialFile)).digest('hex'),
    )
    const after = JSON.parse(fs.readFileSync(vmFile))
    check('unsupported_does_not_revoke_account', after.status === 'running' && !after.claude.refresh_error)
    await gw.stop()
    gw = null
    stopKernels()
    delete vm.dataplane
    vm.pending_kernel_package = { runtime: 'hermit', target: 'linux-amd64', version: 'pending-only' }
    fs.writeFileSync(vmFile, JSON.stringify(vm))
    gw = await startGateway({
      project,
      timeoutMs: 6000,
      env: { KIN_CRS_MOCK: '0', KIN_DOCKER_BIN: docker, KIN_API_KERNEL_BIN: launcher },
    })
    const loginAgain = await api(gw, 'POST', '/api/panel/login', { body: { username: 'admin', password: 'testpass' } })
    const legacy = await api(gw, 'POST', '/api/panel/model-policy/sync-worker', {
      headers: { cookie: loginAgain.headers.get('set-cookie') },
      body: {},
    })
    responses.push({ endpoint: 'pending-package-model-sync', status: legacy.status, body: legacy.json })
    check(
      'pending_package_preserves_active_helper',
      legacy.status === 200 && helperCalls().some((argv) => argv.includes('models')),
    )
    check(
      'legacy_helper_uses_original_contract',
      helperCalls().every(
        (argv) => argv.includes('/usr/local/bin/kin-worker') && argv.includes('/run/kin/worker.json'),
      ),
    )
    await gw.stop()
    gw = null
    stopKernels()
    vm.dataplane = 'hermit'
    vm.claude.mode = 'apikey'
    vm.claude.has_refresh = false
    fs.writeFileSync(vmFile, JSON.stringify(vm))
    writeWorkerCredentialFile(path.dirname(path.dirname(credentialFile)), {
      type: 'apikey',
      api_key: 'sk-ant-api03-helper-synthetic-key',
    })
    const callsBeforeCount = helperCalls().length
    gw = await startGateway({
      project,
      timeoutMs: 6000,
      env: { KIN_CRS_MOCK: '0', KIN_DOCKER_BIN: docker, KIN_API_KERNEL_BIN: launcher },
    })
    const count = await api(gw, 'POST', '/v1/messages/count_tokens', {
      body: { model: 'claude-sonnet-4-6', messages: [{ role: 'user', content: 'count synthetic text' }] },
    })
    responses.push({ endpoint: 'apikey-count-tokens', status: count.status, body: count.json })
    check('count_tokens_remains_unexposed', count.status === 404)
    check('count_tokens_starts_no_legacy_helper', helperCalls().length === callsBeforeCount)
    const keyLogin = await api(gw, 'POST', '/api/panel/login', { body: { username: 'admin', password: 'testpass' } })
    const keyRefresh = await api(gw, 'POST', '/api/panel/vms/vm-sim-01/oauth/refresh', {
      headers: { cookie: keyLogin.headers.get('set-cookie') },
      body: {},
    })
    check(
      'api_key_refresh_remains_rejected',
      keyRefresh.status === 400 && keyRefresh.json.error?.code === 'credential_mode_unsupported',
    )
    check('api_key_refresh_starts_no_helper', helperCalls().length === callsBeforeCount)
    completed = true
  } finally {
    if (gw) {
      fs.writeFileSync(path.join(out, 'server-stderr.txt'), gw.stderr())
      await gw.stop()
    }
    fs.writeFileSync(path.join(out, 'helper-calls.json'), JSON.stringify(helperCalls(), null, 2))
    fs.writeFileSync(path.join(out, 'responses.json'), JSON.stringify(responses, null, 2))
    fs.writeFileSync(path.join(out, 'checks.json'), JSON.stringify(checks, null, 2))
    stopKernels()
    fs.rmSync(root, { recursive: true, force: true })
    fs.writeFileSync(
      path.join(out, 'summary.json'),
      JSON.stringify(
        {
          result: completed ? 'PASS' : 'FAIL',
          checks: checks.length,
          fixture_removed: !fs.existsSync(root),
          real_provider: 'NOT RUN',
          docker_boundary: 'recording process fixture',
        },
        null,
        2,
      ),
    )
  }
})
