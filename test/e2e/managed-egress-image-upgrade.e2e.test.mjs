import test from 'node:test'
import assert from 'node:assert/strict'
import { execFile, execFileSync } from 'node:child_process'
import { promisify } from 'node:util'
import { createHash, randomBytes } from 'node:crypto'
import { mkdtemp, mkdir, readFile, writeFile, readdir, rm } from 'node:fs/promises'
import path from 'node:path'
import { tmpdir } from 'node:os'
import http from 'node:http'
import net from 'node:net'
import { MANAGED_EGRESS_IMAGE } from '../../src/lib/vm/managed-egress-docker.mjs'
import { generateWorkstationFingerprint } from '../../src/lib/identity/workstation-fingerprint.mjs'
import { containerName } from '../../src/lib/vm/vm-runtime.mjs'

const execute = promisify(execFile)
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const artifact = path.resolve('.tmp/managed-egress-e2e/image-upgrade-receipt.json')
const BASELINE_REVISION = '568d1a01e12eb1cb7a18cf8a58775b29e8c358d1'
async function receipt(value) {
  await mkdir(path.dirname(artifact), { recursive: true })
  await writeFile(
    value.status === 'NOT RUN' ? artifact.replace('-receipt', '-not-run-receipt') : artifact,
    JSON.stringify(value, null, 2),
  )
}
async function freePort() {
  const server = net.createServer()
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const port = server.address().port
  await new Promise((resolve) => server.close(resolve))
  return port
}

test('real production images upgrade a legacy Compose deployment without losing its binding', {
  timeout: 900000,
}, async (t) => {
  if (process.env.MANAGED_EGRESS_IMAGE_UPGRADE_E2E !== '1' || process.platform !== 'linux') {
    await receipt({ status: 'NOT RUN', reason: 'explicit Linux production-image acceptance is required' })
    t.skip('explicit Linux production-image acceptance is required')
    return
  }
  const baseline = process.env.MANAGED_EGRESS_BASELINE_IMAGE || 'vm2api-managed-egress-control:baseline-amd64'
  const candidate = process.env.MANAGED_EGRESS_CANDIDATE_IMAGE || 'vm2api-managed-egress-control:candidate-amd64'
  const nonce = randomBytes(5).toString('hex')
  const root = await mkdtemp(path.join(tmpdir(), 'me-image-'))
  const deployment = path.join(root, 'deployment')
  const project = `me-image-${nonce}`
  const control = `${project}-control`
  const vmId = `vm-image-${nonce}`
  const key = randomBytes(32).toString('hex')
  const dbSecret = randomBytes(32).toString('hex')
  const version = (await readFile('VERSION', 'utf8')).trim()
  const tag = `v${version}`
  const baselineVersion = execFileSync('git', ['show', `${BASELINE_REVISION}:VERSION`], { encoding: 'utf8' }).trim()
  const baselineTag = `v${baselineVersion}`
  const registryPort = await freePort()
  const apiPort = await freePort()
  const socksPort = await freePort()
  const hy2Port = await freePort()
  const repository = `127.0.0.1:${registryPort}/vm2api`
  const guestRegistry = `127.0.0.1:${registryPort}/guests`
  let controlArch
  let imageTag
  let ref
  let baselineRef
  const registry = `${project}-registry`
  const upstream = `${project}-upstream`
  const helpers = []
  const imageIds = {}
  const origin = http.createServer((req, res) => {
    const source = req.socket.remoteAddress
    const body = req.url === '/geo' ? JSON.stringify({ query: source }) : source
    res.writeHead(200, { 'content-length': Buffer.byteLength(body) })
    res.end(body)
  })
  const docker = async (args, allowFailure = false) => {
    try {
      return (await execute('docker', args, { timeout: 300000, maxBuffer: 2 * 1024 * 1024 })).stdout.trim()
    } catch (error) {
      if (allowFailure) return null
      const detail = String(error.stderr || error.message || '')
        .replace(/socks5h?:\/\/[^\s]+/g, '[redacted-proxy]')
        .replace(/[a-fA-F0-9]{32,}/g, '[redacted-token]')
        .slice(-600)
      throw new Error(`image_acceptance_docker_failed:${args[0]} ${detail}`)
    }
  }
  const inspect = async (name) => JSON.parse(await docker(['inspect', name]))[0]
  const compose = (args, allowFailure = false) =>
    docker(
      [
        'compose',
        '--project-directory',
        deployment,
        '-p',
        project,
        '-f',
        `${deployment}/docker-compose.yml`,
        '-f',
        `${deployment}/operator.yml`,
        ...args,
      ],
      allowFailure,
    )
  const api = async (method, url, body) => {
    const r = await fetch(`http://127.0.0.1:${apiPort}${url}`, {
      method,
      headers: { authorization: `Bearer ${key}`, ...(body ? { 'content-type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(120000),
    })
    const parsed = await r.json()
    const detail = String(parsed.error?.message || '').replace(/socks5h?:\/\/[^\s]+/g, '[redacted-proxy]')
    assert.equal(r.status, 200, `${method} ${url}: ${parsed.error?.code || ''} ${detail.slice(-400)}`)
    return parsed.data || parsed
  }
  const waitApi = async () => {
    for (let i = 0; i < 120; i++) {
      try {
        if ((await fetch(`http://127.0.0.1:${apiPort}/health`, { signal: AbortSignal.timeout(1000) })).ok) return
      } catch {}
      await delay(500)
    }
    throw new Error('real_control_plane_readiness_timeout')
  }
  const upgrade = async (suffix = '', target = tag) => {
    const helper = `${project}-upgrade${suffix}`
    helpers.push(helper)
    const previous = (await inspect(control)).Id
    await docker([
      'run',
      '-d',
      '--name',
      helper,
      '--label',
      `vm2api.e2e.owner=${nonce}`,
      '-v',
      `${deployment}:${deployment}`,
      '-v',
      '/var/run/docker.sock:/var/run/docker.sock',
      '-v',
      `${path.resolve('scripts/panel-upgrade.sh')}:/upgrade.sh:ro`,
      '-w',
      deployment,
      'docker:27-cli',
      'sh',
      '/upgrade.sh',
      deployment,
      project,
      control,
      previous,
      target,
      controlArch,
      `${deployment}/docker-compose.yml`,
      `${deployment}/operator.yml`,
    ])
    const code = Number(await docker(['wait', helper]))
    return { code, previous, current: (await inspect(control)).Id }
  }
  let result
  let legacyId
  let managedId
  try {
    assert.equal(await docker(['info', '--format', '{{.OSType}}']), 'linux')
    for (const [name, image] of Object.entries({ baseline, candidate, registry: 'registry:2.8.3' }))
      imageIds[name] = (await inspect(image)).Id
    assert.notEqual(imageIds.baseline, imageIds.candidate)
    controlArch = (await inspect(candidate)).Architecture
    assert.ok(['amd64', 'arm64'].includes(controlArch))
    assert.equal((await inspect(baseline)).Architecture, controlArch)
    imageIds.guest = (await inspect('ghcr.io/dofastted/kin-os-ubuntu:24.04')).Id
    imageTag = controlArch === 'arm64' ? `${tag}-arm64` : tag
    ref = `${repository}:${imageTag}`
    const baselineImageTag = controlArch === 'arm64' ? `${baselineTag}-arm64` : baselineTag
    baselineRef = `${repository}:${baselineImageTag}`
    assert.equal((await inspect(candidate)).Config.Labels['vm2api.deployment-bundle'], '1')
    assert.equal(await docker(['network', 'ls', '--filter', 'name=^kin-eg-px-local$', '--format', '{{.Name}}']), '')
    await mkdir(`${deployment}/vms/${vmId}/cli-home/.claude`, { recursive: true })
    await mkdir(`${deployment}/deploy`, { recursive: true })
    // This is the actual baseline manifest and source, not a reduced API fixture.
    const baselineCompose = execFileSync('git', ['show', `${BASELINE_REVISION}:docker-compose.yml`], {
      encoding: 'utf8',
    })
    assert.ok(!baselineCompose.includes('sing-box-init:'))
    await writeFile(`${deployment}/docker-compose.yml`, baselineCompose)
    await writeFile(
      `${deployment}/operator.yml`,
      `services:\n  vm2api:\n    environment:\n      VM2API_ACCEPTANCE_SENTINEL: ${nonce}\n`,
    )
    const originHost = await docker(['network', 'inspect', 'bridge', '--format', '{{(index .IPAM.Config 0).Gateway}}'])
    assert.match(originHost, /^(172\.|10\.|192\.168\.)/)
    await new Promise((resolve) => origin.listen({ host: originHost, port: 0 }, resolve))
    const originPort = origin.address().port
    const originUrl = `http://${originHost}:${originPort}`
    const env = `VM2API_IMAGE=${repository}\nVM2API_IMAGE_TAG=${baselineImageTag}\nVM2API_CONTAINER_NAME=${control}\nPORT=${apiPort}\nVM2API_API_KEY=${key}\nVM2API_DB_SECRET=${dbSecret}\nVM2API_ADMIN_PASSWORD=${randomBytes(24).toString('hex')}\nKIN_AUTO_SYNC_WRAP=0\nKIN_PROXY_GEO_URL=${originUrl}/geo\nKIN_OS_REGISTRY=${guestRegistry}\n`
    const candidateEnv = env.replace(`VM2API_IMAGE_TAG=${baselineImageTag}\n`, `VM2API_IMAGE_TAG=${imageTag}\n`)
    await writeFile(`${deployment}/.env`, env, { mode: 0o600 })
    const vm = {
      id: vmId,
      name: 'image-acceptance',
      status: 'stopped',
      schedulable: false,
      timezone: 'UTC',
      locale: 'en_US.UTF-8',
      kernel: 'ubuntu-24.04',
      proxy: null,
      policy: { maxConcurrency: 1, sessionSlots: 1, weight: 1 },
      claude: {},
    }
    vm.fingerprint = generateWorkstationFingerprint(vm)
    await writeFile(`${deployment}/vms/${vmId}.json`, JSON.stringify(vm))
    const payload = path.resolve(process.env.MANAGED_EGRESS_FULL_SLOT_PAYLOAD || '.tmp/managed-egress-fullslot-payload')
    await docker([
      'run',
      '--rm',
      '--pull=never',
      '--platform',
      'linux/amd64',
      '--network',
      'none',
      '--user',
      '0:0',
      '-v',
      `${deployment}/vms/${vmId}:/work`,
      '-v',
      `${payload}:/payload:ro`,
      '--entrypoint',
      '/payload/bin/kin-computer',
      imageIds.guest,
      'create',
      '--runtime',
      'docker',
      '--vm-id',
      vmId,
      '--out',
      '/work/kvm/fingerprint',
    ])
    execFileSync(
      'openssl',
      [
        'req',
        '-x509',
        '-newkey',
        'rsa:2048',
        '-nodes',
        '-keyout',
        `${root}/key.pem`,
        '-out',
        `${root}/cert.pem`,
        '-days',
        '1',
        '-subj',
        '/CN=localhost',
      ],
      { stdio: 'ignore' },
    )
    const password = randomBytes(24).toString('hex')
    await writeFile(
      `${root}/upstream.json`,
      JSON.stringify({
        log: { disabled: true },
        inbounds: [
          { type: 'socks', tag: 'legacy', listen: '127.0.0.1', listen_port: socksPort },
          {
            type: 'hysteria2',
            tag: 'managed',
            listen: '127.0.0.1',
            listen_port: hy2Port,
            users: [{ password }],
            tls: { enabled: true, certificate_path: '/fixture/cert.pem', key_path: '/fixture/key.pem' },
          },
        ],
        outbounds: [
          { type: 'direct', tag: 'legacy-exit', inet4_bind_address: '127.0.0.2' },
          { type: 'direct', tag: 'managed-exit', inet4_bind_address: '127.0.0.3' },
        ],
        route: {
          rules: [
            { inbound: ['legacy'], outbound: 'legacy-exit' },
            { inbound: ['managed'], outbound: 'managed-exit' },
          ],
          final: 'legacy-exit',
        },
      }),
    )
    await docker([
      'run',
      '-d',
      '--name',
      upstream,
      '--label',
      `vm2api.e2e.owner=${nonce}`,
      '--network',
      'host',
      '--read-only',
      '--cap-drop',
      'ALL',
      '-v',
      `${root}:/fixture:ro`,
      MANAGED_EGRESS_IMAGE,
      'run',
      '-c',
      '/fixture/upstream.json',
    ])
    await docker([
      'run',
      '-d',
      '--name',
      registry,
      '--label',
      `vm2api.e2e.owner=${nonce}`,
      '--network',
      'host',
      '-e',
      `REGISTRY_HTTP_ADDR=127.0.0.1:${registryPort}`,
      '-v',
      `${root}/registry:/var/lib/registry`,
      'registry:2.8.3',
    ])
    for (let i = 0; i < 60; i++) {
      try {
        if ((await fetch(`http://127.0.0.1:${registryPort}/v2/`)).ok) break
      } catch {}
      await delay(200)
    }
    await docker(['tag', imageIds.guest, `${guestRegistry}/kin-os-ubuntu:24.04`])
    await docker(['push', `${guestRegistry}/kin-os-ubuntu:24.04`])
    await docker(['tag', baseline, baselineRef])
    await docker(['push', baselineRef])
    await compose(['up', '-d', '--pull', 'never'])
    await waitApi()
    assert.equal((await fetch(`http://127.0.0.1:${apiPort}/api/panel/proxies`)).status, 401)
    assert.equal((await fetch(`http://127.0.0.1:${apiPort}/console`)).status, 200)
    assert.equal((await inspect(control)).Image, imageIds.baseline)
    assert.equal((await api('GET', '/api/panel/version')).current_tag, baselineTag)
    const imported = await api('POST', '/api/panel/proxies/import', {
      text: `socks5h://127.0.0.1:${socksPort}`,
      vm_id: vmId,
    })
    legacyId = imported.items[0].id
    await api('POST', `/api/panel/vms/${vmId}/start`)
    const route = async (expected) =>
      assert.equal(
        await docker([
          'exec',
          containerName(vmId),
          'curl',
          '--silent',
          '--show-error',
          '--fail',
          '--noproxy',
          '*',
          '--max-time',
          '15',
          `${originUrl}/source`,
        ]),
        expected,
      )
    await route('127.0.0.2')
    const configBefore = createHash('sha256')
      .update(await readFile(`${deployment}/src/config/routing.json`))
      .digest('hex')
    const databaseBefore = await api('GET', '/api/panel/proxies')
    assert.ok(databaseBefore.proxies.find((p) => p.id === legacyId)?.bound_vm_ids.includes(vmId))
    t.diagnostic('the real baseline gateway and Ubuntu slot use the retained external SOCKS exit')
    await docker(['tag', candidate, ref])
    await docker(['push', ref])
    const first = await upgrade()
    assert.equal(first.code, 0, 'real panel upgrade helper must finish successfully')
    assert.notEqual(first.previous, first.current)
    assert.equal((await inspect(control)).Image, imageIds.candidate)
    assert.ok((await inspect(control)).Config.Env.includes(`VM2API_ACCEPTANCE_SENTINEL=${nonce}`))
    assert.equal((await fetch(`http://127.0.0.1:${apiPort}/api/panel/proxies`)).status, 401)
    assert.equal(await readFile(`${deployment}/.env`, 'utf8'), candidateEnv)
    assert.equal(
      createHash('sha256')
        .update(await readFile(`${deployment}/src/config/routing.json`))
        .digest('hex'),
      configBefore,
    )
    assert.equal(
      await readFile(`${deployment}/docker-compose.yml`, 'utf8'),
      await readFile('docker-compose.yml', 'utf8'),
    )
    assert.equal(
      await readFile(`${deployment}/deploy/init-managed-egress.sh`, 'utf8'),
      await readFile('deploy/init-managed-egress.sh', 'utf8'),
    )
    const sharedId = await compose(['ps', '-q', 'sing-box'])
    const shared = await inspect(sharedId)
    assert.equal(shared.State.Running, true)
    assert.deepEqual(JSON.parse(await readFile(`${deployment}/data/managed-egress/config.json`, 'utf8')).inbounds, [])
    const preserved = (await api('GET', '/api/panel/proxies')).proxies.find((p) => p.id === legacyId)
    assert.ok(preserved.bound_vm_ids.includes(vmId))
    await route('127.0.0.2')
    const second = await upgrade('-repeat')
    assert.equal(second.code, 0)
    const sharedAfter = await inspect(sharedId)
    assert.equal(sharedAfter.Id, shared.Id)
    assert.equal(sharedAfter.State.StartedAt, shared.State.StartedAt)
    assert.equal(sharedAfter.RestartCount, shared.RestartCount)
    await route('127.0.0.2')
    // Older target images predate the bundle contract. Preserve the new manifest
    // and shared instance while checking their still-supported legacy binding.
    await docker(['tag', baseline, baselineRef])
    await docker(['push', baselineRef])
    const older = await upgrade('-older-target', baselineTag)
    assert.equal(older.code, 0)
    assert.equal((await inspect(control)).Image, imageIds.baseline)
    assert.equal(
      await readFile(`${deployment}/docker-compose.yml`, 'utf8'),
      await readFile('docker-compose.yml', 'utf8'),
    )
    assert.equal((await inspect(sharedId)).State.StartedAt, shared.State.StartedAt)
    await route('127.0.0.2')
    await docker(['tag', candidate, ref])
    await docker(['push', ref])
    assert.equal((await upgrade('-restore-candidate')).code, 0)
    await route('127.0.0.2')
    const added = await api('POST', '/api/panel/proxies/import', {
      protocol: 'hysteria2',
      config: {
        server: '127.0.0.1',
        server_port: hy2Port,
        password,
        server_name: 'localhost',
        insecure: true,
      },
    })
    managedId = added.items[0].id
    await api('POST', '/api/panel/proxies/apply')
    await api('POST', `/api/panel/vms/${vmId}/stop`)
    await api('POST', `/api/panel/proxies/${managedId}/bind`, { vm_id: vmId })
    await api('POST', `/api/panel/vms/${vmId}/start`)
    await route('127.0.0.3')
    const beforeRejection = await inspect(sharedId)
    const brokenContext = path.join(root, 'broken-context')
    await mkdir(brokenContext)
    await writeFile(
      path.join(brokenContext, 'Dockerfile'),
      `FROM ${candidate}\nRUN rm /opt/vm2api/image-deploy/deploy/init-managed-egress.sh\n`,
    )
    const brokenImage = `${project}:incomplete-bundle`
    await docker(['build', '--label', `vm2api.e2e.owner=${nonce}`, '-t', brokenImage, brokenContext])
    await docker(['tag', brokenImage, ref])
    await docker(['push', ref])
    const rejected = await upgrade('-incomplete-bundle')
    assert.notEqual(rejected.code, 0, 'a declared but incomplete bundle must fail before replacing the gateway')
    assert.equal(rejected.previous, rejected.current)
    assert.ok((await readdir(deployment)).every((name) => !name.startsWith('.upgrade-deploy.')))
    assert.equal((await inspect(control)).Image, imageIds.candidate)
    assert.equal(
      await readFile(`${deployment}/docker-compose.yml`, 'utf8'),
      await readFile('docker-compose.yml', 'utf8'),
    )
    assert.equal((await inspect(sharedId)).State.StartedAt, beforeRejection.State.StartedAt)
    assert.equal((await inspect(sharedId)).RestartCount, beforeRejection.RestartCount)
    assert.equal(
      await readFile(`${deployment}/deploy/init-managed-egress.sh`, 'utf8'),
      await readFile('deploy/init-managed-egress.sh', 'utf8'),
    )
    await route('127.0.0.3')
    result = {
      status: 'PASS',
      environment: `${process.platform}/${process.arch}; real ${controlArch} control and AMD64 guest images`,
      baseline_source: BASELINE_REVISION,
      image_ids: imageIds,
      sing_box_image: MANAGED_EGRESS_IMAGE,
      registry: 'registry:2.8.3',
      registry_transport: 'isolated loopback registry',
      target_tag: tag,
      baseline_version: baselineVersion,
      candidate_version: version,
      retained_proxy_id: legacyId,
      observed_exits: ['127.0.0.2', '127.0.0.3'],
      results: [
        'real baseline and candidate production images',
        'real helper replaces old Compose manifest from target image',
        'checked empty shared service and API coexist',
        'environment routing proxy ID and VM binding survive replacement',
        'operator overlay remains selected and reaches the replacement container',
        'repeat gateway replacement preserves existing shared-service instance',
        'older target without a deployment bundle retains manifest shared instance and legacy route',
        'incomplete declared bundle refuses replacement and preserves actual managed traffic',
        'new managed exit serves actual upgraded VM traffic',
      ],
      scope:
        'pinned source-baseline to uncommitted candidate production-image replacement; native control architecture recorded above; not a published release upgrade, full installer, host reboot, provider or visual acceptance',
    }
  } catch (error) {
    await receipt({
      status: 'FAIL',
      reason: 'inspect production-image upgrade assertion; partial execution is not acceptance',
    })
    throw error
  } finally {
    const ownedControl = await inspect(control).catch(() => null)
    const ownedSlot = await inspect(containerName(vmId)).catch(() => null)
    if (ownedSlot?.State.Running) {
      assert.equal(ownedSlot.Config.Labels['kin.vm.id'], vmId)
      assert.ok(ownedSlot.Mounts.some((m) => m.Source.startsWith(`${deployment}/vms/${vmId}/`)))
      await docker(['stop', ownedSlot.Id])
    }
    if (ownedControl?.State.Running) {
      assert.equal(ownedControl.Config.Labels['com.docker.compose.project'], project)
      await docker(
        [
          'exec',
          control,
          'node',
          '--input-type=module',
          '-e',
          'import {stopProxyEgress} from "./src/lib/vm/egress.mjs"; for(const id of process.argv.slice(1)) stopProxyEgress(process.env.KIN_PROJECT_ROOT,id)',
          ...[legacyId, managedId, 'px-local'].filter(Boolean),
        ],
        true,
      )
    }
    for (const name of [control, containerName(vmId), ...helpers, upstream, registry]) {
      const info = await inspect(name).catch(() => null)
      if (!info) continue
      const owned =
        info.Config.Labels?.['vm2api.e2e.owner'] === nonce ||
        info.Config.Labels?.['com.docker.compose.project'] === project ||
        (info.Config.Labels?.['kin.vm.id'] === vmId &&
          info.Mounts.some((m) => m.Source.startsWith(`${deployment}/vms/${vmId}/`)))
      assert.ok(owned)
      await docker(['rm', '-f', info.Id])
    }
    if (await readFile(`${deployment}/docker-compose.yml`).catch(() => null))
      await compose(['down', '--remove-orphans'], true)
    // Inspect every exact test network before deleting it. No unrelated network is eligible.
    for (const id of [legacyId, managedId, 'px-local'].filter(Boolean)) {
      const network = `kin-eg-${id}`
      const found = await docker(['network', 'inspect', network], true)
      if (!found) continue
      const info = JSON.parse(found)[0]
      assert.equal(Object.keys(info.Containers || {}).length, 0)
      await docker(['network', 'rm', info.Id])
    }
    await new Promise((resolve) => origin.close(resolve))
    await rm(root, { recursive: true, force: true })
  }
  result.source_files = Object.fromEntries(
    await Promise.all(
      [
        'test/e2e/managed-egress-image-upgrade.e2e.test.mjs',
        'Dockerfile',
        'deploy/Dockerfile.arm64-control',
        'scripts/panel-upgrade.sh',
        'scripts/docker-entrypoint.sh',
        'scripts/fleet-services.mjs',
        'docker-compose.yml',
        'deploy/init-managed-egress.sh',
        'src/lib/admin/release.mjs',
        'src/lib/vm/proxy-pool.mjs',
        'src/lib/vm/vm-package.mjs',
        'src/lib/vm/vm-runtime.mjs',
        'src/lib/oauth/oauth-credentials.mjs',
        'src/lib/admin/panel-routes.mjs',
        'src/lib/db/migrations/049_managed_egress.sql',
        'src/lib/db/migrations/050_managed_egress_removal.sql',
      ].map(async (file) => [
        file,
        createHash('sha256')
          .update(await readFile(file))
          .digest('hex'),
      ]),
    ),
  )
  await receipt(result)
})
