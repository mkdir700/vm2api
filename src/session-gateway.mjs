import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'
import { RolloutState } from './lib/rollout/state.mjs'
import { claudeCodeAgentRootSession, extractCallerSession } from './lib/identity/identity-rewrite.mjs'
import {
  readSecret,
  equal,
  sign,
  digest,
  readJson,
  cleanHeaders,
  control,
  send,
  failure,
} from './lib/rollout/protocol.mjs'

const directory = process.env.KIN_ROLLOUT_STATE
if (!directory || !path.isAbsolute(directory)) throw failure('absolute_state_directory_required', 500)
fs.mkdirSync(directory, { recursive: true, mode: 0o700 })
const secret = readSecret(process.env.KIN_ROLLOUT_SECRET_FILE)
const state = new RolloutState(directory)
const master = process.env.KIN_API_KEY || process.env.VM2API_API_KEY || ''
const activeResponses = new Set()
const instance = process.env.KIN_ROLLOUT_INSTANCE || `gateway-${process.pid}`
let closing = false
let stopping = false,
  publicClosed = false,
  adminClosed = false
async function reconcile(id) {
  const row = state.db.prepare('SELECT group_id FROM rollout_requests WHERE id=?').get(id)
  const group = row && state.group(row.group_id)
  if (!group) return
  try {
    state.settle(id, await control(group, secret, `results/${encodeURIComponent(id)}`))
  } catch {}
}
let reconciling = false,
  probeCursor = 0
const timer = setInterval(async () => {
  if (reconciling) return
  reconciling = true
  try {
    const pending = state.pending()
    if (!pending.length) {
      probeCursor = 0
      return
    }
    probeCursor %= pending.length
    const batch = [...pending.slice(probeCursor), ...pending.slice(0, probeCursor)].slice(0, 100)
    probeCursor += batch.length
    await Promise.allSettled(batch.map((row) => reconcile(row.id)))
  } finally {
    reconciling = false
  }
}, 1000)
timer.unref()

const handle = async (req, res) => {
  try {
    const route = new URL(req.url, 'http://localhost').pathname
    if (route === '/health')
      return send(res, closing ? 503 : 200, { status: closing ? 'draining' : 'ok', role: 'session-gateway' })
    if (route.startsWith('/_rollout/')) {
      if (!equal(req.headers.authorization, `Bearer ${secret}`)) throw failure('unauthorized', 401)
      if (req.method === 'GET' && route === '/_rollout/gateway/status') return send(res, 200, gatewayStatus())
      if (req.method === 'POST' && route === '/_rollout/gateway/drain') {
        const body = (await readJson(req, 65536)).body
        if (body.instance !== instance) throw failure('gateway_instance_mismatch')
        beginDrain()
        return send(res, 200, gatewayStatus())
      }
      if (req.method === 'GET' && route === '/_rollout/snapshot') return send(res, 200, state.snapshot())
      if (req.method === 'GET' && route.startsWith('/_rollout/drain/')) {
        const id = route.split('/').pop(),
          group = state.group(id)
        if (!group) throw failure('group_not_found', 404)
        await Promise.allSettled(
          state
            .pending(id)
            .slice(0, 100)
            .map((row) => reconcile(row.id)),
        )
        let proof
        try {
          proof = await control(group, secret, 'status')
        } catch {}
        return send(res, 200, state.drain(id, proof))
      }
      if (req.method === 'POST' && route === '/_rollout/groups')
        return send(res, 200, state.register((await readJson(req, 65536)).body))
      if (req.method === 'POST' && route === '/_rollout/policy') {
        const body = (await readJson(req, 65536)).body,
          group = state.group(body.target)
        if (!group) throw failure('group_not_found', 404)
        const proof = await control(group, secret, 'status')
        if (
          proof.schema !== 1 ||
          proof.ready !== true ||
          proof.group !== group.id ||
          proof.instance !== group.instance ||
          JSON.stringify([...(proof.inventory?.accounts || [])].sort()) !==
            JSON.stringify([...group.resources.accounts].sort())
        )
          throw failure('candidate_not_ready', 503)
        return send(res, 200, state.promote(body.expected_generation, body.target))
      }
      if (req.method === 'POST' && route === '/_rollout/retire') {
        const body = (await readJson(req, 65536)).body,
          group = state.group(body.group)
        if (!group) throw failure('group_not_found', 404)
        return send(
          res,
          200,
          state.retire(body.expected_generation, body.group, await control(group, secret, 'status')),
        )
      }
      if (route === '/_rollout/keys' && req.method === 'GET') return send(res, 200, state.keys.list())
      if (route === '/_rollout/keys' && req.method === 'POST')
        return send(res, 200, state.keys.create((await readJson(req, 65536)).body))
      throw failure('not_found', 404)
    }
    if (closing) throw failure('gateway_draining', 503)
    const billable = route === '/v1/messages'
    if (
      req.url !== route ||
      !(
        (req.method === 'POST' && ['/v1/messages', '/v1/messages/count_tokens'].includes(route)) ||
        (req.method === 'GET' && route === '/v1/models')
      )
    )
      throw failure('protocol_not_qualified', 404)
    const tracked = Symbol()
    activeResponses.add(tracked)
    const release = () => {
      activeResponses.delete(tracked)
      if (closing) setImmediate(() => server.closeIdleConnections())
    }
    res.once('finish', release)
    res.once('close', release)
    const token =
      String(req.headers.authorization || '').replace(/^Bearer\s+/i, '') || String(req.headers['x-api-key'] || '')
    const authenticated = state.keys.authenticate(token)
    const isMaster = !!master && equal(master, token)
    if (!authenticated.ok && !isMaster) throw failure('invalid_api_key', 401)
    const record = authenticated.ok ? authenticated.record : null
    const principal = record ? `key:${record.id}` : 'master'
    const { raw, body } = req.method === 'POST' ? await readJson(req) : { raw: Buffer.alloc(0), body: {} }
    if (billable && (!Array.isArray(body.messages) || !body.messages.length))
      throw failure('full_history_required', 400)
    const session =
      claudeCodeAgentRootSession({ body, headers: req.headers }) || extractCallerSession({ body, headers: req.headers })
    const admitted = state.admit(
      principal,
      record,
      session,
      session && Array.isArray(body.messages) ? 'anthropic-full-history-v1' : 'conservative',
      billable,
    )
    const { requestId, group } = admitted
    const claim = {
      request_id: requestId,
      group: group.id,
      instance: group.instance,
      generation: admitted.generation,
      key_id: record?.id || null,
      master: isMaster,
      method: req.method,
      path: req.url,
      body_sha256: digest(raw),
      expires: Date.now() + 60000,
      billable,
    }
    const headers = {
      ...cleanHeaders(req.headers),
      'content-length': raw.length,
      'x-request-id': requestId,
      'x-kin-rollout-admission': sign(secret, claim),
    }
    state.sent(requestId)
    const upstream = http.request(group.url + req.url, { method: req.method, headers }, (response) => {
      res.writeHead(response.statusCode, cleanHeaders(response.headers))
      response.pipe(res)
      response.once('end', () => {
        void reconcile(requestId)
      })
      response.once('error', () => {
        if (!res.destroyed) res.destroy()
        void reconcile(requestId)
      })
    })
    upstream.once('error', () => {
      send(res, 502, { error: { code: 'execution_outcome_unknown', request_id: requestId } })
      void reconcile(requestId)
    })
    res.once('close', () => {
      if (!res.writableFinished) upstream.destroy()
      void reconcile(requestId)
    })
    upstream.end(raw)
  } catch (error) {
    send(res, error.status || 500, { error: { code: error.code || 'internal_error' } })
  }
}
const server = http.createServer(handle)
const adminServer = process.env.KIN_ROLLOUT_ADMIN_PORT !== undefined ? http.createServer(handle) : null
adminClosed = !adminServer
if (adminServer)
  await new Promise((resolve, reject) => {
    adminServer.once('error', reject)
    adminServer.listen(Number(process.env.KIN_ROLLOUT_ADMIN_PORT), '127.0.0.1', resolve)
  })
await new Promise((resolve, reject) => {
  server.once('error', reject)
  server.listen(
    {
      port: Number(process.env.PORT || 8790),
      host: process.env.HOST || '127.0.0.1',
      reusePort: process.env.KIN_ROLLOUT_REUSE_PORT === '1',
    },
    resolve,
  )
})
console.log(
  JSON.stringify({
    event: 'listening',
    instance,
    url: `http://${process.env.HOST || '127.0.0.1'}:${server.address().port}`,
    ...(adminServer ? { admin_url: `http://127.0.0.1:${adminServer.address().port}` } : {}),
  }),
)
function gatewayStatus() {
  return {
    schema: 1,
    authority_schema: 1,
    instance,
    ready: !closing,
    active_requests: activeResponses.size,
    draining: closing,
    drained: closing && publicClosed && activeResponses.size === 0,
  }
}
function finishStop() {
  if (stopping && publicClosed && adminClosed) {
    clearInterval(timer)
    state.db.close()
    process.exit(0)
  }
}
function beginDrain() {
  if (closing) return
  closing = true
  server.close(() => {
    publicClosed = true
    finishStop()
  })
}
function stop() {
  if (stopping) return
  stopping = true
  beginDrain()
  if (adminServer)
    adminServer.close(() => {
      adminClosed = true
      finishStop()
    })
  finishStop()
}
process.on('SIGTERM', stop)
process.on('SIGINT', stop)
