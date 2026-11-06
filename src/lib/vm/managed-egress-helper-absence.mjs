import { readFile } from 'node:fs/promises'
import net from 'node:net'
import dgram from 'node:dgram'

function listener(value) {
  const url = new URL(`tcp://${value}`)
  const host = url.hostname.replace(/^\[|\]$/g, '')
  const port = Number(url.port)
  if (
    !net.isIP(host) ||
    !Number.isInteger(port) ||
    port < 1 ||
    port > 65535 ||
    url.pathname ||
    url.username ||
    url.password
  )
    throw new Error()
  return { host, port }
}

async function controlAbsent(socketPath) {
  await new Promise((resolve, reject) => {
    const socket = net.connect(socketPath)
    const timer = setTimeout(() => {
      socket.destroy()
      reject(new Error())
    }, 500)
    socket.once('connect', () => {
      clearTimeout(timer)
      socket.destroy()
      reject(new Error())
    })
    socket.once('error', (error) => {
      clearTimeout(timer)
      socket.destroy()
      if (['ENOENT', 'ECONNREFUSED'].includes(error.code)) resolve()
      else reject(new Error())
    })
  })
}

/** Recovery-only proof. Reserve real data ports; never invent a helper status or signal a PID. */
export async function reserveAbsentManagedHelper({ id, configFile, pidFile }) {
  const reservations = []
  const close = async () => {
    await Promise.all(reservations.splice(0).map((socket) => new Promise((resolve) => socket.close(resolve))))
  }
  try {
    // Host-namespace command prefixes cannot be proved by this process's native PID API.
    if (process.env.KIN_EGRESS_CMD_PREFIX) throw new Error()
    const text = await readFile(configFile, 'utf8')
    if (Buffer.byteLength(text) > 65536) throw new Error()
    const config = JSON.parse(text)
    const pid = Number((await readFile(pidFile, 'utf8')).trim())
    if (!Number.isSafeInteger(pid) || pid <= 1 || config.proxy_id !== id || !config.control_socket?.startsWith('/'))
      throw new Error()
    try {
      process.kill(pid, 0)
      throw new Error()
    } catch (error) {
      if (error.code !== 'ESRCH') throw error
    }
    const tcp = listener(config.listen_tcp)
    const dns = listener(config.listen_dns)
    await controlAbsent(config.control_socket)
    for (const address of [tcp, dns]) {
      const server = net.createServer((socket) => socket.destroy())
      await new Promise((resolve, reject) => {
        server.once('error', reject)
        server.listen({ ...address, exclusive: true }, () => {
          server.off('error', reject)
          resolve()
        })
      })
      server.on('error', () => {})
      reservations.push(server)
    }
    const udp = dgram.createSocket(net.isIPv6(dns.host) ? 'udp6' : 'udp4')
    try {
      await new Promise((resolve, reject) => {
        udp.once('error', reject)
        udp.bind({ address: dns.host, port: dns.port, exclusive: true }, () => {
          udp.off('error', reject)
          resolve()
        })
      })
    } catch (error) {
      try {
        udp.close()
      } catch {}
      throw error
    }
    udp.on('error', () => {})
    reservations.push(udp)
    return { close }
  } catch {
    await close()
    throw new Error('managed_helper_absence_unproven')
  }
}
