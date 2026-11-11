import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { WebSocketServer } from 'ws'

// Failure inventory: responsive dialog max-width squeezes the terminal; grid
// children overflow; mobile controls become unreachable; xterm fails to refit.
// Run: node --test test/e2e/login-dialog-layout.e2e.test.mjs
test('official login dialog fits desktop and mobile viewports', { timeout: 90000 }, async () => {
  const root = path.resolve(import.meta.dirname, '../..')
  const artifact = path.resolve(process.env.LOGIN_LAYOUT_E2E_OUT || path.join(root, '.tmp/login-dialog-layout'))
  fs.mkdirSync(artifact, { recursive: true })
  const requireWeb = createRequire(path.join(root, 'web/package.json'))
  const load = (name) => import(pathToFileURL(requireWeb.resolve(name)).href)
  const { createServer } = await load('vite')
  const { default: react } = await load('@vitejs/plugin-react')
  const { default: tailwind } = await load('@tailwindcss/vite')
  const authUrl = 'https://claude.com/cai/oauth/authorize?code_challenge=' + 'a'.repeat(100) + '&state=layout-e2e'
  const vite = await createServer({
    root: path.join(root, 'web'), configFile: false,
    resolve: { alias: { '@': path.join(root, 'web/src') } },
    plugins: [react(), tailwind(), {
      name: 'login-layout-fixture',
      resolveId(id) { if (id === '/__layout.tsx') return '\0login-layout.mjs' },
      load(id) {
        if (id !== '\0login-layout.mjs') return
        return `import React from 'react';
          import { createRoot } from 'react-dom/client';
          import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
          import { CredentialPanel } from '@/features/vm/credential-panel';
          import '@/styles/index.css';
          localStorage.setItem('kin_console_token', 'synthetic-layout-session');
          createRoot(document.getElementById('root')).render(
            React.createElement(QueryClientProvider, { client: new QueryClient() },
              React.createElement(CredentialPanel, { showConvert: false, vm: { id: 'layout', status: 'running', can_import_credential: true } })));`
      },
      configureServer(server) {
        server.middlewares.use(async (req, res, next) => {
          if (req.url === '/__layout') {
            res.setHeader('content-type', 'text/html')
            res.end(await server.transformIndexHtml(req.url, '<html><body><div id="root"></div><script type="module" src="/__layout.tsx"></script></body></html>'))
          } else if (req.url === '/api/panel/vms/layout/shell-ticket') {
            res.setHeader('content-type', 'application/json')
            res.end(JSON.stringify({ data: { ticket: 'synthetic-layout' } }))
          } else next()
        })
      },
    }], server: { host: '127.0.0.1', port: 0 },
  })
  const wss = new WebSocketServer({ noServer: true })
  wss.on('connection', (socket) => socket.send(Buffer.from('claude auth login\r\n' + authUrl + '\r\nPaste code#state: ')))
  vite.httpServer.on('upgrade', (req, socket, head) => {
    if (req.url.startsWith('/api/panel/vms/layout/shell?')) wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws))
  })
  await vite.listen()
  try {
    const browser = spawn('ego-browser', ['nodejs'], { stdio: ['pipe', 'pipe', 'pipe'] })
    let output = ''
    browser.stdout.on('data', (data) => { output += data })
    browser.stderr.on('data', (data) => { output += data })
    browser.stdin.end(`const config = ${JSON.stringify({ url: `http://127.0.0.1:${vite.httpServer.address().port}/__layout`, artifact, authUrl })};\n(${browserCheck.toString()})();`)
    const [code] = await once(browser, 'exit')
    fs.writeFileSync(path.join(artifact, 'browser.log'), output)
    assert.equal(code, 0, output)
    console.log('Login dialog layout evidence: ' + artifact)
  } finally {
    for (const socket of wss.clients) socket.terminate()
    wss.close()
    await vite.close()
  }
})

async function browserCheck() {
  const fs = await import('node:fs/promises')
  const task = await taskSpace('Claude 登录弹窗布局验证')
  const page = task.page('p1')
  const checks = []
  try {
    await page.cdp('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false })
    await page.goto(config.url)
    await fs.writeFile(config.artifact + "/initial-page.txt", await page.snapshot())
    await page.click("loc=role:tab[name='OAuth']")
    await page.click("loc=role:tab[name='Claude Code']")
    await page.click("loc=role:button[name='打开官方登录终端']")
    await page.waitForFunction(() => document.querySelector('input[aria-label="Claude Code 授权链接"]')?.value.includes('layout-e2e'), undefined, { timeout: 10000 })
    for (const [width, height] of [[1440, 900], [1024, 768], [768, 900], [390, 844]]) {
      await page.cdp('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false })
      await page.evaluate(async () => {
        const dialog = document.querySelector('[role="dialog"]')
        await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))
        await Promise.all(dialog.getAnimations().map(animation => animation.finished.catch(() => {})))
        await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))
      })
      const metrics = await page.evaluate(() => {
        const dialog = document.querySelector('[role="dialog"]')
        const terminal = dialog.querySelector('section')
        const aside = dialog.querySelector('aside')
        const rect = dialog.getBoundingClientRect()
        const t = terminal.getBoundingClientRect()
        const a = aside.getBoundingClientRect()
        return { viewport: innerWidth, dialog: rect.width, terminal: t.width, maxWidth: getComputedStyle(dialog).maxWidth,
          fits: rect.left >= 0 && rect.right <= innerWidth && rect.top >= 0 && rect.bottom <= innerHeight,
          noOverflow: dialog.scrollWidth <= dialog.clientWidth && terminal.scrollWidth <= terminal.clientWidth && aside.scrollWidth <= aside.clientWidth,
          stacked: a.top >= t.bottom - 1, terminalColumns: terminal.querySelector('.xterm-screen')?.clientWidth }
      })
      metrics.pass = metrics.fits && metrics.noOverflow && metrics.dialog >= width - 34 &&
        (width >= 1024 ? metrics.terminal >= 550 && !metrics.stacked : metrics.stacked)
      checks.push(metrics)
      await page.screenshot({ path: config.artifact + '/' + width + '.png' })
    }
    await page.fill('#login-auth-code', 'synthetic-code#layout-e2e')
    await page.click("loc=role:button[name='回填到终端']")
    const cleared = await page.evaluate(() => document.querySelector('#login-auth-code').value === '')
    checks.push({ callbackControlReachable: cleared, pass: cleared })
    if (checks.some(check => !check.pass)) throw new Error('Layout assertion failed: ' + JSON.stringify(checks))
    await task.finish({ keep: [] })
  } finally {
    await fs.writeFile(config.artifact + '/checks.json', JSON.stringify(checks, null, 2))
  }
}
