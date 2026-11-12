import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { startHermitReleaseOrigin } from '../fixtures/hermit-release-origin.mjs'
import { pullHermitPackage } from '../../src/lib/vm/hermit-release.mjs'

test('固定版本包安装拒绝其他源码，不跟随 latest', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-package-rollout-'))
  const out = path.resolve(process.env.ROLLOUT_PACKAGE_OUT || path.join('.tmp', path.basename(root)))
  fs.mkdirSync(out, { recursive: true })
  const origin = await startHermitReleaseOrigin(path.join(root, 'origin'))
  const previous = { test: process.env.KIN_KERNEL_TEST_ENDPOINTS, url: process.env.KIN_HERMIT_RELEASES_URL }
  process.env.KIN_KERNEL_TEST_ENDPOINTS = '1'
  process.env.KIN_HERMIT_RELEASES_URL = origin.url
  const checks = []
  let result = 'FAIL'
  try {
    const metadata = await fetch(origin.url + '/v1/releases/latest').then((r) => r.json())
    origin.requests.length = 0
    let rejected = false
    try {
      await pullHermitPackage(path.join(root, 'group'), { version: metadata.version, commit: 'f'.repeat(40) })
    } catch {
      rejected = true
    }
    checks.push({ name: 'wrong_source_rejected', result: rejected ? 'PASS' : 'FAIL' })
    assert.ok(rejected)
    const installed = await pullHermitPackage(path.join(root, 'group'), {
      version: metadata.version,
      commit: metadata.commit,
    })
    checks.push({ name: 'fixed_package_installed', result: installed.version === metadata.version ? 'PASS' : 'FAIL' })
    assert.equal(installed.version, metadata.version)
    checks.push({
      name: 'latest_not_read',
      result: origin.requests.every((r) => !r.path.includes('/latest')) ? 'PASS' : 'FAIL',
    })
    assert.ok(origin.requests.every((r) => !r.path.includes('/latest')))
    result = 'PASS'
  } finally {
    await origin.close()
    for (const [key, value] of [
      ['KIN_KERNEL_TEST_ENDPOINTS', previous.test],
      ['KIN_HERMIT_RELEASES_URL', previous.url],
    ]) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
    fs.writeFileSync(
      path.join(out, 'summary.json'),
      JSON.stringify(
        { result, checks, boundary: '真实 HTTP 下载与 Python 包安装器；合成载荷，不执行 Linux CLI' },
        null,
        2,
      ),
    )
    fs.rmSync(root, { recursive: true, force: true })
  }
})
