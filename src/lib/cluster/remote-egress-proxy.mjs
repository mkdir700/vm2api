import { boundProxyUrl } from '../vm/egress.mjs'

/** The node-side helper dials its own loopback listener, never the control-plane bridge. */
export function remoteEgressProxyUrl(proxy, nodeId) {
  const managed = proxy?.managed || proxy?.managed_config != null || proxy?.scheme === 'hysteria2'
  if (!managed) return boundProxyUrl(proxy)
  const port = proxy.managed_listener_port
  if (
    !nodeId ||
    proxy.managed_host_id !== nodeId ||
    !Number.isInteger(port) ||
    port < 1024 ||
    port > 65535 ||
    typeof proxy.username !== 'string' ||
    !proxy.username ||
    typeof proxy.password !== 'string' ||
    !proxy.password
  )
    throw Object.assign(new Error('受管出口与槽位宿主机不匹配'), { code: 'managed_host_mismatch' })
  return boundProxyUrl({ ...proxy, url: undefined, host: '127.0.0.1', port })
}
