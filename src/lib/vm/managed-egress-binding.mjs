import { bindVmProxy, getVm } from './vm-registry.mjs'
import { slotHost } from './slot-host.mjs'
import { ensureProxyEgress } from './egress.mjs'

/** Save the authoritative binding and initialize its helper on the slot's host. */
export async function bindManagedVmExit({ proxyPool, projectRoot, proxyId, vmId }) {
  if (!getVm(projectRoot, vmId)) return { ok: false, error: 'vm_not_found' }
  return proxyPool.bindManaged(proxyId, vmId, async (proxy) => {
    bindVmProxy(projectRoot, vmId, proxy)
    const vm = getVm(projectRoot, vmId)
    if (!vm) return { ok: false }
    const host = slotHost(vm)
    // Policy enable is a no-op for local Codex slots; binding needs the real helper.
    return host.kind === 'local'
      ? ensureProxyEgress(projectRoot, proxy)
      : host.setProxyEgressEnabled(vm, projectRoot, true)
  })
}
