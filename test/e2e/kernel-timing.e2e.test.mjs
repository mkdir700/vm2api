import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import http from 'node:http'
import { once } from 'node:events'
import { createHash } from 'node:crypto'
import { spawn } from 'node:child_process'
import { startGateway, seedVm, api, REPO_ROOT } from '../harness.mjs'

// 失败方式见 docs/operations/kernel-request-timing.md。
// 真实网关 HTTP -> 调度 -> Unix socket -> SQLite -> 面板 HTTP，内核响应使用夹具。
test('kernel timing requires declaration and survives stream, nonstream and restart', { timeout: 90000 }, async () => {
  const project = fs.mkdtempSync('/tmp/kt-')
  const out = path.resolve(process.env.KERNEL_TIMING_OUT || `.tmp/kernel-timing-${Date.now()}`)
  fs.mkdirSync(out, { recursive: true })
  const vm = seedVm({ project })
  vm.proxy = { id: 'direct-fixture', scheme: 'direct' }
  fs.writeFileSync(path.join(project, 'vms', `${vm.id}.json`), JSON.stringify(vm))
  const run = vm.runtime.worker_run_dir
  fs.mkdirSync(run, { recursive: true })
  let mode = 'supported'
  const saved = [],
    checks = []
  const check = (name, actual, expected) => {
    checks.push({
      name,
      result: JSON.stringify(actual) === JSON.stringify(expected) ? 'PASS' : 'FAIL',
    })
    assert.deepEqual(actual, expected, name)
  }
  const fixture = http.createServer(async (req, res) => {
    res.setHeader('content-type', 'application/json')
    if (req.url === '/internal/health')
      return res.end(
        JSON.stringify({
          ok: true,
          healthy: true,
          runtime_flavor: 'hermit',
          ready_slots: 20,
          available_session_slots: 20,
          switch_ready: true,
        }),
      )
    const chunks = []
    for await (const chunk of req) chunks.push(chunk)
    const envelope = JSON.parse(Buffer.concat(chunks))
    const timing = {
      schema_version: 1,
      request_id: envelope.request_id,
      selection: 'owner_reused',
      timings_ms: { pool_wait: 0, context_check: 2.5, delivery: 30 },
      upstream_timing: {
        dispatch_ms: 1,
        headers_ms: 10,
        first_byte_ms: 11,
        first_protocol_ms: 12,
        first_content_ms: null,
        complete_ms: 20,
      },
    }
    if (mode === 'wrong-request') timing.request_id = 'another-request'
    if (mode === 'wrong-version') timing.schema_version = 2
    if (mode === 'invalid') timing.timings_ms.delivery = -1
    if (mode === 'oversized') timing.padding = 'x'.repeat(9000)
    if (mode !== 'undeclared') res.setHeader('X-Kernel-Request-Timing', '1')
    res.setHeader('Trailer', 'X-Kernel-Timing')
    const message = {
      type: 'message',
      id: 'msg_fixture',
      role: 'assistant',
      model: envelope.body.model,
      content: [{ type: 'text', text: 'TIMING_OK' }],
      stop_reason: 'end_turn',
      usage: { input_tokens: 10, output_tokens: 4 },
    }
    if (envelope.stream) {
      res.setHeader('content-type', 'text/event-stream')
      res.write(
        `event: message_start\ndata: ${JSON.stringify({ type: 'message_start', message: { ...message, content: [], stop_reason: null } })}\n\n`,
      )
      res.write(
        `event: content_block_start\ndata: ${JSON.stringify({ type: 'content_block_start', index: 0, content_block: message.content[0] })}\n\n`,
      )
      res.write('event: content_block_stop\ndata: {"type":"content_block_stop","index":0}\n\n')
      res.write(
        'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":4}}\n\n',
      )
      res.write('event: message_stop\ndata: {"type":"message_stop"}\n\n')
    } else res.write(JSON.stringify(message))
    res.addTrailers({ 'X-Kernel-Timing': JSON.stringify(timing) })
    res.end()
  })
  fixture.listen(path.join(run, 'kernel.sock'))
  await once(fixture, 'listening')
  let gw,
    passed = false
  const start = () =>
    startGateway({
      project,
      env: {
        KIN_CRS_MOCK: '0',
        KIN_KERNEL_BIN: process.execPath,
        KIN_AUTO_SYNC_WRAP: '0',
        KIN_REQUEST_LOG_MODE: 'normal',
      },
    })
  try {
    gw = await start()
    for (const scenario of [
      'supported',
      'supported-stream',
      'undeclared',
      'wrong-request',
      'wrong-version',
      'invalid',
      'oversized',
    ]) {
      mode = scenario
      const response = await api(gw, 'POST', '/v1/messages', {
        body: {
          model: 'claude-haiku-4-5-20251001',
          max_tokens: 16,
          stream: scenario.endsWith('-stream'),
          messages: [{ role: 'user', content: 'TIMING_FIXTURE' }],
        },
      })
      check(`${scenario}:response`, response.status, 200)
      check(`${scenario}:private-header`, response.headers.get('x-kernel-request-timing'), null)
      const requestId = response.headers.get('x-request-id')
      let row
      for (let i = 0; i < 40; i++) {
        const logs = await api(gw, 'GET', '/api/panel/usage-logs?limit=100')
        row = logs.json.data.logs.find((item) => item.requestId === requestId)
        if (row) break
        await new Promise((resolve) => setTimeout(resolve, 50))
      }
      assert.ok(row, scenario)
      if (scenario.startsWith('supported')) {
        check(`${scenario}:stages`, row.kernelTiming?.timings_ms, {
          pool_wait: 0,
          context_check: 2.5,
          delivery: 30,
        })
        check(`${scenario}:missing-is-null`, row.kernelTiming?.upstream_timing?.first_content_ms, null)
        check(`${scenario}:identity-removed`, row.kernelTiming?.request_id, undefined)
        saved.push({ requestId, timing: row.kernelTiming })
      } else check(`${scenario}:hidden`, row.kernelTiming, null)
    }
    await gw.stop()
    gw = await start()
    const logs = await api(gw, 'GET', '/api/panel/usage-logs?limit=100')
    for (const item of saved)
      check(
        'restart:' + item.requestId,
        logs.json.data.logs.find((row) => row.requestId === item.requestId)?.kernelTiming,
        item.timing,
      )
    fs.writeFileSync(path.join(out, 'usage-logs.json'), JSON.stringify(logs.json, null, 2))
    if (process.env.KERNEL_TIMING_BROWSER === '1') {
      fs.mkdirSync(path.join(project, 'web'), { recursive: true })
      fs.symlinkSync(path.join(REPO_ROOT, 'web/dist'), path.join(project, 'web/dist'))
      const browser = spawn('ego-browser', ['nodejs'], {
        stdio: ['pipe', 'pipe', 'pipe'],
      })
      let output = ''
      browser.stdout.on('data', (data) => (output += data))
      browser.stderr.on('data', (data) => (output += data))
      browser.stdin.end(
        `globalThis.kernelTimingPage=${JSON.stringify({ url: gw.baseUrl, artifact: out })};\n` +
          fs.readFileSync(path.join(REPO_ROOT, 'test/fixtures/kernel-timing-page.mjs'), 'utf8'),
      )
      const [code] = await once(browser, 'exit')
      fs.writeFileSync(path.join(out, 'browser.log'), output)
      assert.equal(code, 0, output)
    }
    passed = true
  } finally {
    if (gw) await gw.stop()
    fixture.closeAllConnections()
    await new Promise((resolve) => fixture.close(resolve))
    fs.writeFileSync(
      path.join(out, 'summary.json'),
      JSON.stringify(
        {
          result: passed ? 'PASS' : 'FAIL',
          checks,
          boundary: '真实网关和持久化；内核响应由隔离 Unix socket 夹具生成',
          command: 'node --test test/e2e/kernel-timing.e2e.test.mjs',
        },
        null,
        2,
      ),
    )
    const sources = [
      'src/lib/protocol/kernel-timing.mjs',
      'src/lib/transport/go-worker-client.mjs',
      'src/lib/protocol/handle-protocol.mjs',
      'src/lib/admin/request-log.mjs',
      'src/lib/db/repos/usage-logs-repo.mjs',
      'src/lib/db/repos/usage-logs-view.mjs',
      'src/lib/db/migrations/055_usage_logs_kernel_timing.sql',
      'web/src/features/logs/log-detail/performance-tab.tsx',
      'web/src/types/panel-usage-logs.ts',
      'test/e2e/kernel-timing.e2e.test.mjs',
      'test/fixtures/kernel-timing-page.mjs',
    ]
    fs.writeFileSync(
      path.join(out, 'source-sha256.json'),
      JSON.stringify(
        {
          node: process.version,
          sources: Object.fromEntries(
            sources.map((file) => [
              file,
              createHash('sha256')
                .update(fs.readFileSync(path.join(REPO_ROOT, file)))
                .digest('hex'),
            ]),
          ),
        },
        null,
        2,
      ),
    )
    fs.rmSync(project, { recursive: true, force: true })
    console.log('内核耗时验收工件：' + out)
  }
})
