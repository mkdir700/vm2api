// Runtime proof is process-local. Persisted VM snapshots cannot establish readiness.
const ready = new Set()
export function setManagedEgressReady(id, value) {
  if (value) ready.add(id)
  else ready.delete(id)
}
export function managedEgressReady(id) {
  return ready.has(id)
}

const endpoints = new Map()
const endpointById = new Map()
function endpointKey(host, port) {
  return `${String(host)
    .replace(/^\[|\]$/g, '')
    .toLowerCase()}:${Number(port)}`
}
export function registerManagedEgressEndpoint(id, host, port) {
  unregisterManagedEgressEndpoint(id)
  const key = endpointKey(host, port)
  endpoints.set(key, id)
  endpointById.set(id, key)
}
export function unregisterManagedEgressEndpoint(id) {
  const key = endpointById.get(id)
  if (endpoints.get(key) === id) endpoints.delete(key)
  endpointById.delete(id)
  ready.delete(id)
}
export function managedEgressIdForUrl(value) {
  try {
    const url = new URL(value)
    if (!['socks5:', 'socks5h:'].includes(url.protocol)) return null
    return endpoints.get(endpointKey(url.hostname, url.port || 1080)) || null
  } catch {
    return null
  }
}
