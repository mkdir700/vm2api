import { managedEgressConfig } from '../vm/managed-egress-config.mjs'
import path from 'node:path'
import { execCollect } from './ssh-link.mjs'
import { shellQuote } from './remote-fs.mjs'
import { MANAGED_EGRESS_IMAGE, verifyManagedListeners } from '../vm/managed-egress-docker.mjs'

/** Remote Docker CLI runs only through the node's existing pinned SSH connection. */
export class RemoteManagedEgressDocker {
  constructor({ nodeId, root, project, clientFor, endpointFor }) {
    if (
      typeof nodeId !== 'string' ||
      !nodeId ||
      typeof root !== 'string' ||
      !root.startsWith('/') ||
      root.replace(/\/+$/, '') === '' ||
      root.includes('\0') ||
      root.split('/').includes('..') ||
      !/^[a-z0-9][a-z0-9_-]{0,62}$/.test(project || '') ||
      typeof clientFor !== 'function' ||
      typeof endpointFor !== 'function'
    )
      throw new Error('managed_remote_runtime_invalid')
    this.nodeId = nodeId
    this.root = root.replace(/\/+$/, '')
    this.project = project
    this.clientFor = clientFor
    this.endpointFor = endpointFor
  }
  async docker(args, { timeoutMs = 45000 } = {}) {
    try {
      const client = await this.clientFor(this.nodeId)
      if (!client) throw new Error()
      const result = await execCollect(client, ['docker', ...args].map(shellQuote).join(' '), {
        timeoutMs,
        maxBytes: 1024 * 1024,
      })
      if (result.code !== 0) throw new Error()
      return result.stdout.trim()
    } catch {
      throw new Error('managed_remote_docker_failed')
    }
  }
  async provision(files) {
    if (files.nodeId !== this.nodeId || files.root !== this.root) throw new Error('managed_remote_store_mismatch')
    await files.ensure()
    try {
      await files.read('config.json')
    } catch (error) {
      if (error.code !== 'ENOENT') throw error
      await files.atomic('config.json', JSON.stringify(managedEgressConfig([])))
    }
    const manifest = {
      services: {
        'sing-box': {
          image: MANAGED_EGRESS_IMAGE,
          network_mode: 'host',
          restart: 'unless-stopped',
          cap_drop: ['ALL'],
          security_opt: ['no-new-privileges:true'],
          read_only: true,
          labels: { 'vm2api.managed-egress.node': this.nodeId },
          command: ['run', '-c', '/var/lib/vm2api-egress/config.json'],
          volumes: [{ type: 'bind', source: this.root, target: '/var/lib/vm2api-egress', read_only: true }],
        },
      },
    }
    await files.atomic('compose.json', JSON.stringify(manifest))
    const compose = ['compose', '--project-name', this.project, '--file', `${this.root}/compose.json`]
    await this.docker(
      [...compose, 'run', '--rm', '--no-deps', '-T', 'sing-box', 'check', '-c', '/var/lib/vm2api-egress/config.json'],
      { timeoutMs: 600000 },
    )
    await this.docker([...compose, 'up', '-d', '--no-recreate', 'sing-box'], { timeoutMs: 600000 })
    return { container: await this.locate(), image: MANAGED_EGRESS_IMAGE }
  }

  async locate({ requireRunning = true } = {}) {
    const rows = (
      await this.docker([
        'ps',
        '-aq',
        '--no-trunc',
        '--filter',
        `label=com.docker.compose.project=${this.project}`,
        '--filter',
        'label=com.docker.compose.service=sing-box',
        '--filter',
        `label=vm2api.managed-egress.node=${this.nodeId}`,
      ])
    )
      .split(/\s+/)
      .filter(Boolean)
    if (rows.length !== 1)
      throw Object.assign(new Error('managed_remote_runtime_missing_or_ambiguous'), {
        code: rows.length === 0 ? 'managed_remote_runtime_missing' : 'managed_remote_runtime_ambiguous',
      })
    let data
    try {
      data = JSON.parse(await this.docker(['inspect', rows[0]]))[0]
    } catch {
      throw new Error('managed_remote_inspect_failed')
    }
    if (
      data?.Config?.Image !== MANAGED_EGRESS_IMAGE ||
      data.Config.Labels?.['vm2api.managed-egress.node'] !== this.nodeId ||
      data.Config.Labels?.['com.docker.compose.project'] !== this.project ||
      data.Config.Labels?.['com.docker.compose.service'] !== 'sing-box'
    )
      throw new Error('managed_remote_runtime_identity_mismatch')
    const mount = data.Mounts?.find((entry) => entry.Destination === '/var/lib/vm2api-egress')
    if (!mount || mount.Source !== this.root || mount.RW !== false) throw new Error('managed_remote_mount_mismatch')
    if (
      data.HostConfig?.NetworkMode !== 'host' ||
      data.HostConfig.Privileged ||
      data.HostConfig.CapAdd?.length ||
      !data.HostConfig.ReadonlyRootfs ||
      data.Mounts?.some(
        (entry) =>
          entry.Destination === '/var/run/docker.sock' ||
          ['/var/run/docker.sock', '/run/docker.sock'].includes(entry.Source),
      )
    )
      throw new Error('managed_remote_runtime_isolation_mismatch')
    if (requireRunning && !data.State?.Running) throw new Error('managed_remote_runtime_not_running')
    return rows[0]
  }
  async check(file) {
    if (
      !['candidate.json', 'config.json'].includes(path.posix.basename(file)) ||
      path.posix.dirname(file) !== this.root
    )
      throw new Error('managed_remote_candidate_path_invalid')
    this.container = await this.locate({ requireRunning: false })
    if (this.root.includes(':')) throw new Error('managed_remote_mount_path_invalid')
    await this.docker([
      'run',
      '--rm',
      '--network',
      'none',
      '--cap-drop',
      'ALL',
      '--security-opt',
      'no-new-privileges',
      '--read-only',
      '--volume',
      `${this.root}:/var/lib/vm2api-egress:ro`,
      MANAGED_EGRESS_IMAGE,
      'check',
      '-c',
      `/var/lib/vm2api-egress/${path.posix.basename(file)}`,
    ])
  }
  async restart() {
    if (!this.container || (await this.locate({ requireRunning: false })) !== this.container)
      throw new Error('managed_remote_runtime_replaced')
    await this.docker(['restart', '--time', '30', this.container])
  }
  async verify(config) {
    if ((await this.locate()) !== this.container) throw new Error('managed_remote_runtime_replaced')
    const inbounds = []
    for (const inbound of config.inbounds) {
      const id = inbound.tag.replace(/^in-/, '')
      const endpoint = await this.endpointFor({ id, nodeId: this.nodeId, port: inbound.listen_port })
      if (
        endpoint?.host !== '127.0.0.1' ||
        !Number.isInteger(endpoint.port) ||
        endpoint.port < 1 ||
        endpoint.port > 65535
      )
        throw new Error('managed_remote_endpoint_invalid')
      inbounds.push({ ...inbound, listen: endpoint.host, listen_port: endpoint.port })
    }
    return verifyManagedListeners({ ...config, inbounds })
  }
}
