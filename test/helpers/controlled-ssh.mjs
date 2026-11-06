import { execFileSync, spawn } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { createHash, randomBytes } from 'node:crypto'
import path from 'node:path'
import net from 'node:net'
import ssh2 from 'ssh2'

/** Loopback-only, pinned SSH fixture. Commands and SFTP use real host processes. */
export async function startControlledSsh({ root, ports, sockets = new Set() }) {
  const key = path.join(root, 'ssh-host-key')
  execFileSync('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-f', key], { stdio: 'ignore' })
  const blob = Buffer.from((await readFile(`${key}.pub`, 'utf8')).split(' ')[1], 'base64')
  const pinned = createHash('sha256').update(blob).digest('hex')
  const password = randomBytes(24).toString('hex')
  const peers = new Set(),
    streams = new Set(),
    children = new Set()
  const server = new ssh2.Server({ hostKeys: [await readFile(key)] }, (peer) => {
    peers.add(peer)
    peer.on('error', () => {})
    peer.on('close', () => peers.delete(peer))
    peer.on('authentication', (request) => {
      if (request.method === 'password' && request.username === 'controlled' && request.password === password)
        request.accept()
      else request.reject()
    })
    peer.on('ready', () => {
      peer.on('session', (accept) => {
        const session = accept()
        const run = (channel, command, args) => {
          const child = spawn(command, args, { stdio: ['pipe', 'pipe', 'pipe'] })
          children.add(child)
          channel.pipe(child.stdin)
          child.stdout.pipe(channel, { end: false })
          child.stderr.pipe(channel.stderr, { end: false })
          child.stdin.on('error', () => {})
          child.on('error', () => channel.destroy())
          channel.on('error', () => {})
          channel.once('close', () => {
            if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM')
          })
          child.once('close', (code) => {
            children.delete(child)
            channel.exit(Number.isInteger(code) && code >= 0 ? code : 1)
            channel.end()
          })
        }
        session.on('exec', (accept, _reject, info) => run(accept(), '/bin/sh', ['-c', info.command]))
        session.on('subsystem', (accept, reject, info) => {
          if (info.name !== 'sftp') return reject()
          run(accept(), '/usr/lib/openssh/sftp-server', [])
        })
      })
      const bridge = (channel, target) => {
        streams.add(target)
        target.on('error', () => channel.destroy())
        channel.on('error', () => target.destroy())
        target.on('close', () => {
          streams.delete(target)
          channel.end()
        })
        channel.on('close', () => target.destroy())
        channel.pipe(target).pipe(channel)
      }
      peer.on('tcpip', (accept, reject, info) => {
        if (info.destIP !== '127.0.0.1' || !ports.has(info.destPort)) return reject()
        bridge(accept(), net.connect(info.destPort, info.destIP))
      })
      peer.on('openssh.streamlocal', (accept, reject, info) => {
        if (!sockets.has(info.socketPath)) return reject()
        bridge(accept(), net.connect(info.socketPath))
      })
    })
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const clients = new Set()
  const connect = async () => {
    const client = new ssh2.Client()
    clients.add(client)
    client.on('error', () => {})
    client.on('close', () => clients.delete(client))
    try {
      await new Promise((resolve, reject) => {
        client.once('ready', resolve)
        client.once('error', reject)
        client.connect({
          host: '127.0.0.1',
          port: server.address().port,
          username: 'controlled',
          password,
          hostHash: 'sha256',
          hostVerifier: (value) => value === pinned,
        })
      })
    } catch (error) {
      client.destroy()
      throw error
    }
    return client
  }
  let client
  try {
    client = await connect()
  } catch (error) {
    for (const peer of peers) peer.end()
    server.close()
    throw error
  }
  return {
    get client() {
      return client
    },
    async reconnect() {
      const previous = client
      client = await connect()
      previous.destroy()
      return client
    },
    async close() {
      for (const connected of clients) connected.destroy()
      for (const peer of peers) peer.end()
      for (const stream of streams) stream.destroy()
      for (const child of children) if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM')
      await new Promise((resolve) => server.close(resolve))
    },
  }
}
