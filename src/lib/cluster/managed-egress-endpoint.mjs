import net from 'node:net'
import { forwardOut } from './ssh-link.mjs'
import {
  registerManagedEgressEndpoint,
  unregisterManagedEgressEndpoint,
  managedEgressIdForUrl,
  setManagedEgressReady,
} from '../vm/managed-egress-readiness.mjs'

/** A byte bridge to one node-local SOCKS listener. Remote SOCKS authentication stays intact. */
export async function startRemoteManagedEgressEndpoint({ id, nodeId, port, clientFor }) {
  if (!id || !nodeId || !Number.isInteger(port) || port < 1024 || port > 65535 || typeof clientFor !== 'function')
    throw new Error('managed_remote_endpoint_invalid')
  const sockets = new Set()
  const links = new Map()
  let closed = false
  let endpoint = ''
  const revoke = () => {
    if (managedEgressIdForUrl(endpoint) === id) setManagedEgressReady(id, false)
  }
  const server = net.createServer((socket) => {
    if (closed || sockets.size >= 256) {
      socket.destroy()
      return
    }
    sockets.add(socket)
    socket.pause()
    let channel
    let opening = true
    const timeout = setTimeout(() => socket.destroy(), 15000)
    const finish = () => {
      clearTimeout(timeout)
      if (!opening) sockets.delete(socket)
      channel?.destroy()
    }
    socket.on('error', () => socket.destroy())
    socket.once('close', finish)
    void (async () => {
      try {
        const client = await clientFor(nodeId)
        if (!client || closed || socket.destroyed) throw new Error('managed_remote_link_unavailable')
        if (!links.has(client)) {
          const dropped = () => {
            revoke()
            links.delete(client)
          }
          links.set(client, dropped)
          client.once('close', dropped)
        }
        channel = await forwardOut(client, '127.0.0.1', port)
        if (closed || socket.destroyed) {
          channel.destroy()
          return
        }
        clearTimeout(timeout)
        channel.on('error', () => socket.destroy())
        channel.once('close', () => socket.destroy())
        socket.pipe(channel).pipe(socket)
        socket.resume()
      } catch {
        revoke()
        socket.destroy()
      } finally {
        opening = false
        if (socket.destroyed) sockets.delete(socket)
      }
    })()
  })
  server.on('error', revoke)
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const localPort = server.address().port
  endpoint = `socks5h://127.0.0.1:${localPort}`
  registerManagedEgressEndpoint(id, '127.0.0.1', localPort)
  return {
    host: '127.0.0.1',
    port: localPort,
    async close() {
      if (closed) return
      closed = true
      for (const socket of sockets) socket.destroy()
      for (const [client, dropped] of links) client.off('close', dropped)
      links.clear()
      if (managedEgressIdForUrl(endpoint) === id) unregisterManagedEgressEndpoint(id)
      await new Promise((resolve) => server.close(resolve))
    },
  }
}
