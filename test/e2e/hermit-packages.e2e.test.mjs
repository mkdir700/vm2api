import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import http from 'node:http'
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { once } from 'node:events'
import { startGateway, api } from '../harness.mjs'

const sha = (bytes) => createHash('sha256').update(bytes).digest('hex')
const fixtureScript = `import io,json,tarfile,hashlib,sys
root,version,url=sys.argv[1:4]
options=json.loads(sys.argv[4])
elf=b'\\x7fELF\\x02\\x01'+bytes(10)+b'\\x02\\x00\\x3e\\x00'+bytes(4076)
hooks=['probe-native-input.mjs','probe-input-screening.mjs','probe-dispatch-gate.mjs','response-relay.mjs']
payload={'bin/hermit':elf,**{'hooks/'+n:b'// isolated fixture\\n'for n in hooks}}
manifest={'schema_version':2,'runtime':'hermit','version':version,'target':'linux-amd64','acceptance':'local-mock-only','slot_protocol':'vm2api-slot-1','entrypoints':{'kernel':{'path':'bin/hermit','args':['--mode','vm2api-slot']},'helper':{'path':'bin/hermit','args':['oauth']}},'cli':{'version':'2.1.318','platform':'linux-x64','bytes':len(elf),'sha256':hashlib.sha256(elf).hexdigest(),'provisioning':'shared-cache','download_url':url},'dependencies':{'tmux':{'version':'3.4','sha256':'1'*64,'provisioning':'host'}},'capabilities':{'production':False,'helper_integration':False,'messages':True,'tools':True,'full_history_bootstrap':True,'cancel':True,'health':True},'validated_environment':{'distribution':'ubuntu','version_id':'24.04','libc':'glibc 2.39','architecture':'x86_64'},'files':{n:{'bytes':len(b),'sha256':hashlib.sha256(b).hexdigest(),'mode':493 if n=='bin/hermit'else 420}for n,b in payload.items()}}
manifest.update(options.get('manifest',{}))
raw=(json.dumps(manifest,sort_keys=True,indent=2)+'\\n').encode()
if options.get('duplicate_json'): raw=raw.replace(b'"runtime": "hermit"',b'"runtime": "hermit", "runtime": "hermit"')
with tarfile.open(root+'/package-'+version+'.tar.gz','w:gz')as t:
 for n,b in {'manifest.json':raw,**payload}.items():
  i=tarfile.TarInfo(n);i.size=len(b);i.mode=493 if n=='bin/hermit'else 420;t.addfile(i,io.BytesIO(b))
 if options.get('bad_member'):
  i=tarfile.TarInfo(options['bad_member']);i.size=3;i.mode=420
  if options.get('link'):i.type=tarfile.SYMTYPE;i.linkname='/etc/passwd';i.size=0
  t.addfile(i,io.BytesIO(b'bad') if i.size else None)
open(root+'/cli','wb').write(elf)
open(root+'/manifest-'+version+'.json','wb').write(raw)
`

// Failure inventory is recorded in .planning/2026-11-08-hermit-kernel/task_plan.md.
test('admin uploads immutable thin packages and shares a verified CLI cache without activating slots', {
  timeout: 60000,
}, async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hermit-pkg-api-'))
  const artifact = path.resolve(process.env.HERMIT_E2E_OUT || `.tmp/hermit-packages-${Date.now()}-${process.pid}`)
  fs.mkdirSync(artifact, { recursive: true })
  const checks = []
  const check = (name, value) => {
    checks.push({ name, result: value ? 'PASS' : 'FAIL' })
    assert.ok(value, name)
  }
  let gw
  let calls = 0
  let completed = false
  const upstream = http.createServer((req, res) => {
    calls++
    res.end(fs.readFileSync(path.join(root, 'cli')))
  })
  upstream.listen(0, '127.0.0.1')
  await once(upstream, 'listening')
  const url = `http://127.0.0.1:${upstream.address().port}/claude`
  const fixture = (version, options = {}) => {
    execFileSync('python3', ['-c', fixtureScript, root, version, url, JSON.stringify(options)])
    const bytes = fs.readFileSync(path.join(root, `package-${version}.tar.gz`))
    const manifest = fs.readFileSync(path.join(root, `manifest-${version}.json`))
    return {
      bytes,
      manifest,
      headers: {
        'content-type': 'application/gzip',
        'x-kernel-sha256': sha(bytes),
        'x-kernel-bytes': String(bytes.length),
        'x-kernel-manifest-sha256': sha(manifest),
      },
    }
  }
  try {
    gw = await startGateway({ env: { KIN_KERNEL_TEST_ENDPOINTS: '1' } })
    const before = fs.readFileSync(path.join(gw.project, 'vms', 'vm-sim-01.json'))
    const credential = path.join(gw.project, 'vms/vm-sim-01/cli-home/.claude/credentials.json')
    fs.writeFileSync(credential, '{"access_token":"synthetic-preserve"}')
    const login = await api(gw, 'POST', '/api/panel/login', { body: { username: 'admin', password: 'testpass' } })
    assert.equal(login.status, 200)
    const cookie = login.headers.get('set-cookie')
    const send = async (data, override = {}) => {
      const response = await fetch(gw.baseUrl + '/api/panel/kernel-packages', {
        method: 'POST',
        headers: { cookie, ...data.headers, ...override },
        body: data.bytes,
      })
      const text = await response.text()
      const body = JSON.parse(text)
      checks.push({ name: 'upload', status: response.status, body })
      return { response, body }
    }
    const first = fixture('0.1.0')
    const unauth = await fetch(gw.baseUrl + '/api/panel/kernel-packages', {
      method: 'POST',
      headers: first.headers,
      body: first.bytes,
    })
    check('unauthenticated_rejected', unauth.status === 401)
    const wrong = await send(first, { 'x-kernel-sha256': '0'.repeat(64) })
    check('wrong_archive_digest_rejected', wrong.response.status === 400)
    check('wrong_archive_did_not_download', calls === 0)
    const installed = await send(first)
    check('thin_package_installed', installed.response.status === 200 && installed.body.data.activated === false)
    check('cli_downloaded_once', calls === 1)
    const repeat = await send(first)
    check('installation_idempotent', repeat.response.status === 200 && repeat.body.data.idempotent)
    check('cache_hit_did_not_download', calls === 1)
    const second = fixture('0.2.0')
    const next = await send(second)
    check('second_version_installed', next.response.status === 200)
    check('shared_cli_reused', calls === 1)
    const listing = await fetch(gw.baseUrl + '/api/panel/kernel-packages', { headers: { cookie } })
    const catalog = await listing.json()
    fs.writeFileSync(path.join(artifact, 'catalog.json'), JSON.stringify(catalog, null, 2))
    check('both_versions_visible', listing.status === 200 && catalog.data.items.length === 2)
    check('list_does_not_expose_host_paths', !JSON.stringify(catalog).includes(gw.project))
    check('slot_policy_unchanged', before.equals(fs.readFileSync(path.join(gw.project, 'vms/vm-sim-01.json'))))
    check('credential_preserved', fs.readFileSync(credential, 'utf8') === '{"access_token":"synthetic-preserve"}')
    const cacheRoot = path.join(gw.project, 'share/kernel-packages/cli')
    check('one_shared_cli', fs.readdirSync(cacheRoot).filter((n) => /^[0-9a-f]{64}$/.test(n)).length === 1)
    for (const [version, options] of [
      ['bad-traversal', { bad_member: '../escape' }],
      ['bad-link', { bad_member: 'bin/hermit', link: true }],
      ['bad-duplicate', { bad_member: 'hooks/probe-native-input.mjs' }],
      ['bad-json', { duplicate_json: true }],
    ]) {
      const invalid = await send(fixture(version, options))
      check(version + '_rejected', invalid.response.status === 400)
    }
    const conflict = await send(
      fixture('0.1.0', { manifest: { capabilities: { production: true, helper_integration: false } } }),
    )
    check('same_version_conflict_rejected', conflict.response.status === 409)
    const firstDoc = JSON.parse(first.manifest)
    const wrongCli = await send(fixture('bad-cli', { manifest: { cli: { ...firstDoc.cli, sha256: '2'.repeat(64) } } }))
    check('wrong_download_digest_rejected', wrongCli.response.status === 400)
    check(
      'failed_download_not_published',
      !fs.existsSync(path.join(gw.project, 'share/kernel-packages/versions/hermit/linux-amd64/bad-cli')),
    )
    const wrongOrigin = await send(
      fixture('bad-origin', {
        manifest: { cli: { ...firstDoc.cli, download_url: 'http://169.254.169.254/metadata' } },
      }),
    )
    check('unsafe_dependency_origin_rejected', wrongOrigin.response.status === 400)
    const dependency = path.join(cacheRoot, firstDoc.cli.sha256, 'claude')
    const original = fs.readFileSync(dependency)
    fs.chmodSync(dependency, 0o644)
    fs.writeFileSync(dependency, Buffer.alloc(original.length))
    const corrupt = await send(first)
    check('corrupt_shared_cache_rejected', corrupt.response.status === 400)
    fs.writeFileSync(dependency, original)
    fs.chmodSync(dependency, 0o555)
    check(
      'failed_installs_leave_no_staging',
      !fs.readdirSync(path.join(gw.project, 'share/kernel-packages')).some((n) => n.startsWith('.package-')),
    )
    const choose = async (body) => {
      const response = await fetch(gw.baseUrl + '/api/panel/dataplane', {
        method: 'POST',
        headers: { cookie, 'content-type': 'application/json' },
        body: JSON.stringify(body),
      })
      return { status: response.status, body: await response.json() }
    }
    const missing = await choose({
      dataplane: 'hermit',
      ids: ['vm-sim-01'],
      version: 'missing',
      target: 'linux-amd64',
      restart: false,
    })
    check('missing_package_selection_rejected', missing.status === 400)
    const staged = await choose({
      dataplane: 'hermit',
      ids: ['vm-sim-01'],
      version: '0.1.0',
      target: 'linux-amd64',
      restart: false,
    })
    check('existing_slot_staged', staged.status === 200 && staged.body.data.activated === false)
    const record = JSON.parse(fs.readFileSync(path.join(gw.project, 'vms/vm-sim-01.json')))
    check(
      'staged_does_not_replace_active_kernel',
      record.dataplane === undefined && record.pending_kernel_package?.version === '0.1.0',
    )
    const blocked = await choose({
      dataplane: 'hermit',
      ids: ['vm-sim-01'],
      version: '0.1.0',
      target: 'linux-amd64',
      restart: true,
    })
    check('unqualified_activation_rejected', blocked.status === 409)
    const after = JSON.parse(fs.readFileSync(path.join(gw.project, 'vms/vm-sim-01.json')))
    check('failed_activation_preserves_active_kernel', after.dataplane === undefined)

    const invalidTLS = await send(
      fixture('0.2.0-tls-invalid', {
        manifest: { capabilities: { production: false, helper_integration: false, https_upstream: 'true' } },
      }),
    )
    check(
      'tls_capability_requires_boolean',
      invalidTLS.response.status === 400 && invalidTLS.body.error?.code === 'invalid_capabilities',
    )
    const invalidHelper = await send(
      fixture('0.2.0-helper-invalid', { manifest: { capabilities: { production: false, helper_integration: true } } }),
    )
    check(
      'full_helper_cannot_declare_legacy_cli_entrypoint',
      invalidHelper.response.status === 400 && invalidHelper.body.error?.code === 'invalid_native_helper_entrypoint',
    )
    completed = true
  } finally {
    if (gw) {
      fs.writeFileSync(path.join(artifact, 'server-stderr.txt'), gw.stderr())
      await gw.stop()
    }
    upstream.close()
    fs.rmSync(root, { recursive: true, force: true })
    fs.writeFileSync(path.join(artifact, 'checks.json'), JSON.stringify(checks, null, 2))
    fs.writeFileSync(
      path.join(artifact, 'summary.json'),
      JSON.stringify({ result: completed ? 'PASS' : 'FAIL', checks: checks.length }, null, 2),
    )
  }
})
