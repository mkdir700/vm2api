// Real HTTP gateway -> API kernel -> native Hermit fixture. Synthetic data only.
import fs from 'node:fs'
import path from 'node:path'
import { startGateway, seedVm } from '../harness.mjs'

const [socket, apiKernel, out] = process.argv.slice(2)
const project = path.join(path.dirname(socket), 'gateway-project')
const vm = seedVm({ project })
vm.dataplane = 'hermit'
vm.proxy = { id: 'px-local', scheme: 'direct' }
vm.claude_code_version = '2.1.318'
vm.runtime.kernel_socket = socket
vm.runtime.worker_token_file = path.join(project, 'native-token')
fs.writeFileSync(vm.runtime.worker_token_file, 'toolless-private-internal-token', { mode: 0o600 })
fs.writeFileSync(path.join(project, 'vms', `${vm.id}.json`), JSON.stringify(vm))
const routing = JSON.parse(fs.readFileSync(new URL('../../src/config/routing.json', import.meta.url)))
routing.compatibility = { ...routing.compatibility, persona_preset: 'native_server', official_cc_passthrough: true, tool_name_rewrite: false }
routing.kernel_watchdog = { enabled: false }
routing.credential_refresh = { enabled: false }
routing.failover = { ...routing.failover, eager_tool_streaming: false, total_retry_deadline_ms: 15000 }
routing.inference = { ...routing.inference, health_ttl_ms: 0 }
fs.mkdirSync(path.join(project, 'config'), { recursive: true })
fs.writeFileSync(path.join(project, 'config/routing.json'), JSON.stringify(routing))
const pidFile = path.join(project, 'api.pid')
const launcher = path.join(project, 'api-launch')
const quote = (value) => "'" + value.replaceAll("'", "'\"'\"'") + "'"
fs.writeFileSync(launcher, `#!/bin/sh\nprintf '%s' "$$" > ${quote(pidFile)}\nexec ${quote(apiKernel)} "$@"\n`, { mode: 0o700 })
let gw
let stopping = false
async function stop() {
  if (stopping) return
  stopping = true
  if (gw) await gw.stop()
  let helperGone = true
  if (fs.existsSync(pidFile)) {
    const pid = Number(fs.readFileSync(pidFile, 'utf8'))
    try { process.kill(pid, 'SIGTERM') } catch (error) { if (error.code !== 'ESRCH') throw error }
    helperGone = false
    const until = Date.now() + 7000
    while (Date.now() < until) {
      try { process.kill(pid, 0) } catch (error) { if (error.code === 'ESRCH') { helperGone = true; break }; throw error }
      await new Promise((resolve) => setTimeout(resolve, 25))
    }
  }
  fs.writeFileSync(path.join(out, 'gateway-cleanup.json'), JSON.stringify({ gateway_exit: gw?.child.exitCode, gateway_signal: gw?.child.signalCode, helper_gone: helperGone }, null, 2))
  process.exit(helperGone ? 0 : 1)
}
process.on('SIGTERM', () => stop())
try {
  gw = await startGateway({ project, apiKey: 'synthetic-gateway-key', timeoutMs: 60000, readyMs: 12000,
    env: { KIN_CRS_MOCK: '0', KIN_KERNEL_BIN: process.execPath, KIN_API_KERNEL_BIN: launcher, NODE_NO_WARNINGS: '1' } })
  fs.writeFileSync(path.join(out, 'gateway-ready.json'), JSON.stringify({ base_url: gw.baseUrl, project, mock: false }))
} catch (error) {
  fs.writeFileSync(path.join(out, 'gateway-failure.json'), JSON.stringify({ error: error.message }))
  await stop()
}
