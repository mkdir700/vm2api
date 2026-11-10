import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import http from 'node:http'
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { DatabaseSync } from 'node:sqlite'
import { startGateway, seedVm, api, REPO_ROOT } from '../harness.mjs'
import { writeWorkerCredentialFile } from '../../src/lib/oauth/oauth-credentials.mjs'

// Failure modes are recorded in .planning/2026-11-10-slot-email-sync/task_plan.md.
test('slot profile repairs missing email through import and usage HTTP routes', { timeout: 60000 }, async () => {
  const root = fs.mkdtempSync('/tmp/email-')
  const project = path.join(root, 'p')
  const out = path.resolve(process.env.SLOT_EMAIL_E2E_OUT || '.tmp/slot-email-sync')
  fs.mkdirSync(out, { recursive: true })
  const checks = []
  const calls = []
  const servers = []
  const slots = new Map()
  const check = (name, value) => {
    checks.push({ name, result: value ? 'PASS' : 'FAIL' })
    assert.ok(value, name)
  }
  const digest = (data) => createHash('sha256').update(data).digest('hex')
  const kernel = path.join(root, 'api-kernel')
  if (process.env.KIN_API_KERNEL_BIN) {
    fs.copyFileSync(process.env.KIN_API_KERNEL_BIN, kernel)
    fs.chmodSync(kernel, 0o700)
  } else {
    execFileSync('go', ['build', '-o', kernel, './cmd/kin-api-kernel'], { cwd: path.join(REPO_ROOT, 'api-kernel') })
  }
  const launcher = path.join(root, 'api-launch')
  const pidFile = path.join(root, 'api-pids')
  fs.writeFileSync(launcher, `#!/bin/sh\nprintf '%s\\n' "$$" >> '${pidFile}'\nexec '${kernel}' "$@"\n`, { mode: 0o700 })
  const docker = path.join(root, 'docker')
  fs.writeFileSync(
    docker,
    '#!/bin/sh\necho "Error response from daemon: No such object: email-fixture" >&2\nexit 1\n',
    {
      mode: 0o700,
    },
  )
  let gateway
  let completed = false
  let releaseProfile
  let profileStarted
  const profileWaiting = new Promise((resolve) => {
    profileStarted = resolve
  })
  try {
    for (const mode of [
      'missing',
      'bound',
      'known',
      'rejected',
      'empty',
      'malformed',
      'unsupported',
      'apikey',
      'inference',
      'import',
      'race',
    ]) {
      const id = `vm-${mode}`
      const vm = seedVm({ project, id })
      vm.dataplane = 'hermit'
      vm.claude = {
        mode: mode === 'apikey' ? 'apikey' : mode === 'inference' ? 'official-setup-token' : 'oauth',
        has_access: true,
        has_refresh: true,
        expires_at: 2000000000,
        scope: mode === 'inference' ? 'user:inference' : 'user:profile user:inference',
        _token_version: 1,
        account_tier: 'pro',
        ...(mode === 'bound' ? { account_uuid: 'bound-account' } : {}),
        ...(mode === 'known' ? { email: 'known@fixture.invalid' } : {}),
      }
      const run = vm.runtime.worker_run_dir
      fs.mkdirSync(run, { recursive: true })
      vm.runtime.worker_socket = path.join(run, 'kernel.sock')
      vm.runtime.kernel_socket = vm.runtime.worker_socket
      const token = `internal-email-${mode}`
      fs.writeFileSync(vm.runtime.worker_token_file, token)
      const file = path.join(project, 'vms', `${id}.json`)
      fs.writeFileSync(file, JSON.stringify(vm))
      const home = path.join(project, 'vms', id, 'cli-home')
      writeWorkerCredentialFile(home, {
        type: vm.claude.mode,
        access_token: `synthetic-email-access-${mode}`,
        refresh_token: `synthetic-email-refresh-${mode}`,
        expires_at: 2000000000,
        scope: vm.claude.scope,
      })
      const credential = path.join(home, '.claude/credentials.json')
      slots.set(mode, { vm, file, credential })
      const server = http.createServer(async (req, res) => {
        res.setHeader('content-type', 'application/json')
        if (req.headers['x-kin-internal-token'] !== token) {
          res.writeHead(401)
          return res.end('{}')
        }
        if (req.url === '/internal/health')
          return res.end(
            JSON.stringify({
              ok: true,
              healthy: true,
              runtime_flavor: 'hermit',
              helper_protocol: 'hermit-helper-1',
              helper_operations: mode === 'unsupported' ? ['usage'] : ['profile', 'usage'],
            }),
          )
        let text = ''
        for await (const chunk of req) text += chunk
        const input = JSON.parse(text || '{}')
        const operation = input.operation || 'messages'
        calls.push({ id, path: req.url, operation, authenticated: true })
        if (operation === 'profile') {
          if (mode === 'race') {
            profileStarted()
            await new Promise((resolve) => {
              releaseProfile = resolve
            })
          }
          if (mode === 'malformed') return res.end('{')
          return res.end(
            JSON.stringify({
              ok: mode !== 'rejected',
              status: mode === 'rejected' ? 403 : 200,
              body:
                mode === 'rejected'
                  ? { error: { code: 'profile_denied' } }
                  : mode === 'empty'
                    ? {}
                    : {
                        account: {
                          uuid: mode === 'bound' ? 'bound-account' : `account-${mode}`,
                          email: `${mode}@fixture.invalid`,
                        },
                        organization: { uuid: `org-${mode}` },
                      },
              headers: {},
            }),
          )
        }
        if (operation === 'usage')
          return res.end(
            JSON.stringify({
              ok: true,
              status: 200,
              body: {
                five_hour: { utilization: 3, resets_at: '2030-01-01T10:00:00Z' },
                seven_day: { utilization: 56, resets_at: '2030-01-07T10:00:00Z' },
                seven_day_sonnet: null,
                extra_usage: null,
              },
              headers: {},
            }),
          )
        res.writeHead(403)
        res.end(JSON.stringify({ error: { type: 'permission_error', message: 'fixture model unavailable' } }))
      })
      await new Promise((resolve) => server.listen(vm.runtime.kernel_socket, resolve))
      servers.push(server)
    }
    fs.writeFileSync(path.join(project, 'vms/active.json'), JSON.stringify({ active_vm: 'vm-missing' }))
    const routing = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'src/config/routing.json')))
    for (const name of ['kernel_watchdog', 'credential_refresh', 'usage_probe', 'health_probe', 'official_cc'])
      routing[name] = { ...routing[name], enabled: false }
    fs.mkdirSync(path.join(project, 'config'))
    fs.writeFileSync(path.join(project, 'config/routing.json'), JSON.stringify(routing))
    gateway = await startGateway({
      project,
      env: {
        KIN_CRS_MOCK: '0',
        KIN_DOCKER_BIN: docker,
        KIN_API_KERNEL_BIN: launcher,
        KIN_AUTO_SYNC_WRAP: '0',
        PATH: root + path.delimiter + process.env.PATH,
      },
    })
    const probe = (mode) => api(gateway, 'POST', `/api/panel/vms/vm-${mode}/probe`, { body: {} })
    const profiles = (mode) => calls.filter((call) => call.id === `vm-${mode}` && call.operation === 'profile').length
    const readVm = (mode) => JSON.parse(fs.readFileSync(slots.get(mode).file))
    const detail = (mode) => api(gateway, 'GET', `/api/panel/vms/vm-${mode}`)
    const db = new DatabaseSync(path.join(project, 'data/kin.db'))
    try {
      db.prepare('UPDATE accounts SET requests = 17, tokens_in = 23 WHERE vm_id = ?').run('vm-missing')
      for (const mode of ['missing', 'bound']) {
        const credentialHash = digest(fs.readFileSync(slots.get(mode).credential))
        const response = await probe(mode)
        check(`${mode}_usage_succeeds`, response.status === 200 && response.json.data?.ok === true)
        check(`${mode}_slot_email_persisted`, readVm(mode).claude.email === `${mode}@fixture.invalid`)
        const view = await detail(mode)
        check(`${mode}_detail_email`, view.json.data?.vm?.email === `${mode}@fixture.invalid`)
        check(
          `${mode}_account_email`,
          db.prepare('SELECT email FROM accounts WHERE vm_id = ?').get(`vm-${mode}`)?.email ===
            `${mode}@fixture.invalid`,
        )
        check(
          `${mode}_credential_bytes_preserved`,
          digest(fs.readFileSync(slots.get(mode).credential)) === credentialHash,
        )
        check(
          `${mode}_account_identity_preserved`,
          readVm(mode).claude.account_uuid === (mode === 'bound' ? 'bound-account' : undefined),
        )
        await probe(mode)
        check(`${mode}_known_email_avoids_repeat_profile`, profiles(mode) === 1)
      }
      const counters = db.prepare('SELECT requests, tokens_in FROM accounts WHERE vm_id = ?').get('vm-missing')
      check('account_counters_preserved', counters.requests === 17 && counters.tokens_in === 23)
      for (const mode of ['known', 'rejected', 'empty', 'malformed', 'unsupported', 'apikey', 'inference']) {
        const response = await probe(mode)
        check(
          `${mode}_profile_does_not_fail_usage`,
          response.status === 200 && (['apikey', 'inference'].includes(mode) || response.json.data?.ok === true),
        )
        check(
          `${mode}_email_preserved`,
          readVm(mode).claude.email === (mode === 'known' ? 'known@fixture.invalid' : undefined),
        )
        if (['known', 'unsupported', 'apikey', 'inference'].includes(mode))
          check(`${mode}_no_profile_io`, profiles(mode) === 0)
      }
      for (const mode of ['import', 'rejected', 'empty', 'malformed', 'unsupported']) {
        const imported = await api(gateway, 'PUT', `/api/panel/vms/vm-${mode}/oauth/credential`, {
          body: {
            accounts: [
              {
                platform: 'anthropic',
                type: 'oauth',
                credentials: {
                  access_token: 'synthetic-email-imported-access',
                  refresh_token: 'synthetic-email-imported-refresh',
                  expires_at: 2000000000,
                  scope: 'user:profile user:inference',
                },
              },
            ],
          },
        })
        const expectedEmail = mode === 'import' ? 'import@fixture.invalid' : null
        check(`${mode}_credential_import_succeeds`, imported.status === 200)
        check(`${mode}_credential_import_email`, (readVm(mode).claude.email || null) === expectedEmail)
        check(
          `${mode}_credential_import_panel_email`,
          ((await detail(mode)).json.data?.vm?.email || null) === expectedEmail,
        )
        check(
          `${mode}_credential_import_account_email`,
          (db.prepare('SELECT email FROM accounts WHERE vm_id = ?').get(`vm-${mode}`)?.email || null) === expectedEmail,
        )
      }
      const raced = probe('race')
      let timeout
      try {
        await Promise.race([
          profileWaiting,
          new Promise((_, reject) => {
            timeout = setTimeout(() => reject(Error('profile_not_started')), 2000)
          }),
        ])
      } finally {
        clearTimeout(timeout)
      }
      const replacement = readVm('race')
      replacement.claude._token_version = 2
      replacement.claude.email = 'replacement@fixture.invalid'
      fs.writeFileSync(slots.get('race').file, JSON.stringify(replacement))
      releaseProfile()
      await raced
      check(
        'stale_profile_does_not_overwrite_replacement',
        readVm('race').claude.email === 'replacement@fixture.invalid',
      )
      check(
        'helper_uses_authenticated_slot_transport',
        calls.every((call) => call.authenticated),
      )
      completed = true
    } finally {
      db.close()
    }
  } finally {
    releaseProfile?.()
    if (gateway) await gateway.stop()
    for (const server of servers) {
      server.closeAllConnections()
      await new Promise((resolve) => server.close(resolve))
    }
    if (fs.existsSync(pidFile))
      for (const pid of fs.readFileSync(pidFile, 'utf8').trim().split('\n')) {
        try {
          process.kill(Number(pid), 'SIGTERM')
        } catch {}
      }
    fs.rmSync(root, { recursive: true, force: true })
    const sources = [
      'test/e2e/slot-email-sync.e2e.test.mjs',
      'src/lib/oauth/slot-email.mjs',
      'src/lib/oauth/import-commit.mjs',
      'src/lib/admin/panel-api.mjs',
    ]
    fs.writeFileSync(
      path.join(out, 'receipt.json'),
      JSON.stringify(
        {
          result: completed ? 'PASS' : 'FAIL',
          checks,
          calls,
          command: 'node --test test/e2e/slot-email-sync.e2e.test.mjs',
          source_files: Object.fromEntries(
            sources.filter((file) => fs.existsSync(file)).map((file) => [file, digest(fs.readFileSync(file))]),
          ),
          fixture_removed: !fs.existsSync(root),
          real_provider: 'NOT RUN',
          production_deployment: 'NOT RUN',
        },
        null,
        2,
      ),
    )
  }
})
