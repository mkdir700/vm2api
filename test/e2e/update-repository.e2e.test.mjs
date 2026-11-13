import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { REPO_ROOT, startGateway, api } from '../harness.mjs'

// Exercise the real HTTP route. Replace only GitHub transport in the child process.
// Failures covered: upstream lookup, wrong public links, stale installer command,
// and the separate managed-runtime response bypassing the canonical repository.
test('panel update checks and managed links use the fork repository', async () => {
  const repo = 'true-router/vm2api'
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'vm2api-update-repo-'))
  const requests = path.join(temp, 'requests.jsonl')
  const preload = path.join(temp, 'github-fixture.mjs')
  const report = { repository: repo, transport: 'GitHub fixture; real gateway HTTP', responses: [] }
  const artifact = path.join(REPO_ROOT, '.tmp', 'update-repository-e2e.json')
  fs.writeFileSync(
    preload,
    `
import fs from 'node:fs'
const original = globalThis.fetch
 globalThis.fetch = async (input, options) => {
  const url = String(input)
  if (!url.startsWith('https://api.github.com/repos/')) return original(input, options)
  fs.appendFileSync(${JSON.stringify(requests)}, JSON.stringify(url) + '\\n')
  return Response.json({ tag_name: 'v99.0.0', body: 'Release fixture' })
}
`,
  )
  try {
    for (const runtime of ['', 'hermit']) {
      const gw = await startGateway({
        env: {
          VM2API_SLOT_RUNTIME: runtime,
          NODE_OPTIONS: `--import=${pathToFileURL(preload).href}`,
        },
      })
      try {
        const response = await api(gw, 'GET', '/api/panel/version')
        const data = response.json?.data || response.json
        report.responses.push({ runtime: runtime || 'standard', status: response.status, data })
        assert.equal(response.status, 200, response.text)
        assert.equal(data.repo, repo)
        assert.ok(data.html_url.startsWith(`https://github.com/${repo}`), data.html_url)
        if (runtime === 'hermit') {
          assert.equal(data.check_status, 'managed')
          assert.equal(data.upgrade_command, '')
        } else {
          assert.equal(data.check_status, 'ok')
          assert.equal(data.latest, '99.0.0')
          assert.ok(data.upgrade_command.includes(`https://raw.githubusercontent.com/${repo}/main/deploy/install.sh`))
        }
      } finally {
        await gw.stop()
        fs.rmSync(gw.project, { recursive: true, force: true })
      }
    }
    report.requests = fs.readFileSync(requests, 'utf8').trim().split('\n').map(JSON.parse)
    assert.deepEqual(report.requests, [`https://api.github.com/repos/${repo}/releases/latest`])
    report.result = 'passed'
  } catch (error) {
    report.result = 'failed'
    report.error = error.message
    throw error
  } finally {
    fs.mkdirSync(path.dirname(artifact), { recursive: true })
    fs.writeFileSync(artifact, JSON.stringify(report, null, 2) + '\n')
    fs.rmSync(temp, { recursive: true, force: true })
    console.log(`Evidence: ${artifact}`)
  }
})
