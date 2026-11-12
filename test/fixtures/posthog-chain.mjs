import http from 'node:http'
// 真实网关与槽位 socket 的跨仓库端到端驱动。只使用隔离模拟上游。
import fs from 'node:fs'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { startGateway, seedVm, pickFreePort } from '../harness.mjs'

const config = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'))
const vm = seedVm({ project: config.project })
vm.proxy = { id: 'isolated-direct', scheme: 'direct' }
vm.runtime.kernel_socket = config.socket
fs.writeFileSync(path.join(config.project, 'vms', `${vm.id}.json`), JSON.stringify(vm))
fs.mkdirSync(vm.runtime.worker_run_dir, { recursive: true })
fs.writeFileSync(vm.runtime.worker_token_file, config.token, { mode: 0o600 })
let gateway
let ingress
let stdout = ''
let stderr = ''
const requests = []
const checks = []
function check(name, ok) { checks.push({ name, result: ok ? 'PASS' : 'FAIL' }); if (!ok) throw new Error(name) }
try {
  gateway = await startGateway({ project: config.project, readyMs: 30000, timeoutMs: 45000, env: {
    KIN_CRS_MOCK: '0', KIN_API_KERNEL_BIN: config.api_kernel, KIN_KERNEL_BIN: process.execPath, KIN_AUTO_SYNC_WRAP: '0', KIN_REQUEST_LOG_MODE: 'normal',
  } })
  const port = await pickFreePort()
  ingress = spawn(config.sub2api, [], { env: { ...process.env, E2E_TARGET: gateway.baseUrl, E2E_API_KEY: gateway.apiKey, E2E_LISTEN: `127.0.0.1:${port}`, TRUEROUTER_TRACE_ORIGINS: gateway.baseUrl }, stdio: ['ignore', 'pipe', 'pipe'] })
  ingress.stdout.on('data', d => { stdout += d.toString() })
  ingress.stderr.on('data', d => { stderr += d.toString() })
  const base = `http://127.0.0.1:${port}`
  for (let i = 0; i < 200; i++) {
    await new Promise(r => setTimeout(r, 25))
    try { if ((await fetch(`${base}/health`)).ok) break } catch {}
    if (i === 199) throw new Error('入口未就绪')
  }
  let messages = [{ role: 'user', content: 'ISOLATED_OBSERVABILITY_CHECK' }]
  for (let index = 0; index < 2; index++) {
    const requestId = `${config.run_id}-${index}`
    const res = await fetch(`${base}/v1/messages`, { method: 'POST', headers: {
      'content-type': 'application/json', 'x-request-id': requestId,
      'x-claude-code-session-id': 'isolated-observability',
      traceparent: '00-11111111111111111111111111111111-2222222222222222-00',
    }, body: JSON.stringify({ model: 'claude-sonnet-4-6', max_tokens: 64, stream: index === 1, messages }), signal: AbortSignal.timeout(60000) })
    const text = await res.text()
    if (res.status !== 200) console.error(`fixture response ${res.status}: ${text.slice(0, 1000)}`)
    check(`response_${index}`, res.status === 200)
    if (index === 1) check('stream_terminal', text.includes('message_stop'))
    requests.push({ request_id: requestId, status: res.status, stream: index === 1 })
    messages = [...messages, { role: 'assistant', content: [{ type: 'text', text: `OWNED_DONE_${index + 1}` }] }, { role: 'user', content: 'NEXT_ISOLATED_CHECK' }]
  }
  for (let index=0;index<2;index++) {
    const requestId=`${config.run_id}-public-${index}`
    const response=await fetch(`${gateway.baseUrl}/v1/messages`,{method:'POST',headers:{authorization:`Bearer ${gateway.apiKey}`,'content-type':'application/json','x-request-id':requestId,'x-claude-code-session-id':'isolated-observability',traceparent:'00-11111111111111111111111111111111-2222222222222222-01',...(index===1?{'x-observability-token':'wrong-token'}:{})},body:JSON.stringify({model:'claude-sonnet-4-6',max_tokens:64,messages})})
    const value=await response.json()
    check(`authenticated_public_${index}`,response.status===200)
    requests.push({request_id:requestId,status:response.status,stream:false,ingress:'vm2api'})
    messages=[...messages,{role:'assistant',content:value.content},{role:'user',content:'NEXT_ISOLATED_CHECK'}]
  }
  if (config.faults) {
    const scenario=mode=>new Promise((resolve,reject)=>{http.get({socketPath:config.socket,path:`/scenario?mode=${mode}`},response=>{response.resume();response.on('end',resolve)}).on('error',reject)})
    for (const mode of ['unknown','broken','cancel']) {
      await scenario(mode)
      const requestId=`${config.run_id}-${mode}`
      const controller=new AbortController()
      const response=await fetch(`${base}/v1/messages`,{method:'POST',headers:{'content-type':'application/json','x-request-id':requestId,'x-claude-code-session-id':'isolated-observability'},body:JSON.stringify({model:'claude-sonnet-4-6',max_tokens:64,stream:mode!=='unknown',messages}),signal:controller.signal})
      if (mode==='cancel') {
        const reader=response.body.getReader();await reader.read();controller.abort();try{await reader.cancel()}catch{}
      } else await response.text()
      check(`fault_response_${mode}`,mode==='unknown'?response.status>=400:response.status===200)
      requests.push({request_id:requestId,status:response.status,stream:mode!=='unknown',expected:mode==='cancel'?'cancelled':'unknown'})
      await new Promise(resolve=>setTimeout(resolve,400))
    }
  }
  if (config.faults) {
    await new Promise((resolve,reject)=>{http.get({socketPath:config.socket,path:'/scenario?mode=complete'},response=>{response.resume();response.on('end',resolve)}).on('error',reject)})
    await Promise.all([0,1].map(async index=>{
      const requestId=`${config.run_id}-concurrent-${index}`
      const response=await fetch(`${base}/v1/messages`,{method:'POST',headers:{'content-type':'application/json','x-request-id':requestId,'x-claude-code-session-id':'isolated-concurrent'},body:JSON.stringify({model:'claude-sonnet-4-6',max_tokens:64,messages:[{role:'user',content:'ISOLATED_CONCURRENT_CHECK'}]})})
      await response.text();check(`concurrent_response_${index}`,response.status===200)
      requests.push({request_id:requestId,status:response.status,stream:false,expected:'success'})
    }))
  }
  // A public call directly to vm2api cannot inherit a customer-supplied parent.
  const res = await fetch(`${gateway.baseUrl}/v1/messages`, { method: 'POST', headers: { authorization: 'Bearer INVALID_SYNTHETIC_KEY', 'content-type': 'application/json', traceparent: '00-11111111111111111111111111111111-2222222222222222-01' }, body: '{}' })
  await res.text()
  check('public_auth_still_required', res.status === 401)
} finally {
  if (ingress && ingress.exitCode === null) {
    ingress.kill('SIGTERM')
    await Promise.race([new Promise(resolve => ingress.once('exit', resolve)), new Promise(resolve => setTimeout(resolve, 5000))])
    if (ingress.exitCode === null) ingress.kill('SIGKILL')
  }
  if (gateway) {
    await gateway.stop()
    stdout += gateway.stdout()
    stderr += gateway.stderr()
    if (!checks.length || checks.some(c => c.result === 'FAIL')) console.error(gateway.stderr().slice(-6000))
  }
  const logs = `${stdout}\n${stderr}`.split('\n').flatMap(line => { try { const row = JSON.parse(line); return row.msg === 'truerouter.observability' ? [row] : [] } catch { return [] } })
  fs.writeFileSync(path.join(config.out, 'application-logs.json'), JSON.stringify(logs, null, 2))
  fs.writeFileSync(path.join(config.out, 'driver-receipt.json'), JSON.stringify({ requests, checks, ingress_stopped: !ingress || ingress.exitCode !== null, gateway_stopped: !gateway || gateway.child.exitCode !== null }, null, 2))
}
