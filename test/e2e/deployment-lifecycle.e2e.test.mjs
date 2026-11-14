import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import http from 'node:http'
import crypto from 'node:crypto'
import { startGateway, api, seedVm } from '../harness.mjs'

// 实现前失败清单：deployer/docs/vm2api-lifecycle.md。
test('发布事务通过真实 HTTP 和 Unix 套接字跨进程恢复，并单独恢复调度', { timeout: 60000 }, async () => {
  const project = fs.mkdtempSync(path.join(os.tmpdir(), 'dl-'))
  const output = path.resolve(process.env.DEPLOYMENT_LIFECYCLE_OUT || '.tmp/deployment-lifecycle')
  fs.mkdirSync(output, { recursive: true })
  const checks = [],
    servers = []
  let gw,
    outcome = 'FAIL'
  const check = (name, value) => {
    checks.push({ name, passed: Boolean(value) })
    assert.ok(value, name)
  }
  const records = ['vm-live', 'vm-off', 'vm-stopped']
  const read = (id) => JSON.parse(fs.readFileSync(path.join(project, 'vms', `${id}.json`)))
  const write = (id, record) => fs.writeFileSync(path.join(project, 'vms', `${id}.json`), JSON.stringify(record))
  let health = {
    ok: true,
    healthy: true,
    active_requests: 0,
    pending_tool_results: 0,
    queued_requests: 0,
    helper_active: false,
    recovering: false,
    switch_ready: true,
    rollout_drain_schema: 1,
    session_restore_protocol: 'anthropic-full-history-v1',
    runtime_flavor: 'cli-node',
  }
  const start = () => startGateway({ project, env: { TRUEROUTER_INSTANCE_ID: 'fixture-blue' } })
  const call = (action, extra = {}) =>
    api(gw, 'POST', '/api/panel/deployment', {
      body: { action, id: 'release-1', instance: 'fixture-blue', ...extra },
    })
  try {
    for (const id of records) {
      const vm = seedVm({ project, id })
      if (id === 'vm-off') {
        vm.schedule_off = true
        vm.schedule_off_reason = 'disabled'
        vm.schedulable = false
      }
      if (id === 'vm-stopped') {
        vm.status = 'stopped'
        vm.schedule_off = true
        vm.schedule_off_reason = 'stopped'
        vm.schedulable = false
      }
      write(id, vm)
      const run = path.join(project, 'vms', id, 'run')
      fs.mkdirSync(run, { recursive: true })
      fs.writeFileSync(path.join(run, 'internal.token'), 'fixture-internal-token')
      const server = http.createServer((req, res) => {
        assert.equal(req.headers['x-kin-internal-token'], 'fixture-internal-token')
        assert.equal(req.url, '/internal/health')
        res.setHeader('content-type', 'application/json')
        res.end(JSON.stringify(health))
      })
      await new Promise((resolve) => server.listen(path.join(run, 'kernel.sock'), resolve))
      servers.push(server)
    }
    gw = await start()
    check('错误实例拒绝发布', (await call('prepare', { instance: 'fixture-green' })).status === 409)
    const unauthenticated = await fetch(gw.baseUrl + '/api/panel/deployment', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    })
    check('未认证请求拒绝发布', unauthenticated.status === 401)
    health.pending_tool_results = 1
    const waiting = await call('prepare')
    check('工具未完成时保持等待', waiting.json.data.state === 'waiting')
    check(
      '所有槽位已被事务暂停',
      records.every((id) => read(id).schedule_hold?.detail?.tag === 'release-1'),
    )
    check('另一事务无法覆盖暂停', (await call('prepare', { id: 'release-2' })).status === 409)
    const inference = await api(gw, 'POST', '/v1/messages', {
      body: { model: 'claude-sonnet-4-6', max_tokens: 1, messages: [{ role: 'user', content: 'test' }] },
    })
    check('维护时拒绝新模型请求', inference.status === 503 && inference.json.error.code === 'deployment_active')
    check(
      '人工调度操作不能绕过事务',
      (await api(gw, 'POST', '/api/panel/vms/schedule/resume', { body: {} })).status === 409,
    )
    health.pending_tool_results = 0
    health.queued_requests = 1
    check('内核队列未清空时等待', (await call('prepare')).json.data.state === 'waiting')
    health.queued_requests = 0
    delete health.recovering
    check('缺少排空证明时等待', (await call('prepare')).json.data.state === 'waiting')
    health.recovering = false
    check('排空完成进入已准备状态', (await call('prepare')).json.data.state === 'prepared')
    const snapshot = JSON.parse(fs.readFileSync(path.join(project, 'data/deployment-lifecycle.json')))
    await gw.stop()
    gw = await start()
    check('重启保留发布状态', (await call('status')).json.data.state === 'prepared')
    check('未恢复内核时不能恢复调度', (await call('resume')).status === 409)
    check('更新前再次排空并记录更新阶段', (await call('begin-update')).json.data.state === 'updating')
    check('开始更新后不能取消事务', (await call('cancel')).status === 409)
    const changed = read('vm-live')
    changed.proxy.id = 'changed'
    write('vm-live', changed)
    check('出口绑定变化拒绝恢复', (await call('restore')).json.error.code === 'deployment_binding_changed')
    changed.proxy.id = 'proxy-vm-live'
    write('vm-live', changed)
    health.ok = false
    health.healthy = false
    check(
      '恢复失败不会开放调度',
      (await call('restore')).status === 409 && read('vm-live').schedule_hold.detail.tag === 'release-1',
    )
    check('恢复失败保留可重试阶段', (await call('status')).json.data.state === 'restoring')
    health.ok = true
    health.healthy = true
    check('恢复已有健康内核进入就绪', (await call('restore')).json.data.state === 'ready')
    check(
      '恢复内核后仍保留全部暂停',
      records.every((id) => read(id).schedule_hold?.detail?.tag === 'release-1'),
    )
    health.helper_active = true
    check('恢复调度重新检查辅助任务', (await call('resume')).json.error.code === 'deployment_not_drained')
    check('就绪失效不清除暂停', read('vm-live').schedule_hold.detail.tag === 'release-1')
    health.helper_active = false
    check('单独恢复调度成功', (await call('resume')).json.data.state === 'resumed')
    check(
      '人工关闭调度状态保持',
      read('vm-off').schedule_off === true && read('vm-off').schedule_off_reason === 'disabled',
    )
    check('已停止槽位不自动启动', read('vm-stopped').status === 'stopped')
    check(
      '本次维护暂停已清除',
      records.every((id) => !read(id).schedule_hold),
    )
    check('重复恢复调度幂等', (await call('resume')).json.data.state === 'resumed')
    check(
      '重复准备不覆盖原快照',
      (await call('prepare')).json.data.state === 'resumed' &&
        JSON.stringify(JSON.parse(fs.readFileSync(path.join(project, 'data/deployment-lifecycle.json'))).slots) ===
          JSON.stringify(snapshot.slots),
    )
    const off = read('vm-off')
    off.schedule_hold = { reason: 'proxy_cooldown', detail: { tag: 'prior-proxy-hold' } }
    write('vm-off', off)
    check('下一事务可以准备', (await call('prepare', { id: 'release-2' })).json.data.state === 'prepared')
    check('更新前可以取消事务', (await call('cancel', { id: 'release-2' })).json.data.state === 'cancelled')
    check('取消恢复原有其他暂停', read('vm-off').schedule_hold.detail.tag === 'prior-proxy-hold')
    check('已归档事务不能重新使用', (await call('prepare')).json.error.code === 'deployment_id_reused')
    outcome = 'PASS'
  } finally {
    if (gw) await gw.stop()
    for (const server of servers) await new Promise((resolve) => server.close(resolve))
    fs.writeFileSync(
      path.join(output, 'receipt.json'),
      JSON.stringify(
        {
          schema: 1,
          result: outcome,
          checks,
          source_sha256: crypto
            .createHash('sha256')
            .update(fs.readFileSync(new URL('../../src/lib/vm/deployment-lifecycle.mjs', import.meta.url)))
            .digest('hex'),
          boundary: '真实 HTTP、进程重启、Unix 控制套接字和持久文件；KVM 启动及模型供应商未运行',
        },
        null,
        2,
      ),
    )
    fs.rmSync(project, { recursive: true, force: true })
  }
})
