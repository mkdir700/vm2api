import { SocketRelay } from './socket-relay.mjs'
import { EgressDrainClient } from '../vm/managed-egress-drain.mjs'

/** One private relay per remote helper; callers own its lifetime alongside the node link. */
export async function startRemoteEgressDrain({ id, nodeId, remotePath, socketPath, getClient }) {
  if (!id || !nodeId || !remotePath?.startsWith('/') || !socketPath?.startsWith('/') || typeof getClient !== 'function')
    throw new Error('managed_remote_drain_invalid')
  const relay = new SocketRelay({
    socketPath,
    remotePath,
    getClient: () => {
      try {
        const client = getClient(nodeId)
        return typeof client?.openssh_forwardOutStreamLocal === 'function' ? client : null
      } catch {
        return null
      }
    },
  })
  try {
    await relay.start()
  } catch {
    await relay.stop().catch(() => {})
    throw new Error('managed_remote_drain_unavailable')
  }
  const client = new EgressDrainClient({ id, socketPath })
  return {
    inspect: (timeout) => client.request('GET', '/status', timeout),
    pause: (timeout) => client.pause(timeout),
    status: (timeout) => client.status(timeout),
    resume: () => client.resume(),
    close: () => relay.stop(),
  }
}
