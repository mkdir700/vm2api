import test, { after, before } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createPanelHandler } from '../../src/lib/admin/panel-routes.mjs'
import { authorizePanelRoute } from '../../src/lib/admin/panel-acl.mjs'

const env = Object.fromEntries(
  ['KIN_SLOT_RUN_ROOT', 'KIN_WRAP_CLI_ROOT', 'KIN_KERNEL_BIN'].map((key) => [key, process.env[key]]),
)
before(() => {
  for (const key of Object.keys(env)) delete process.env[key]
})
after(() => {
  for (const [key, value] of Object.entries(env)) {
    if (value == null) delete process.env[key]
    else process.env[key] = value
  }
})
function elf(payload) {
  const bytes = Buffer.alloc(96 + payload.length)
  bytes.set([0x7f, 0x45, 0x4c, 0x46, 2, 1, 1])
  bytes.writeUInt16LE(3, 16)
  bytes.writeUInt16LE(62, 18)
  bytes.writeUInt32LE(1, 20)
  bytes.write(payload, 96)
  return bytes
}
function writable(root) {
  if (!fs.existsSync(root)) return
  fs.chmodSync(root, 0o755)
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    if (entry.isDirectory()) writable(path.join(root, entry.name))
  }
}
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'panel-kernels-'))
  t.after(() => {
    writable(root)
    fs.rmSync(root, { recursive: true, force: true })
  })
  fs.mkdirSync(path.join(root, 'vms'), { recursive: true })
  const vms = [
    { id: 'vm-13', status: 'running', dataplane: 'wrap', owner_user_id: 'owner-a' },
    { id: 'vm-14', status: 'running', dataplane: 'wrap', owner_user_id: 'owner-b' },
    { id: 'vm-gpt', status: 'running', platform: 'openai', family: 'codex', codex_kernel: true },
  ]
  for (const vm of vms) fs.writeFileSync(path.join(root, 'vms', `${vm.id}.json`), JSON.stringify(vm))
  const cli = path.join(root, 'share', 'wrap-cli')
  fs.mkdirSync(cli, { recursive: true })
  fs.writeFileSync(path.join(cli, 'kin-kernel.bin'), elf('cached-kernel'), { mode: 0o755 })
  fs.writeFileSync(path.join(cli, 'cli-node'), elf('cached-cli'), { mode: 0o755 })
  return { root, vms }
}
async function route(root, method, endpoint, body, options = {}) {
  const response = {}
  const handle = createPanelHandler({
    cfg: { paths: { project: root } },
    routingConfig: {},
    requireAuth(req) {
      req.panelUser = 'fixture'
      req.panelRole = options.role || 'admin'
      req.panelUserId = 'owner-a'
      return true
    },
    json(_res, status, payload) {
      response.status = status
      response.body = payload
      return true
    },
    readBody: async () => body,
    ...options.ctx,
  })
  await handle({ method }, {}, new URL(`http://localhost/api/panel/kernels${endpoint}`))
  return response
}

for (const role of ['user', 'super']) {
  for (const [method, endpoint] of [
    ['GET', ''],
    ['POST', '/pull'],
    ['POST', '/install'],
  ]) {
    test(`${role} cannot access kernel ${method} ${endpoint || 'inventory'}`, async (t) => {
      const { root } = fixture(t)
      const response = await route(
        root,
        method,
        endpoint,
        { kernel: 'cli-node', targets: [{ id: 'vm-14', kernel: 'cli-node' }] },
        {
          role,
          ctx: {
            readBody() {
              assert.fail('authorization must precede body parsing')
            },
            fetchImpl() {
              assert.fail('no download')
            },
            kernelInstallOps: {
              stopSlot() {
                assert.fail('no stop')
              },
            },
          },
        },
      )
      assert.equal(response.status, 403)
      assert.equal(authorizePanelRoute(method, `/api/panel/kernels${endpoint}`, role).ok, false)
    })
  }
}
