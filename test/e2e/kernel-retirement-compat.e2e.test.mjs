import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { startGateway, api, seedVm, REPO_ROOT } from '../harness.mjs'

// Failure inventory and compatibility contract: docs/operations/crag-compatibility.md.
const out = path.resolve(process.env.KERNEL_COMPAT_E2E_OUT || '.tmp/kernel-compat')
fs.mkdirSync(out, { recursive: true })

async function scenario(name, { inference = {}, vm = {}, lifecycle = false } = {}, run) {
  const project = fs.mkdtempSync(path.join(os.tmpdir(), 'kc-'))
  const routingFile = path.join(project, 'config/routing.json')
  const vmFile = path.join(project, 'vms/vm-sim-01.json')
  const routing = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'src/config/routing.json')))
  routing.inference = { ...routing.inference, ...inference }
  fs.mkdirSync(path.dirname(routingFile), { recursive: true })
  fs.writeFileSync(routingFile, JSON.stringify(routing))
  fs.writeFileSync(vmFile, JSON.stringify(Object.assign(seedVm({ project }), vm)))
  const checks = []
  let gw
  try {
    const env = { KIN_KERNEL_BIN: process.execPath }
    if (lifecycle) {
      const bin = path.join(project, 'bin')
      fs.mkdirSync(bin)
      const docker = path.join(bin, 'docker')
      fs.copyFileSync(path.join(REPO_ROOT, 'test/fixtures/kernel-install-docker.py'), docker)
      fs.chmodSync(docker, 0o755)
      Object.assign(env, {
        KIN_DOCKER_BIN: docker,
        KERNEL_INSTALL_FIXTURE: project,
        PATH: `${bin}:${process.env.PATH}`,
      })
    }
    gw = await startGateway({ project, env })
    const login = await api(gw, 'POST', '/api/panel/login', { body: { username: 'admin', password: 'testpass' } })
    const headers = { cookie: login.headers.get('set-cookie') }
    const call = (method, url, body) => api(gw, method, url, { headers, body })
    const check = (label, ok) => {
      checks.push({ label, ok: Boolean(ok) })
      assert.ok(ok, label)
    }
    await run({ project, vmFile, routingFile, call, check })
  } finally {
    fs.writeFileSync(path.join(out, `${name}.json`), JSON.stringify({ name, checks }, null, 2))
    if (gw) await gw.stop()
    fs.rmSync(project, { recursive: true, force: true })
  }
}

for (const inference of [
  { crag_kernel_version: 'v2' },
  { dataplane: 'crag', crag_kernel_version: 'v2' },
  { dataplane: 'OFFICIAL_CLI', crag_kernel_version: 'v2' },
]) {
  const suffix =
    inference.dataplane === 'OFFICIAL_CLI'
      ? 'historical-alias'
      : inference.dataplane
        ? 'retired-global'
        : 'stale-version'
  test(`unrelated settings round trips accept historical ${suffix} without migrating slots`, async () => {
    await scenario(suffix, { inference }, async ({ call, check, routingFile, vmFile }) => {
      const loaded = await call('GET', '/api/panel/routing')
      const body = loaded.json.data
      delete body.redaction_runtime
      body.tiers.default.limit_5h = 0.93
      const before = JSON.parse(fs.readFileSync(vmFile))
      for (let i = 0; i < 2; i++) {
        const save = await call('PUT', '/api/panel/routing', body)
        check(`round_trip_${i}_succeeds`, save.status === 200)
        const stored = JSON.parse(fs.readFileSync(routingFile))
        check(`round_trip_${i}_persists_quota`, stored.quota.safety_ratio === 0.93)
        check(`round_trip_${i}_persists_tier`, stored.tiers.default.limit_5h === 0.93)
        if (inference.dataplane)
          check(
            `round_trip_${i}_preserves_retired_selection`,
            stored.inference.dataplane === (inference.dataplane === 'OFFICIAL_CLI' ? 'official-cli' : 'crag'),
          )
        check(
          `round_trip_${i}_preserves_slot_runtime`,
          JSON.stringify(JSON.parse(fs.readFileSync(vmFile)).runtime) === JSON.stringify(before.runtime),
        )
      }
      const retired = await call('PUT', '/api/panel/routing', { inference: { crag_kernel_version: 'legacy' } })
      check('new_retired_version_is_rejected', retired.status === 400)
    })
  })
}

test('global configuration cannot reclassify an inherited retired runtime', async () => {
  await scenario('routing-guard', { inference: { dataplane: 'crag' } }, async ({ call, check, routingFile }) => {
    const snapshot = fs.readFileSync(routingFile)
    for (const dataplane of ['wrap', 'cc']) {
      const save = await call('PUT', '/api/panel/routing', { inference: { dataplane } })
      check(
        `reject_${dataplane}_without_install`,
        save.status === 409 && save.json.error?.code === 'kernel_install_required',
      )
      check(`preserve_config_after_${dataplane}`, fs.readFileSync(routingFile).equals(snapshot))
    }
  })
})

test('global defaults can change after every retired slot has an explicit supported selection', async () => {
  await scenario(
    'migrated-global',
    { inference: { dataplane: 'crag' }, vm: { dataplane: 'wrap' } },
    async ({ call, check, routingFile }) => {
      const save = await call('PUT', '/api/panel/routing', { inference: { dataplane: 'wrap' } })
      check('global_default_can_be_updated', save.status === 200)
      check('new_default_persisted', JSON.parse(fs.readFileSync(routingFile)).inference.dataplane === 'wrap')
    },
  )
})

for (const all of [false, true]) {
  test(`legacy dataplane changes reject retired ${all ? 'inherited' : 'explicit'} slots before mutation`, async () => {
    await scenario(
      `dataplane-${all}`,
      {
        inference: all ? { dataplane: 'crag' } : {},
        vm: all ? {} : { dataplane: 'crag', crag_kernel_version: 'v2' },
      },
      async ({ project, call, check, vmFile, routingFile }) => {
        const sibling = seedVm({ project, id: 'vm-sim-02' })
        sibling.dataplane = 'wrap'
        const siblingFile = path.join(project, 'vms/vm-sim-02.json')
        fs.writeFileSync(siblingFile, JSON.stringify(sibling))
        const before = [vmFile, siblingFile, routingFile].map((f) => fs.readFileSync(f))
        for (const restart of [false, true]) {
          const changed = await call('POST', '/api/panel/dataplane', {
            dataplane: 'wrap',
            ...(all ? { all: true } : { ids: ['vm-sim-02', 'vm-sim-01'] }),
            restart,
          })
          check(
            `reject_restart_${restart}`,
            changed.status === 409 && changed.json.error?.code === 'kernel_install_required',
          )
          check(
            `preserve_entire_batch_${restart}`,
            [vmFile, siblingFile, routingFile].every((f, i) => fs.readFileSync(f).equals(before[i])),
          )
        }
      },
    )
  })
}

test('retired kernels expose an unsupported-kernel schedule cause', async () => {
  await scenario('schedule-cause', { vm: { dataplane: 'crag' } }, async ({ call, check, vmFile }) => {
    const read = await call('GET', '/api/panel/vms/vm-sim-01')
    const vm = read.json.data.vm || read.json.data
    check(
      'reports_unschedulable_kernel',
      vm.schedule_state === 'unschedulable' && vm.unschedulable_reason === 'kernel_unsupported',
    )
    check('does_not_blame_operator', vm.availability.reason !== 'disabled' && vm.schedule_off === false)
    check('does_not_write_an_operator_switch', JSON.parse(fs.readFileSync(vmFile)).schedulable !== false)
  })
})

for (const foreign of [false, true]) {
  test(`retired rollback ${foreign ? 'rejects a foreign backup' : 'stops the old container and permits a new install'}`, {
    skip: process.platform !== 'linux',
  }, async () => {
    await scenario(
      `rollback-${foreign}`,
      {
        lifecycle: true,
        vm: {
          dataplane: 'wrap',
          proxy: { id: 'px-local', scheme: 'local' },
          kernel_transition: {
            id: 'kernel-recovery',
            state: 'rollback_failed',
            previous: { dataplane: 'crag', crag_kernel_version: 'v2' },
            target: { dataplane: 'wrap' },
            previous_status: 'running',
            previous_running: true,
            restart_policy: 'unless-stopped',
            container: 'kin-sim-01',
            backup: 'kin-sim-01-rollback',
            previous_container_id: 'fixture-old',
            candidate_container_id: 'fixture-candidate',
          },
        },
      },
      async ({ project, call, check, vmFile }) => {
        const stateFile = path.join(project, 'docker-state.json')
        const container = (id, running) => ({
          Id: id,
          State: { Running: running },
          Config: { Labels: { 'kin.vm.id': 'vm-sim-01' } },
          HostConfig: { RestartPolicy: { Name: 'unless-stopped' } },
        })
        fs.writeFileSync(
          stateFile,
          JSON.stringify({
            'kin-sim-01': container('fixture-candidate', true),
            'kin-sim-01-rollback': container(foreign ? 'foreign-container' : 'fixture-old', false),
          }),
        )
        const credential = JSON.parse(fs.readFileSync(vmFile)).claude
        const rollback = await call('POST', '/api/panel/vms/vm-sim-01/kernel-transition', { action: 'rollback' })
        if (foreign) {
          check(
            'foreign_backup_is_rejected',
            rollback.status === 409 && rollback.json.data?.transition?.recovery_code === 'kernel_backup_mismatch',
          )
          const commands = fs
            .readFileSync(path.join(project, 'docker-commands.jsonl'), 'utf8')
            .trim()
            .split('\n')
            .map(JSON.parse)
          check(
            'foreign_failure_has_no_container_mutations',
            commands.every((args) => !['stop', 'rm', 'rename', 'update', 'start'].includes(args[0])),
          )
          return
        }
        check('rollback_succeeds', rollback.status === 200 && rollback.json.data?.requires_install === true)
        const restored = JSON.parse(fs.readFileSync(vmFile))
        check('terminal_state_allows_retry', restored.kernel_transition.state === 'rolled_back')
        check('retired_selection_preserved', restored.dataplane === 'crag' && restored.crag_kernel_version === 'v2')
        check('slot_is_stopped', restored.status === 'stopped' && restored.runtime.stopped === true)
        check('credentials_preserved', JSON.stringify(restored.claude) === JSON.stringify(credential))
        const state = JSON.parse(fs.readFileSync(stateFile))
        check(
          'old_container_preserved_with_restart_disabled',
          Object.keys(state).length === 1 &&
            state['kin-sim-01'].Id === 'fixture-old' &&
            !state['kin-sim-01'].State.Running &&
            state['kin-sim-01'].HostConfig.RestartPolicy.Name === 'no',
        )
        const commands = fs
          .readFileSync(path.join(project, 'docker-commands.jsonl'), 'utf8')
          .trim()
          .split('\n')
          .map(JSON.parse)
        check(
          'retired_container_is_never_started',
          commands.every((args) => args[0] !== 'start'),
        )
        const retry = await call('POST', '/api/panel/kernels/install', {
          targets: [{ id: 'vm-sim-01', kernel: 'hermit' }],
        })
        check(
          'new_install_reaches_package_preflight',
          retry.status === 200 && retry.json.data?.items[0]?.code === 'package_not_installed',
        )
      },
    )
  })
}
