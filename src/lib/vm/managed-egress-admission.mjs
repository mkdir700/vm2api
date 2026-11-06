import { AsyncLocalStorage } from 'node:async_hooks'
import { managedEgressReady, setManagedEgressReady, managedEgressIdForUrl } from './managed-egress-readiness.mjs'

const context = new AsyncLocalStorage()
const paused = new Set()
const active = new Map()
function managed(proxy) {
  return proxy && (proxy.managed || proxy.managed_config != null || proxy.scheme === 'hysteria2')
}

/** The outer request owns the lease. Nested awaited credential calls share it. */
export async function withManagedEgressOperation(proxy, operation, { responseBody = false } = {}) {
  if (!managed(proxy)) return operation()
  const id = proxy.id
  const inherited = context.getStore()
  const admitted = inherited?.get(id)?.active
  if (admitted && !responseBody) return operation()
  if (!id || (!admitted && (paused.has(id) || !managedEgressReady(id)))) {
    throw Object.assign(new Error('受管出口暂停接收请求或尚未就绪'), { code: 'managed_egress_not_ready', status: 409 })
  }
  const token = { active: true }
  const scope = new Map(inherited || [])
  scope.set(id, token)
  active.set(id, (active.get(id) || 0) + 1)
  let released = false
  const release = () => {
    if (released) return
    released = true
    token.active = false
    const remaining = (active.get(id) || 1) - 1
    if (remaining) active.set(id, remaining)
    else active.delete(id)
  }
  let deferred = false
  try {
    const result = await context.run(scope, operation)
    const body = result?.body
    if (responseBody && body?.once && !body.readableEnded && !body.destroyed) {
      deferred = true
      for (const event of ['end', 'close', 'error']) body.once(event, release)
    }
    return result
  } finally {
    if (!deferred) release()
  }
}

/** Caller must hold one drain lease per host and release it after apply or timeout. */
export function pauseManagedEgress(ids) {
  const targets = [...new Set(ids)]
  if (targets.some((id) => paused.has(id))) throw new Error('managed_drain_already_active')
  for (const id of targets) paused.add(id)
  let released = false
  return {
    async wait(timeoutMs) {
      const deadline = Date.now() + Math.max(0, Number(timeoutMs) || 0)
      while (targets.some((id) => active.has(id))) {
        if (Date.now() >= deadline) return false
        await new Promise((resolve) => setTimeout(resolve, Math.min(20, Math.max(1, deadline - Date.now()))))
      }
      return true
    },
    async release({ unavailable = false } = {}) {
      if (released) return
      released = true
      // Readiness remains the authoritative gate after releasing a failed runtime.
      if (unavailable) for (const id of targets) setManagedEgressReady(id, false)
      for (const id of targets) paused.delete(id)
    },
  }
}

export function managedEgressPaused(id) {
  return paused.has(id) && !context.getStore()?.get(id)?.active
}

export function withManagedProxyResponse(proxyUrl, operation) {
  const id = managedEgressIdForUrl(proxyUrl)
  return withManagedEgressOperation(id ? { id, managed: true } : null, operation, { responseBody: true })
}

export function managedEgressAdmitted(id) {
  return context.getStore()?.get(id)?.active === true
}

/** Internal helper bootstrap only. The caller must first verify the applied runtime and row match. */
export async function withManagedEgressMaintenance(proxy, operation) {
  const id = proxy?.id
  if (!managed(proxy) || !id || paused.has(id)) throw new Error('managed_maintenance_unavailable')
  setManagedEgressReady(id, false)
  const token = { active: true }
  const scope = new Map(context.getStore() || [])
  scope.set(id, token)
  active.set(id, (active.get(id) || 0) + 1)
  try {
    return await context.run(scope, operation)
  } finally {
    token.active = false
    const remaining = (active.get(id) || 1) - 1
    if (remaining) active.set(id, remaining)
    else active.delete(id)
  }
}
