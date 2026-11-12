import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'
import { execFileSync } from 'node:child_process'
import { parseArgs } from 'node:util'
import { createDatabase } from '../src/lib/db/database.mjs'

const { values } = parseArgs({ options: { source: { type: 'string' }, target: { type: 'string' }, 'stopped-container': { type: 'string' }, receipt: { type: 'string' }, apply: { type: 'boolean', default: false } } })
const source = path.resolve(values.source), target = path.resolve(values.target)
if (target === path.dirname(source) || target.startsWith(path.dirname(source) + path.sep) || fs.existsSync(target)) throw new Error('New independent authority directory required')
const db = new DatabaseSync(source, { readOnly: true })
const tables = ['users', 'groups', 'vm_pools', 'vm_pool_members', 'api_keys']
if (!values.apply) { console.log(JSON.stringify({ mode: 'PLAN', tables: Object.fromEntries(tables.map(t => [t, db.prepare(`SELECT count(*) n FROM ${t}`).get().n])) })); db.close(); process.exit(0) }
if (!values['stopped-container'] || !values.receipt) throw new Error('Stopped controller and private receipt required')
const docker = process.env.KIN_DOCKER_BIN || 'docker'
const owner = JSON.parse(execFileSync(docker, ['inspect', values['stopped-container']], { encoding: 'utf8' }))[0]
const owns = record => record.Mounts?.some(m => m.Destination === '/opt/vm2api/data' && path.resolve(m.Source) === path.dirname(source))
if (owner.State?.Running !== false || !owns(owner)) throw new Error('Source controller must be stopped')
const running = execFileSync(docker, ['ps', '-q'], { encoding: 'utf8' }).trim().split(/\s+/).filter(Boolean)
if (running.length && JSON.parse(execFileSync(docker, ['inspect', ...running], { encoding: 'utf8' })).some(owns)) throw new Error('Source state still has a running owner')
fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 })
const temporary = fs.mkdtempSync(path.join(path.dirname(target), '.authority-import-'))
let output
try {
  output = createDatabase({ dataDir: temporary })
  db.exec('BEGIN')
  const rows = {}, columns = {}
  for (const table of tables) {
    columns[table] = db.prepare(`PRAGMA table_info(${table})`).all().map(c => c.name)
    const expected = output.prepare(`PRAGMA table_info(${table})`).all().map(c => c.name)
    if (JSON.stringify(columns[table]) !== JSON.stringify(expected)) throw new Error('Identity schema mismatch: ' + table)
    rows[table] = db.prepare(`SELECT * FROM ${table}`).all()
  }
  output.exec('PRAGMA foreign_keys=OFF; BEGIN IMMEDIATE')
  for (const table of [...tables].reverse()) output.prepare(`DELETE FROM ${table}`).run()
  for (const table of tables) {
    const keys = columns[table], insert = output.prepare(`INSERT INTO ${table}(${keys.map(k => `"${k}"`).join(',')}) VALUES(${keys.map(() => '?').join(',')})`)
    for (const row of rows[table]) insert.run(...keys.map(k => row[k]))
  }
  if (output.prepare('PRAGMA foreign_key_check').all().length) throw new Error('Imported foreign key check failed')
  output.exec('COMMIT; PRAGMA foreign_keys=ON; PRAGMA wal_checkpoint(TRUNCATE)')
  output.close(); output = null
  db.exec('COMMIT'); db.close()
  if (fs.existsSync(target)) throw new Error('Authority target changed during import')
  fs.renameSync(temporary, target)
  const receipt = { result: 'PASS', source_container: owner.Id, copied: Object.fromEntries(tables.map(t => [t, rows[t].length])), authority_sha256: crypto.createHash('sha256').update(fs.readFileSync(path.join(target, 'kin.db'))).digest('hex'), credentials: 'Only existing API key identity records preserved; provider state and settings excluded' }
  fs.writeFileSync(values.receipt, JSON.stringify(receipt, null, 2), { mode: 0o600 })
  console.log(JSON.stringify({ result: 'PASS', copied_tables: tables.length }))
} finally {
  try { output?.close() } catch {}
  try { db.close() } catch {}
  fs.rmSync(temporary, { recursive: true, force: true })
}
