import fs from 'node:fs'
import path from 'node:path'
import http from 'node:http'
import { once } from 'node:events'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { REPO_ROOT } from '../harness.mjs'

const sha = (value) => createHash('sha256').update(value).digest('hex')

export async function startHermitReleaseOrigin(directory) {
  fs.mkdirSync(directory, { recursive: true })
  const requests = []
  let mode = 'normal'
  let base, archive, receipt
  const version = '0.2.0-ui-e2e'
  const fixed = `/v1/releases/${version}`
  const cli = Buffer.alloc(4096)
  Buffer.from([0x7f, 0x45, 0x4c, 0x46, 2, 1]).copy(cli)
  cli.writeUInt16LE(2, 16)
  cli.writeUInt16LE(62, 18)
  const server = http.createServer(async (req, res) => {
    requests.push({ path: req.url, authorization: Boolean(req.headers.authorization) })
    if (req.url === '/fixture/mode' && req.method === 'POST') {
      let raw = ''
      for await (const part of req) raw += part
      mode = JSON.parse(raw).mode
      return res.end('{}')
    }
    if (req.url === '/cli') return res.end(cli)
    let current = structuredClone(receipt)
    let payload = archive
    if (mode === 'receipt-identity') current.version = '9.9.9'
    if (mode === 'manifest-hash') current.manifest_sha256 = '0'.repeat(64)
    if (mode === 'invalid-package') {
      payload = Buffer.from(archive)
      payload[0] ^= 1
      current.archive.sha256 = sha(payload)
    }
    const raw = Buffer.from(JSON.stringify(current))
    const latest = {
      schema_version: 1, version, target: 'linux-amd64', commit: 'a'.repeat(40),
      release_url: base + fixed + '/release.json', manifest_url: base + fixed + '/manifest.json',
      download_url: base + fixed + '/download', archive: structuredClone(current.archive),
      manifest_sha256: current.manifest_sha256, release_sha256: sha(raw),
    }
    if (mode === 'unsafe-url') latest.download_url = base + '/forbidden'
    if (mode === 'other-origin') latest.download_url = 'http://localhost:1/private'
    if (mode === 'wrong-target') latest.target = 'darwin-arm64'
    if (mode === 'too-large') latest.archive.bytes = 64 * 1024 * 1024 + 1
    if (mode === 'release-hash') latest.release_sha256 = '0'.repeat(64)
    if (mode === 'huge-metadata') latest.padding = 'x'.repeat(70000)
    if (req.url === '/v1/releases/latest') {
      if (mode === 'unavailable') { res.writeHead(503); return res.end('{}') }
      if (mode === 'redirect') { res.writeHead(302, { location: base + '/forbidden' }); return res.end() }
      res.setHeader('Content-Type', 'application/json')
      return res.end(JSON.stringify(latest))
    }
    if (req.url === fixed + '/release.json') return res.end(raw)
    if (req.url === fixed + '/download') {
      if (mode === 'delay') await new Promise((resolve) => setTimeout(resolve, 1000))
      if (mode === 'corrupt') { payload = Buffer.from(payload); payload[0] ^= 1 }
      if (mode === 'short') payload = payload.subarray(0, payload.length - 1)
      if (mode === 'oversized-stream') payload = Buffer.concat([payload, Buffer.alloc(4096)])
      if (mode === 'oversized-header') res.setHeader('Content-Length', String(64 * 1024 * 1024 + 1))
      return res.end(payload)
    }
    res.writeHead(404)
    res.end('{}')
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  base = `http://127.0.0.1:${server.address().port}`
  execFileSync('python3', [path.join(REPO_ROOT, 'test/fixtures/hermit-page-package.py'), directory, base + '/cli', sha(cli), 'production'])
  archive = fs.readFileSync(path.join(directory, 'package.tar.gz'))
  const minimal = JSON.parse(fs.readFileSync(path.join(directory, 'release.json')))
  receipt = { schema_version: 1, version, target: 'linux-amd64', activated: false, ...minimal,
    archive: { ...minimal.archive, name: `hermit-${version}-linux-amd64.tar.gz` } }
  return { url: base, version, receipt, requests, setMode(value) { mode = value },
    async close() { server.closeAllConnections(); await new Promise((resolve) => server.close(resolve)) } }
}
