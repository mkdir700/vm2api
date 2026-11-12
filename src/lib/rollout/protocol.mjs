import crypto from 'node:crypto'
import fs from 'node:fs'

export const failure = (code, status = 409) => Object.assign(new Error(code), { code, status })
export const digest = (value) => crypto.createHash('sha256').update(value).digest('hex')
export function equal(a, b) {
  const x = Buffer.from(String(a || '')),
    y = Buffer.from(String(b || ''))
  return x.length === y.length && crypto.timingSafeEqual(x, y)
}
export function readSecret(file) {
  const stat = fs.lstatSync(file)
  if (!stat.isFile() || stat.mode & 0o077) throw failure('private_secret_file_required', 500)
  const value = fs.readFileSync(file, 'utf8').trim()
  if (Buffer.byteLength(value) < 32) throw failure('secret_too_short', 500)
  return value
}
export function sign(secret, value) {
  const data = Buffer.from(JSON.stringify(value)).toString('base64url')
  return `${data}.${crypto.createHmac('sha256', secret).update(data).digest('base64url')}`
}
export function verify(secret, raw) {
  if (typeof raw !== 'string' || raw.length > 16384) throw failure('invalid_admission', 401)
  const [data, signature, extra] = raw.split('.')
  if (
    extra ||
    !equal(
      signature,
      crypto
        .createHmac('sha256', secret)
        .update(data || '')
        .digest('base64url'),
    )
  )
    throw failure('invalid_admission', 401)
  let value
  try {
    value = JSON.parse(Buffer.from(data, 'base64url'))
  } catch {
    throw failure('invalid_admission', 401)
  }
  if (!Number.isSafeInteger(value.expires) || value.expires < Date.now() || value.expires > Date.now() + 120000)
    throw failure('expired_admission', 401)
  return value
}
export function cleanHeaders(headers) {
  const out = {}
  const blocked = new Set([
    'connection',
    'keep-alive',
    'proxy-authenticate',
    'proxy-authorization',
    'te',
    'trailer',
    'transfer-encoding',
    'upgrade',
    'host',
    'content-length',
    'authorization',
    'x-api-key',
    'cookie',
    'set-cookie',
  ])
  for (const token of String(headers.connection || '')
    .toLowerCase()
    .split(','))
    blocked.add(token.trim())
  for (const [key, value] of Object.entries(headers))
    if (!blocked.has(key.toLowerCase()) && !key.toLowerCase().startsWith('x-kin-rollout-')) out[key] = value
  return out
}
export async function readJson(req, maxBytes = 32 * 1024 * 1024) {
  let length = 0
  const chunks = []
  for await (const chunk of req) {
    length += chunk.length
    if (length > maxBytes) throw failure('body_too_large', 413)
    chunks.push(chunk)
  }
  const raw = Buffer.concat(chunks)
  try {
    return { raw, body: JSON.parse(raw) }
  } catch {
    throw failure('invalid_json', 400)
  }
}
export function send(res, status, value) {
  if (res.destroyed || res.writableEnded) return
  if (res.headersSent) {
    res.destroy()
    return
  }
  res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' })
  res.end(JSON.stringify(value))
}
export async function control(group, secret, route) {
  const res = await fetch(`${group.url}/_rollout/${route}`, {
    headers: { authorization: `Bearer ${secret}` },
    signal: AbortSignal.timeout(4000),
    redirect: 'error',
  })
  if (!res.ok || Number(res.headers.get('content-length')) > 262144) throw failure('backend_proof_unavailable', 503)
  const chunks = []
  let length = 0
  for await (const chunk of res.body) {
    length += chunk.length
    if (length > 262144) throw failure('backend_proof_too_large', 503)
    chunks.push(chunk)
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'))
}
