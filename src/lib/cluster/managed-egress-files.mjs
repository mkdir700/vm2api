import { openSftp, writeRemoteFile, readRemoteFileNoFollow, runRemote, shellQuote } from './remote-fs.mjs'

const names = new Set(['candidate.json', 'config.json', 'previous.json', 'compose.json'])
const MAX_BYTES = 8 * 1024 * 1024

/** Managed files live in a host-only directory, outside remote guest mount roots. */
export class RemoteManagedEgressFiles {
  constructor({ nodeId, root, clientFor }) {
    if (
      typeof nodeId !== 'string' ||
      !nodeId ||
      typeof root !== 'string' ||
      !root.startsWith('/') ||
      root.includes('\0') ||
      root.split('/').includes('..') ||
      typeof clientFor !== 'function'
    )
      throw new Error('managed_remote_store_invalid')
    this.nodeId = nodeId
    this.root = root.replace(/\/+$/, '')
    if (!this.root) throw new Error('managed_remote_store_invalid')
    this.clientFor = clientFor
  }
  file(name) {
    if (!names.has(name)) throw new Error('managed_remote_file_invalid')
    return `${this.root}/${name}`
  }
  async client() {
    const client = await this.clientFor(this.nodeId)
    if (!client) throw new Error('managed_remote_link_unavailable')
    return client
  }
  async ensure() {
    try {
      const root = shellQuote(this.root)
      await runRemote(await this.client(), `[ ! -L ${root} ] && mkdir -p ${root} && chmod 700 ${root}`)
    } catch {
      throw new Error('managed_remote_store_unavailable')
    }
  }
  async atomic(name, text) {
    const file = this.file(name)
    if (typeof text !== 'string' || Buffer.byteLength(text) > MAX_BYTES)
      throw new Error('managed_remote_file_too_large')
    try {
      await writeRemoteFile(await openSftp(await this.client()), file, text, { mode: 0o600 })
    } catch {
      throw new Error('managed_remote_write_failed')
    }
  }
  async read(name) {
    const file = this.file(name)
    let bytes
    try {
      bytes = await readRemoteFileNoFollow(await this.client(), file, { maxBytes: MAX_BYTES + 1 })
    } catch {
      throw new Error('managed_remote_read_failed')
    }
    if (bytes == null) throw Object.assign(new Error('managed_remote_file_missing'), { code: 'ENOENT' })
    if (bytes.length > MAX_BYTES) throw new Error('managed_remote_file_too_large')
    return bytes.toString('utf8')
  }
  async remove(name) {
    const file = this.file(name)
    try {
      const sftp = await openSftp(await this.client())
      await new Promise((resolve, reject) =>
        sftp.unlink(file, (error) => {
          if (!error || error.code === 2) resolve()
          else reject(error)
        }),
      )
    } catch {
      throw new Error('managed_remote_remove_failed')
    }
  }
}
