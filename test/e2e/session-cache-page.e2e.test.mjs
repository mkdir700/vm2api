import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import http from 'node:http'
import { once } from 'node:events'
import { spawn } from 'node:child_process'
import { DatabaseSync } from 'node:sqlite'
import { startGateway, seedVm, REPO_ROOT } from '../harness.mjs'

// Complete built frontend -> panel auth/route -> kernel UDS, synthetic rows only.
test('session cache details render branch statistics and explicit missing data', {timeout:90000},async()=>{
 const gw=await startGateway();const artifact=path.resolve(process.env.SESSION_CACHE_PAGE_OUT||`.tmp/session-cache-page-${Date.now()}`);fs.mkdirSync(artifact,{recursive:true});let native
 try {
  fs.mkdirSync(path.join(gw.project,'web'),{recursive:true});fs.symlinkSync(path.join(REPO_ROOT,'web/dist'),path.join(gw.project,'web/dist'))
  const file=path.join(gw.project,'vms/vm-sim-01.json');const vm=JSON.parse(fs.readFileSync(file));vm.dataplane='hermit';fs.writeFileSync(file,JSON.stringify(vm))
  const db=new DatabaseSync(path.join(gw.project,'data/kin.db'));db.prepare('INSERT INTO usage_logs(id,request_id,created_at,log_mode,model,status,vm_id,session_id,outbound_session_id,protocol,path,method) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)').run('cache-page-row','cache-page-request',new Date().toISOString(),'summary','cache-page-model',200,'vm-sim-01','visible-session','routing-session','anthropic.messages','/v1/messages','POST');db.close()
  const run=path.dirname(vm.runtime.worker_socket);fs.mkdirSync(run,{recursive:true});fs.writeFileSync(path.join(run,'internal.token'),'page-cache-fixture-token',{mode:0o600})
  const prefix={change:'append_only',retained_messages:2,message_count:4,tools_sha256:'a'.repeat(64),system_sha256:'b'.repeat(64),profile_sha256:'c'.repeat(64),cache_ttls:['1h']}
  const rows=[{request_id:'kernel-main',gateway_request_id:'cache-page-request',external_session_id:'visible-session',routing_session_id:'routing-session',branch_id:'main-branch',parent_branch_id:null,purpose:'conversation',native_owner:'s-1',native_session_id:'native-main',generation:'generation-main',selection:'owner_reused',status:200,complete:true,prefix,usage:{cache_read_input_tokens:50000,cache_creation_input_tokens:300}},{request_id:'kernel-classifier',external_session_id:'visible-session',routing_session_id:'routing-session',branch_id:'classifier-branch',parent_branch_id:null,purpose:'classifier',native_owner:'s-2',selection:'owner_created',status:400,complete:false,prefix:null,usage:null}]
  native=http.createServer((req,res)=>{res.setHeader('content-type','application/json');if(req.headers['x-kin-internal-token']!=='page-cache-fixture-token'){res.writeHead(401);return res.end('{}')};if(req.url==='/internal/health')return res.end(JSON.stringify({ok:true,healthy:true,runtime_flavor:'hermit'}));res.end(JSON.stringify({schema_version:1,scope:'recent_kernel_generation',generation:'fixture-generation',retention:{request_limit:128,dropped_requests:0,resets_on_restart:true},requests:rows,branches:[{branch_id:'main-branch',purpose:'conversation',requests:1,measured_requests:1,cache_read_tokens:50000,cache_write_tokens:300},{branch_id:'classifier-branch',purpose:'classifier',requests:1,measured_requests:0,cache_read_tokens:0,cache_write_tokens:0}]}))});await new Promise(resolve=>native.listen(path.join(run,'kernel.sock'),resolve))
  const browser=spawn('ego-browser',['nodejs'],{stdio:['pipe','pipe','pipe']});let output='';browser.stdout.on('data',d=>output+=d);browser.stderr.on('data',d=>output+=d)
  browser.stdin.end(`globalThis.sessionCachePage=${JSON.stringify({url:gw.baseUrl,artifact})};\n`+fs.readFileSync(path.join(REPO_ROOT,'test/fixtures/session-cache-page.mjs'),'utf8'));const [code]=await once(browser,'exit');fs.writeFileSync(path.join(artifact,'browser.log'),output);assert.equal(code,0,output)
 } finally {await gw.stop();if(native)await new Promise(resolve=>native.close(resolve))}
})
