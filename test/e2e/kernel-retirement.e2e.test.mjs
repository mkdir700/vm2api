import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { startGateway, api } from '../harness.mjs'

// Failure inventory: docs/operations/crag-removal.md.
test('the HTTP control plane rejects retired kernels and keeps supported kernels available', async () => {
  const out = path.resolve(process.env.KERNEL_RETIREMENT_E2E_OUT || '.tmp/kernel-retirement')
  fs.mkdirSync(out, { recursive: true })
  const checks = []
  const responses = []
  const check = (name, condition) => {
    checks.push({ name, ok: Boolean(condition) })
    assert.ok(condition, name)
  }
  const gw = await startGateway({ env: { KIN_KERNEL_BIN: process.execPath } })
  try {
    const login = await api(gw, 'POST', '/api/panel/login', { body: { username: 'admin', password: 'testpass' } })
    const headers = { cookie: login.headers.get('set-cookie') }
    const call = async (method, url, body) => {
      const result = await api(gw, method, url, { headers, body })
      responses.push({ method, url, body, status: result.status, response: result.json })
      return result
    }
    const catalog = await call('GET', '/api/panel/kernels')
    check(
      'only_default_release_product',
      catalog.status === 200 &&
        catalog.json.data.kernels.length === 1 &&
        catalog.json.data.kernels[0].id === 'cli-node',
    )
    check('no_license_inventory', !('licenses' in catalog.json.data))
    const hermit = await call('GET', '/api/panel/kernel-packages')
    check('hermit_package_endpoint_preserved', hermit.status === 200)
    for (const dataplane of ['crag', 'official-cli', 'official-cc', 'claude-code', 'unexpected-kernel']) {
      const patch = await call('PATCH', '/api/panel/vms/vm-sim-01', { dataplane })
      check(`reject_slot_${dataplane}`, patch.status === 400)
      const global = await call('POST', '/api/panel/dataplane', { dataplane })
      check(`reject_global_${dataplane}`, global.status === 400)
    }
    const version = await call('PATCH', '/api/panel/vms/vm-sim-01', { crag_kernel_version: 'v2' })
    check('reject_retired_version_field', version.status === 400)
    const pull = await call('POST', '/api/panel/kernels/pull', { kernel: 'crag' })
    check('reject_retired_download', pull.status === 400)
    const install = await call('POST', '/api/panel/kernels/install', { targets: [{ id: 'vm-sim-01', kernel: 'crag' }] })
    check('reject_retired_install', install.status === 400)
    const license = await call('GET', '/api/panel/vms/vm-sim-01/crag-license')
    check('license_endpoint_removed', license.status === 404)
    const exported = await call('GET', '/api/panel/vms/vm-sim-01/package')
    check('supported_vm_export_available', exported.status === 200)
    const packageDoc = exported.json.data
    const retiredPackage = structuredClone(packageDoc)
    retiredPackage.vm.dataplane = 'crag'
    const imported = await call('PUT', '/api/panel/vms/vm-sim-01/package', retiredPackage)
    check('retired_package_rejected', imported.status === 400)
    const versionPackage = structuredClone(packageDoc)
    versionPackage.vm.crag_kernel_version = 'v2'
    const importedVersion = await call('PUT', '/api/panel/vms/vm-sim-01/package', versionPackage)
    check('retired_package_version_rejected', importedVersion.status === 400)
    const stored = JSON.parse(fs.readFileSync(path.join(gw.project, 'vms/vm-sim-01.json')))
    check('rejected_requests_preserve_selection', !stored.dataplane && !stored.crag_kernel_version)
    const result = await api(gw, 'POST', '/v1/messages', {
      body: {
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 16,
        messages: [{ role: 'user', content: 'SYNTHETIC_SUPPORTED_KERNEL' }],
      },
    })
    responses.push({ url: '/v1/messages', status: result.status, response: result.json })
    check('default_request_still_works', result.status === 200)
  } finally {
    fs.writeFileSync(path.join(out, 'checks.json'), JSON.stringify(checks, null, 2))
    fs.writeFileSync(path.join(out, 'responses.json'), JSON.stringify(responses, null, 2))
    fs.writeFileSync(
      path.join(out, 'api-summary.json'),
      JSON.stringify(
        { mode: 'isolated-http-mock', ok: checks.length > 0 && checks.every((c) => c.ok), checks: checks.length },
        null,
        2,
      ),
    )
    await gw.stop()
  }
})

test('persisted retired selections stay blocked and explicit supported siblings remain usable', async () => {
  const { seedVm, REPO_ROOT } = await import('../harness.mjs')
  const os = await import('node:os')
  const out = path.resolve(process.env.KERNEL_RETIREMENT_E2E_OUT || '.tmp/kernel-retirement')
  fs.mkdirSync(out, { recursive: true })
  const checks = []
  for (const inherited of [false, true]) {
    const project = fs.mkdtempSync(path.join(os.tmpdir(), 'kernel-retired-config-'))
    const record = seedVm({ project })
    if (!inherited) record.dataplane = 'crag'
    record.crag_kernel_version = 'v2'
    fs.writeFileSync(path.join(project, 'vms/vm-sim-01.json'), JSON.stringify(record))
    const config = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'src/config/routing.json')))
    if (inherited) config.inference = { ...config.inference, dataplane: 'crag' }
    fs.mkdirSync(path.join(project, 'config'), { recursive: true })
    fs.writeFileSync(path.join(project, 'config/routing.json'), JSON.stringify(config))
    const sibling = seedVm({ project, id: 'vm-sim-02' })
    sibling.dataplane = 'wrap'
    sibling.claude.account_uuid = 'supported-account'
    fs.writeFileSync(path.join(project, 'vms/vm-sim-02.json'), JSON.stringify(sibling))
    const gw = await startGateway({ project, env: { KIN_KERNEL_BIN: process.execPath } })
    const check = (name, condition) => {
      checks.push({ inherited, name, ok: Boolean(condition) })
      assert.ok(condition, `${inherited ? 'global' : 'slot'}: ${name}`)
    }
    try {
      const response = await api(gw, 'POST', '/v1/messages', {
        headers: { 'x-kin-vm': 'vm-sim-01' },
        body: {
          model: 'claude-haiku-4-5-20251001',
          max_tokens: 16,
          messages: [{ role: 'user', content: 'SYNTHETIC_RETIRED_KERNEL' }],
        },
      })
      check('retired_request_is_not_executed', response.status !== 200)
      const login = await api(gw, 'POST', '/api/panel/login', { body: { username: 'admin', password: 'testpass' } })
      const headers = { cookie: login.headers.get('set-cookie') }
      const detail = await api(gw, 'GET', '/api/panel/vms/vm-sim-01', { headers })
      const data = detail.json.data?.vm || detail.json.data
      check('retired_selection_remains_visible', data.resolved_dataplane === 'crag')
      const stored = JSON.parse(fs.readFileSync(path.join(project, 'vms/vm-sim-01.json')))
      check('no_automatic_kernel_migration', inherited ? !stored.dataplane : stored.dataplane === 'crag')
      const bypass = await api(gw, 'PATCH', '/api/panel/vms/vm-sim-01', { headers, body: { dataplane: 'wrap' } })
      check('retired_container_requires_installation', bypass.status >= 400)
      const afterBypass = JSON.parse(fs.readFileSync(path.join(project, 'vms/vm-sim-01.json')))
      check(
        'policy_patch_does_not_reuse_retired_container',
        inherited ? !afterBypass.dataplane : afterBypass.dataplane === 'crag',
      )
      const supported = await api(gw, 'POST', '/v1/messages', {
        body: {
          model: 'claude-haiku-4-5-20251001',
          max_tokens: 16,
          messages: [{ role: 'user', content: 'SYNTHETIC_SUPPORTED_SIBLING' }],
        },
      })
      fs.writeFileSync(
        path.join(out, `sibling-${inherited}.json`),
        JSON.stringify({ status: supported.status, response: supported.json }, null, 2),
      )
      check('supported_sibling_still_works', supported.status === 200)
    } finally {
      await gw.stop()
      fs.rmSync(project, { recursive: true, force: true })
      fs.writeFileSync(path.join(out, 'persisted-config-checks.json'), JSON.stringify(checks, null, 2))
    }
  }
})

test('HTTP release updates no longer require retired payload assets', async () => {
  const http = await import('node:http')
  const { once } = await import('node:events')
  const os = await import('node:os')
  const { seedVm } = await import('../harness.mjs')
  const project = fs.mkdtempSync(path.join(os.tmpdir(), 'kernel-release-http-'))
  const out = path.resolve(process.env.KERNEL_RETIREMENT_E2E_OUT || '.tmp/kernel-retirement')
  fs.mkdirSync(out, { recursive: true })
  seedVm({ project })
  const elf = Buffer.alloc(4096)
  elf.set([0x7f, 0x45, 0x4c, 0x46, 2, 1, 1])
  elf.writeUInt16LE(3, 16)
  elf.writeUInt16LE(62, 18)
  const names = ['kin-kernel', 'cli-node']
  const factory = path.join(project, 'share/wrap-cli')
  fs.mkdirSync(factory, { recursive: true })
  fs.writeFileSync(path.join(factory, 'cc-node'), elf, { mode: 0o755 })
  const requested = []
  const origin = http.createServer((req, res) => {
    requested.push(req.url)
    if (req.url.includes('/releases/latest')) {
      res.setHeader('content-type', 'application/json')
      res.end(
        JSON.stringify({
          tag_name: 'v1.2.3',
          assets: names.map((name, index) => ({
            name,
            size: elf.length,
            url: `https://api.github.com/repos/dofastted/vm2api/releases/assets/${index + 1}`,
          })),
        }),
      )
    } else if (/\/releases\/assets\/[123]$/.test(req.url)) res.end(elf)
    else res.writeHead(404).end()
  })
  origin.listen(0, '127.0.0.1')
  await once(origin, 'listening')
  const preload = path.join(project, 'release-transport.mjs')
  fs.writeFileSync(
    preload,
    `const fetchOriginal = globalThis.fetch;
    globalThis.fetch = (input, options) => {
      const url = new URL(String(input));
      return fetchOriginal(url.hostname === 'api.github.com'
        ? 'http://127.0.0.1:${origin.address().port}' + url.pathname : input, options);
    };`,
  )
  let gw
  const checks = []
  try {
    gw = await startGateway({ project, env: { NODE_OPTIONS: `--import=${preload}`, KIN_KERNEL_BIN: '' } })
    const login = await api(gw, 'POST', '/api/panel/login', { body: { username: 'admin', password: 'testpass' } })
    const headers = { cookie: login.headers.get('set-cookie') }
    const check = (name, condition) => {
      checks.push({ name, ok: Boolean(condition) })
      assert.ok(condition, name)
    }
    const pull = await api(gw, 'POST', '/api/panel/kernels/pull', { headers, body: { kernel: 'cli-node' } })
    fs.writeFileSync(path.join(out, 'pull-response.json'), JSON.stringify(pull.json, null, 2))
    check('default_pair_pull_succeeds', pull.status === 200)
    check('pull_downloads_only_pair', requested.filter((url) => url.includes('/assets/')).length === 2)
    const release = await api(gw, 'POST', '/api/panel/wrap-cli/kernel/release', { headers, body: { ids: [] } })
    fs.writeFileSync(path.join(out, 'release-response.json'), JSON.stringify(release.json, null, 2))
    check('legacy_bundle_update_succeeds_without_crag', release.status === 200)
    check('no_crag_payload_written', !fs.existsSync(path.join(project, 'share/crag')))
    check('legacy_cli_compatibility_preserved', fs.existsSync(path.join(project, 'share/wrap-cli/cc-node')))
  } finally {
    if (gw) await gw.stop()
    await new Promise((resolve) => origin.close(resolve))
    const writable = (dir) => {
      fs.chmodSync(dir, 0o700)
      for (const entry of fs.readdirSync(dir, { withFileTypes: true }))
        if (entry.isDirectory()) writable(path.join(dir, entry.name))
    }
    writable(project)
    fs.rmSync(project, { recursive: true, force: true })
    fs.writeFileSync(path.join(out, 'release-checks.json'), JSON.stringify(checks, null, 2))
    fs.writeFileSync(path.join(out, 'release-requests.json'), JSON.stringify(requested, null, 2))
  }
})
