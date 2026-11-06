#!/usr/bin/env node
// Check recorded provenance only. This does not execute functional acceptance.
import { createHash } from 'node:crypto'
import { readFile, writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const root = fileURLToPath(new URL('../', import.meta.url))
const dir = path.join(root, '.tmp/managed-egress-e2e')
const names = [
  'receipt.json', 'api-receipt.json', 'admission-receipt.json',
  'probe-receipt.json', 'helper-receipt.json', 'remote-endpoint-receipt.json',
  'package-receipt.json', 'linux-receipt.json', 'compose-receipt.json',
  'independent-host-receipt.json', 'public-remote-receipt.json',
  'image-upgrade-receipt.json', 'installer-receipt.json', 'host-reboot-receipt.json',
]
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex')
const receipts = []
const problems = []
for (const name of names) {
  try {
    const bytes = await readFile(path.join(dir, name))
    const record = JSON.parse(bytes)
    const files = Object.entries(record.source_files || {})
    if (!files.length) throw new Error('missing_source_inventory')
    if (record.status && record.status !== 'PASS') throw new Error('nonpassing_receipt')
    for (const [file, expected] of files) {
      const resolved = path.resolve(root, file)
      if (!resolved.startsWith(root) || !/^[a-f0-9]{64}$/.test(expected)) {
        problems.push({ receipt: name, file, reason: 'invalid_source_entry' })
        continue
      }
      try {
        if (hash(await readFile(resolved)) !== expected) {
          problems.push({ receipt: name, file, reason: 'source_mismatch' })
        }
      } catch {
        problems.push({ receipt: name, file, reason: 'source_unreadable' })
      }
    }
    receipts.push({ name, sha256: hash(bytes), source_entries: files.length })
  } catch {
    problems.push({ receipt: name, reason: 'receipt_missing_or_invalid' })
  }
}
const links = []
for (const [host, field, target] of [
  ['installer-host-receipt.json', 'installer_receipt_sha256', 'installer-receipt.json'],
  ['remote-factory-host-receipt.json', 'public_receipt_sha256', 'public-remote-receipt.json'],
  ['remote-factory-host-receipt.json', 'host_reboot_receipt_sha256', 'host-reboot-receipt.json'],
]) {
  try {
    const bytes = await readFile(path.join(dir, host))
    const record = JSON.parse(bytes)
    const matched = record.status === 'PASS' && receipts.some((r) => r.name === target && r.sha256 === record[field])
    links.push({ name: host, sha256: hash(bytes), target, matched })
    if (!matched) problems.push({ receipt: host, reason: 'linked_receipt_mismatch' })
  } catch {
    problems.push({ receipt: host, reason: 'host_receipt_missing_or_invalid' })
  }
}
const artifact = {
  command: 'node scripts/verify-managed-egress-receipts.mjs',
  scope: 'Recorded source hashes and linked receipts only; no functional test or full dependency audit.',
  provenance_status: problems.length ? 'FAIL' : 'MATCH',
  adr_achieved: false,
  remaining_gates: ['real_provider_and_claude_requests', 'user_visual_acceptance'],
  runtime_receipts: receipts.length,
  source_entries: receipts.reduce((sum, r) => sum + r.source_entries, 0),
  receipts, links, problems,
}
await writeFile(path.join(dir, 'completion-audit.json'), `${JSON.stringify(artifact, null, 2)}\n`)
console.log(JSON.stringify({ provenance_status: artifact.provenance_status, runtime_receipts: artifact.runtime_receipts, source_entries: artifact.source_entries, problems }))
if (problems.length) process.exitCode = 1
