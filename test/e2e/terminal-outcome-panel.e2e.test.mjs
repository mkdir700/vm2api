import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import { DatabaseSync } from 'node:sqlite'
import { startGateway, api, REPO_ROOT } from '../harness.mjs'

// Failure inventory: an already committed 200 can end incomplete or unknown;
// logs must retain the HTTP status while the real status badge shows failure.
// Exercise gateway -> SQLite -> panel API -> actual React status component.
test('committed HTTP 200 with failed terminal state is visibly failed in the panel', async () => {
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'vm2api-terminal-panel-'))
  const web = path.join(REPO_ROOT, 'web')
  const requireWeb = createRequire(path.join(web, 'package.json'))
  const { createServer } = await import(pathToFileURL(requireWeb.resolve('vite')).href)
  const { default: react } = await import(pathToFileURL(requireWeb.resolve('@vitejs/plugin-react')).href)
  const React = requireWeb('react')
  const { renderToStaticMarkup } = requireWeb('react-dom/server')
  const vite = await createServer({
    root: web,
    configFile: false,
    plugins: [react()],
    resolve: { alias: { '@': path.join(web, 'src') } },
    server: { middlewareMode: true },
    appType: 'custom',
    ssr: { noExternal: ['@lobehub/icons', '@lobehub/ui'] },
  })
  const gw = await startGateway({
    scenario: 'incomplete_stream',
    env: {
      KIN_REQUEST_LOG_MODE: 'normal',
      KIN_KERNEL_BIN: process.execPath,
      KIN_MOCK_ACCOUNT_SCENARIOS: JSON.stringify({ 'vm-sim-01': 'incomplete_stream' }),
    },
  })
  const checks = []
  try {
    const { StatusBadge } = await vite.ssrLoadModule('/src/features/logs/log-cells.tsx')
    const { TooltipProvider } = await vite.ssrLoadModule('/src/components/ui/tooltip.tsx')
    const response = await fetch(gw.baseUrl + '/v1/messages', {
      method: 'POST',
      headers: { authorization: `Bearer ${gw.apiKey}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        stream: true,
        max_tokens: 16,
        messages: [{ role: 'user', content: 'SYNTHETIC_INCOMPLETE_STREAM' }],
      }),
    })
    if (response.status !== 200) {
      const body = await response.text()
      fs.writeFileSync(path.join(out, 'unexpected-response.txt'), body)
      throw new Error('unexpected HTTP ' + response.status + ': ' + body)
    }
    const requestId = response.headers.get('x-request-id')
    fs.writeFileSync(path.join(out, 'stream.txt'), await response.text())
    await new Promise((r) => setTimeout(r, 100))
    const render = async (name) => {
      const result = await api(gw, 'GET', '/api/panel/usage-logs?limit=20')
      assert.equal(result.status, 200, result.text)
      fs.writeFileSync(path.join(out, name + '-api.json'), JSON.stringify(result.json, null, 2))
      const row = result.json.data.logs.find((r) => r.requestId === requestId)
      assert.ok(row, 'the actual panel row must exist')
      assert.equal(row.statusCode, 200, 'HTTP transport status must be preserved')
      assert.equal(row.finalState, name === 'incomplete' ? 'incomplete' : 'unknown')
      const html = renderToStaticMarkup(
        React.createElement(
          TooltipProvider,
          null,
          React.createElement(StatusBadge, {
            statusCode: row.statusCode,
            finalState: row.finalState,
            errorCode: row.errorCode,
          }),
        ),
      )
      fs.writeFileSync(path.join(out, name + '.html'), html)
      assert.match(html, /200/)
      assert.match(html, /失败/, 'a failed committed response must not display only a successful 200')
      assert.doesNotMatch(html, /bg-green-100/)
      checks.push({ case: name, status: row.statusCode, terminal: row.finalState, result: 'PASS' })
    }
    await render('incomplete')
    // Reproduce the exact persisted production combination without contacting production.
    const db = new DatabaseSync(path.join(gw.project, 'data', 'kin.db'))
    db.prepare('UPDATE usage_logs SET final_state=?, error_code=? WHERE request_id=?').run(
      'unknown',
      'worker_timeout',
      requestId,
    )
    db.close()
    await render('unknown-timeout')
    const control = await startGateway({ env: { KIN_REQUEST_LOG_MODE: 'normal', KIN_KERNEL_BIN: process.execPath } })
    try {
      const success = await api(control, 'POST', '/v1/messages', {
        body: {
          model: 'claude-haiku-4-5-20251001',
          max_tokens: 16,
          messages: [{ role: 'user', content: 'SYNTHETIC_VERIFIED_CONTROL' }],
        },
      })
      assert.equal(success.status, 200, success.text)
      await new Promise((r) => setTimeout(r, 100))
      const result = await api(control, 'GET', '/api/panel/usage-logs?limit=20')
      const row = result.json.data.logs.find((r) => r.requestId === success.headers.get('x-request-id'))
      assert.equal(row.finalState, 'verified')
      const html = renderToStaticMarkup(
        React.createElement(
          TooltipProvider,
          null,
          React.createElement(StatusBadge, {
            statusCode: row.statusCode,
            finalState: row.finalState,
            errorCode: row.errorCode,
          }),
        ),
      )
      fs.writeFileSync(path.join(out, 'verified.html'), html)
      assert.match(html, /bg-green-100/)
      assert.doesNotMatch(html, /失败/)
      checks.push({ case: 'verified-control', status: row.statusCode, terminal: row.finalState, result: 'PASS' })
    } finally {
      await control.stop()
    }
    fs.writeFileSync(path.join(out, 'summary.json'), JSON.stringify({ result: 'PASS', checks }, null, 2))
  } catch (error) {
    fs.writeFileSync(
      path.join(out, 'summary.json'),
      JSON.stringify({ result: 'FAIL', checks, error: error.message }, null, 2),
    )
    throw error
  } finally {
    await gw.stop()
    await vite.close()
    console.log('terminal outcome evidence: ' + out)
  }
})
