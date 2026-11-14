import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'

// Refuse a skipped qualification: this command requires actual native assets.
const out = path.resolve(process.env.HERMIT_PREWARM_OUT || `.tmp/cache-native-${Date.now()}`)
fs.mkdirSync(out, { recursive: true })
const required = ['HERMIT_PREWARM_ARCHIVE', 'HERMIT_PREWARM_RECEIPT', 'HERMIT_PREWARM_CLI', 'HERMIT_PREWARM_API_KERNEL']
const missing = required.filter((name) => !process.env[name] || !fs.existsSync(process.env[name]))
let status = 1
let reason
if (process.platform !== 'linux') reason = 'Native package qualification requires Linux.'
else if (missing.length) reason = `Missing qualification inputs: ${missing.join(', ')}`
else {
  const result = spawnSync(process.execPath, ['--test', 'test/e2e/hermit-prewarm.e2e.test.mjs'], {
    stdio: 'inherit',
    env: { ...process.env, HERMIT_PREWARM_OUT: out },
  })
  status = result.status ?? 1
  let receipt
  try {
    receipt = JSON.parse(fs.readFileSync(path.join(out, 'summary.json')))
  } catch {}
  if (receipt?.result !== 'PASS' || !receipt.checks?.length) {
    status = 1
    reason = 'Native acceptance receipt is absent or failed.'
  }
}
fs.writeFileSync(
  path.join(out, 'runner.json'),
  JSON.stringify({ result: status === 0 ? 'PASS' : 'FAIL', reason, real_provider: 'NOT RUN' }, null, 2) + '\n',
)
if (reason) console.error(reason)
process.exit(status)
