import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import http from 'node:http'
import { once } from 'node:events'
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { writeWorkerCredentialFile } from '../../src/lib/oauth/oauth-credentials.mjs'
import { startGateway, api, REPO_ROOT, seedVm } from '../harness.mjs'

// Failure inventory: docs/operations/hermit-kernel-page-results-20261109.md.
// The real gateway and installer run in Linux. Only Docker and the guest kernel are simulated.
test('the shared install HTTP endpoint installs Hermit and leaves the slot stopped', {
  skip: process.platform !== 'linux',
  timeout: 60000,
}, async () => {
  const artifact = path.resolve(process.env.HERMIT_INSTALL_E2E_OUT || `.tmp/hermit-install-${Date.now()}`)
  fs.mkdirSync(artifact, { recursive: true })
  const project = fs.mkdtempSync('/tmp/ki-')
  const checks = []
  const check = (name, value) => {
    checks.push({ name, result: value ? 'PASS' : 'FAIL' })
    assert.ok(value, name)
  }
  const cli = Buffer.alloc(4096)
  Buffer.from([0x7f, 0x45, 0x4c, 0x46, 2, 1]).copy(cli)
  cli.writeUInt16LE(2, 16)
  cli.writeUInt16LE(62, 18)
  const upstream = http.createServer((_req, res) => res.end(cli))
  upstream.listen(0, '127.0.0.1')
  await once(upstream, 'listening')
  let gw
  try {
    const routing = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'src/config/routing.json')))
    routing.compatibility = { ...routing.compatibility, official_cc_passthrough: true }
    routing.failover = { ...routing.failover, eager_tool_streaming: false }
    fs.mkdirSync(path.join(project, 'config'), { recursive: true })
    fs.writeFileSync(path.join(project, 'config/routing.json'), JSON.stringify(routing))
    const vm = seedVm({ project })
    vm.dataplane = 'crag'
    vm.crag_kernel_version = 'v2'
    writeWorkerCredentialFile(path.join(project, 'vms/vm-sim-01/cli-home'), {
      type: 'apikey',
      api_key: 'sk-ant-api03-synthetic-install-test-key',
    })
    vm.claude.mode = 'apikey'
    vm.proxy = { id: 'px-local', scheme: 'local' }
    fs.writeFileSync(path.join(project, 'vms/vm-sim-01.json'), JSON.stringify(vm))
    const identity = path.join(project, 'vms/vm-sim-01/kvm/fingerprint/system')
    fs.mkdirSync(path.join(identity, 'etc'), { recursive: true })
    fs.mkdirSync(path.join(identity, 'hardware'), { recursive: true })
    fs.mkdirSync(path.join(identity, 'dmi/id'), { recursive: true })
    fs.writeFileSync(path.join(identity, 'etc/hostname'), 'ws-fixture')
    fs.writeFileSync(path.join(identity, 'etc/machine-id'), 'a'.repeat(32))
    fs.writeFileSync(path.join(identity, 'hardware/mac'), '02:00:00:00:00:01')
    fs.writeFileSync(
      path.join(project, 'docker-state.json'),
      JSON.stringify({
        'kin-sim-01': {
          Id: 'fixture-original',
          State: { Running: true },
          Config: { Labels: { 'kin.vm.id': vm.id, 'kin.vm.role': 'wrap' } },
          HostConfig: { RestartPolicy: { Name: 'unless-stopped' } },
        },
      }),
    )
    const bin = path.join(project, 'bin')
    fs.mkdirSync(bin)
    fs.copyFileSync(path.join(REPO_ROOT, 'test/fixtures/kernel-install-docker.py'), path.join(bin, 'docker'))
    fs.chmodSync(path.join(bin, 'docker'), 0o755)
    const fixture = path.join(project, 'fixture')
    fs.mkdirSync(fixture)
    execFileSync('python3', [
      path.join(REPO_ROOT, 'test/fixtures/hermit-page-package.py'),
      fixture,
      `http://127.0.0.1:${upstream.address().port}/cli`,
      createHash('sha256').update(cli).digest('hex'),
    ])
    gw = await startGateway({
      project,
      env: {
        KIN_CRS_MOCK: '0',
        KIN_KERNEL_TEST_ENDPOINTS: '1',
        KIN_HERMIT_UPSTREAM_URL: `http://127.0.0.1:${upstream.address().port}`,
        KIN_HERMIT_API_KEY: 'synthetic-test-key',
        KIN_DOCKER_BIN: path.join(bin, 'docker'),
        KIN_API_KERNEL_BIN: path.join(bin, 'docker'),
        KERNEL_INSTALL_FIXTURE: project,
        PATH: `${bin}:${process.env.PATH}`,
      },
    })
    const login = await api(gw, 'POST', '/api/panel/login', { body: { username: 'admin', password: 'testpass' } })
    const headers = { cookie: login.headers.get('set-cookie') }
    const target = { id: vm.id, kernel: 'hermit' }
    const install = (targets) => api(gw, 'POST', '/api/panel/kernels/install', { headers, body: { targets } })
    const missing = await install([{ id: vm.id, kernel: 'hermit' }])
    check(
      'hermit_requires_explicit_package',
      missing.status === 200 && missing.json.data.items[0].code === 'package_not_installed',
    )
    const receipt = JSON.parse(fs.readFileSync(path.join(fixture, 'release.json')))
    const upload = await fetch(gw.baseUrl + '/api/panel/kernel-packages', {
      method: 'POST',
      headers: {
        ...headers,
        'content-type': 'application/gzip',
        'x-kernel-sha256': receipt.archive.sha256,
        'x-kernel-bytes': String(receipt.archive.bytes),
        'x-kernel-manifest-sha256': receipt.manifest_sha256,
      },
      body: fs.readFileSync(path.join(fixture, 'package.tar.gz')),
    })
    check('package_uploaded', upload.status === 200)
    const before = fs.readFileSync(path.join(project, 'vms/vm-sim-01.json'))
    const bad = await install([{ ...target, manifest_sha256: '0'.repeat(64) }])
    check(
      'missing_package_rejected_before_stop',
      bad.status === 200 &&
        !bad.json.data.items[0].ok &&
        before.equals(fs.readFileSync(path.join(project, 'vms/vm-sim-01.json'))),
    )
    const containerBeforePreflight = fs.readFileSync(path.join(project, 'docker-state.json'))
    const commandFile = path.join(project, 'docker-commands.jsonl')
    const commandsBeforePreflight = fs.existsSync(commandFile) ? fs.readFileSync(commandFile, 'utf8').length : 0
    fs.writeFileSync(path.join(project, 'fail-image-preflight'), '1')
    const preflightFailure = await install([target])
    fs.unlinkSync(path.join(project, 'fail-image-preflight'))
    fs.writeFileSync(path.join(artifact, 'failed-image-preflight.json'), JSON.stringify(preflightFailure, null, 2))
    check('image_build_failure_is_specific', preflightFailure.json.data.items[0].code === 'hermit_guest_build_failed')
    check('image_failure_preserves_vm_record', before.equals(fs.readFileSync(path.join(project, 'vms/vm-sim-01.json'))))
    check(
      'image_failure_preserves_container',
      containerBeforePreflight.equals(fs.readFileSync(path.join(project, 'docker-state.json'))),
    )
    const preflightCommands = fs
      .readFileSync(commandFile, 'utf8')
      .slice(commandsBeforePreflight)
      .trim()
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line))
    check(
      'image_failure_sends_no_lifecycle_commands',
      preflightCommands.every((args) => !['stop', 'rm', 'rename', 'update'].includes(args[0])),
    )
    fs.writeFileSync(path.join(project, 'fail-run'), '1')
    const retiredFailure = await install([target])
    fs.unlinkSync(path.join(project, 'fail-run'))
    fs.writeFileSync(path.join(artifact, 'retired-failed-install.json'), JSON.stringify(retiredFailure, null, 2))
    const retiredRecovered = JSON.parse(fs.readFileSync(path.join(project, 'vms/vm-sim-01.json')))
    check('retired_failure_is_reported', retiredFailure.status === 200 && !retiredFailure.json.data.items[0].ok)
    check('retired_failure_releases_transition', retiredRecovered.kernel_transition.state === 'rolled_back')
    check(
      'retired_failure_keeps_old_selection',
      retiredRecovered.dataplane === 'crag' && retiredRecovered.crag_kernel_version === 'v2',
    )
    check('retired_failure_stops_slot', retiredRecovered.status === 'stopped' && retiredRecovered.runtime.stopped)
    check(
      'retired_failure_preserves_credentials',
      JSON.stringify(retiredRecovered.claude) === JSON.stringify(vm.claude),
    )
    const retiredContainers = JSON.parse(fs.readFileSync(path.join(project, 'docker-state.json')))
    check(
      'retired_failure_preserves_original_container',
      Object.keys(retiredContainers).length === 1 && retiredContainers['kin-sim-01'].Id === 'fixture-original',
    )
    check(
      'retired_failure_disables_restart',
      !retiredContainers['kin-sim-01'].State.Running &&
        retiredContainers['kin-sim-01'].HostConfig.RestartPolicy.Name === 'no',
    )
    for (let i = 0; i < 2; i++) {
      const result = await install([target])
      fs.writeFileSync(path.join(artifact, `install-${i}.json`), JSON.stringify(result, null, 2))
      check(
        `install_${i}_succeeds`,
        result.status === 200 && result.json.data.items[0].ok && result.json.data.items[0].stopped,
      )
      const record = JSON.parse(fs.readFileSync(path.join(project, 'vms/vm-sim-01.json')))
      check(`install_${i}_stopped`, record.status === 'stopped' && record.runtime.stopped && record.schedule_off)
      check(`install_${i}_binding`, record.dataplane === 'hermit' && record.kernel_package.version === '0.1.0-ui-e2e')
      check(`install_${i}_removes_retired_version`, !Object.hasOwn(record, 'crag_kernel_version'))
      check(`install_${i}_legacy_capacity`, record.kernel_package.native_session_pool !== true)
      check(`install_${i}_credentials`, JSON.stringify(record.claude) === JSON.stringify(vm.claude))
      check(
        `install_${i}_finalized`,
        record.kernel_transition.state === 'finalized' && record.kernel_installation.kernel === 'hermit',
      )
      const containers = JSON.parse(fs.readFileSync(path.join(project, 'docker-state.json')))
      check(
        `install_${i}_restart_disabled`,
        Object.values(containers).every((c) => !c.State.Running && c.HostConfig.RestartPolicy.Name === 'no'),
      )
      check(`install_${i}_backup_removed`, Object.keys(containers).length === 1)
    }
    const next = path.join(project, 'next-package')
    fs.mkdirSync(next)
    execFileSync('python3', [
      path.join(REPO_ROOT, 'test/fixtures/hermit-page-package.py'),
      next,
      `http://127.0.0.1:${upstream.address().port}/cli`,
      createHash('sha256').update(cli).digest('hex'),
      'production',
      'pool',
    ])
    const nextReceipt = JSON.parse(fs.readFileSync(path.join(next, 'release.json')))
    const oldDir = path.join(project, 'share/kernel-packages/versions/hermit/linux-amd64/0.1.0-ui-e2e')
    const recordBeforeUpload = fs.readFileSync(path.join(project, 'vms/vm-sim-01.json'))
    const replacement = await fetch(gw.baseUrl + '/api/panel/kernel-packages', {
      method: 'POST',
      headers: {
        ...headers,
        'content-type': 'application/gzip',
        'x-kernel-sha256': nextReceipt.archive.sha256,
        'x-kernel-bytes': String(nextReceipt.archive.bytes),
        'x-kernel-manifest-sha256': nextReceipt.manifest_sha256,
      },
      body: fs.readFileSync(path.join(next, 'package.tar.gz')),
    })
    check('new_package_preserves_deployed_files', replacement.status === 200 && fs.existsSync(oldDir))
    check(
      'upload_does_not_reinstall_vm',
      recordBeforeUpload.equals(fs.readFileSync(path.join(project, 'vms/vm-sim-01.json'))),
    )
    const stale = await install([{ ...target, manifest_sha256: receipt.manifest_sha256 }])
    check('stale_confirmation_rejected', !stale.json.data.items[0].ok && fs.existsSync(oldDir))
    const updated = await install([target])
    check(
      'reinstall_uses_current_package',
      updated.json.data.items[0].ok && updated.json.data.items[0].version === '0.2.0-ui-e2e',
    )
    check('reinstall_removes_unused_deployed_files', !fs.existsSync(oldDir))
    const poolRecord = JSON.parse(fs.readFileSync(path.join(project, 'vms/vm-sim-01.json')))
    check('pool_capability_persisted', poolRecord.kernel_package.native_session_pool === true)
    const poolView = await api(gw, 'GET', `/api/panel/vms/${vm.id}`, { headers })
    fs.writeFileSync(path.join(artifact, 'pool-view.json'), JSON.stringify(poolView.json, null, 2))
    const poolData = poolView.json.data?.vm || poolView.json.data || poolView.json
    check('new_package_exposes_twenty_seats', poolData.session_slots === 20 && poolData.seats_max === 20)
    const beforeFailure = JSON.parse(fs.readFileSync(path.join(project, 'vms/vm-sim-01.json')))
    const invalidBatch = await install([target, { id: 'vm-other', kernel: 'hermit' }])
    check(
      'invalid_batch_rejected_before_any_install',
      invalidBatch.status === 404 &&
        beforeFailure.kernel_transition.id ===
          JSON.parse(fs.readFileSync(path.join(project, 'vms/vm-sim-01.json'))).kernel_transition.id,
    )
    fs.writeFileSync(path.join(project, 'fail-run'), '1')
    const failed = await install([target])
    fs.writeFileSync(path.join(artifact, 'failed-install.json'), JSON.stringify(failed, null, 2))
    const recovered = JSON.parse(fs.readFileSync(path.join(project, 'vms/vm-sim-01.json')))
    check(
      'failed_candidate_is_reported',
      failed.status === 200 && !failed.json.data.items[0].ok && failed.json.data.items[0].stopped,
    )
    check(
      'failed_candidate_restores_binding',
      JSON.stringify(recovered.kernel_package) === JSON.stringify(beforeFailure.kernel_package),
    )
    check('failed_candidate_preserves_stopped_state', recovered.status === 'stopped' && recovered.runtime.stopped)
    check('failed_candidate_rolls_back', recovered.kernel_transition.state === 'rolled_back')
    check(
      'failed_candidate_preserves_credentials',
      JSON.stringify(recovered.claude) === JSON.stringify(beforeFailure.claude),
    )
    fs.unlinkSync(path.join(project, 'fail-run'))
    const native = await install([{ id: vm.id, kernel: 'cli-node' }])
    check(
      'hermit_to_native_uses_shared_installer',
      native.status === 200 && native.json.data.items[0].code === 'cli_node_package_missing',
    )
    const commands = fs.readFileSync(path.join(project, 'docker-commands.jsonl'), 'utf8')
    const created = commands
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line))
      .filter((args) => args[0] === 'run' && args.includes('--name'))
    check(
      'legacy_package_keeps_single_session_pid_budget',
      created.some((args) => args[args.indexOf('--pids-limit') + 1] === '256'),
    )
    check(
      'pool_package_scales_pid_budget',
      created.some((args) => args[args.indexOf('--pids-limit') + 1] === '5120'),
    )
    fs.writeFileSync(path.join(artifact, 'docker-commands.jsonl'), commands)
    check('hermit_mount_created', commands.includes('/opt/kin-kernel-packages'))
    fs.writeFileSync(
      path.join(artifact, 'summary.json'),
      JSON.stringify(
        {
          result: 'PASS',
          checks: checks.length,
          boundary: 'real gateway and package store; simulated Docker and guest kernel',
        },
        null,
        2,
      ),
    )
  } finally {
    if (fs.existsSync(path.join(project, 'docker-commands.jsonl')))
      fs.copyFileSync(path.join(project, 'docker-commands.jsonl'), path.join(artifact, 'docker-commands.jsonl'))
    if (gw) {
      fs.writeFileSync(path.join(artifact, 'server-stderr.txt'), gw.stderr())
      await gw.stop()
    }
    if (fs.existsSync(path.join(project, 'api-fixture.pid'))) {
      try {
        process.kill(Number(fs.readFileSync(path.join(project, 'api-fixture.pid'))), 'SIGTERM')
      } catch {}
    }
    upstream.close()
    fs.writeFileSync(path.join(artifact, 'checks.json'), JSON.stringify(checks, null, 2))
    fs.rmSync(project, { recursive: true, force: true })
  }
})
