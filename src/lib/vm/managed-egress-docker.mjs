import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import path from 'node:path'
import net from 'node:net'
import { verifyManagedProxyGeo } from './proxy-geo.mjs'
import { socksProxyUrl } from './socks-address.mjs'

export const MANAGED_EGRESS_IMAGE =
  'ghcr.io/sagernet/sing-box:v1.12.0@sha256:3c1ee82d450df9b336b6f63b1d272cf86e3835392d99596ef8c35f206a457999'
const execute = promisify(execFile)

export async function verifyManagedListeners(config, options = {}) {
  const observed = []
  for (const inbound of config.inbounds) {
    if (inbound.type !== 'socks' || inbound.listen !== '127.0.0.1' || inbound.users?.length !== 1)
      throw new Error('managed_listener_invalid')
    const result = await verifyManagedProxyGeo(
      socksProxyUrl({ host: inbound.listen, port: inbound.listen_port, ...inbound.users[0] }),
      options,
    )
    if (!result.ok || !net.isIP(result.geo?.ip || '')) throw new Error('managed_exit_verification_failed')
    observed.push({ inbound: inbound.tag, ip: result.geo.ip })
  }
  return observed
}

/** Docker arguments contain paths and container IDs only; child output stays private. */
export class ManagedEgressDocker {
  constructor({ configDir, controlContainer = process.env.VM2API_CONTAINER_NAME || 'vm2api' } = {}) {
    this.controlContainer = controlContainer
    this.configDir = configDir
  }

  async docker(args) {
    try {
      const { stdout } = await execute('docker', args, { timeout: 45000, maxBuffer: 1024 * 1024 })
      return stdout.trim()
    } catch {
      throw new Error('managed_docker_unavailable')
    }
  }

  async inspect(id) {
    try {
      const rows = JSON.parse(await this.docker(['inspect', id]))
      if (!Array.isArray(rows) || rows.length !== 1 || !rows[0] || typeof rows[0] !== 'object') throw new Error()
      return rows[0]
    } catch {
      throw new Error('managed_docker_inspect_failed')
    }
  }

  async locate({ requireRunning = true } = {}) {
    const control = await this.inspect(this.controlContainer)
    const project = control?.Config?.Labels?.['com.docker.compose.project']
    if (!project) throw new Error('managed_compose_project_missing')
    const ids = (
      await this.docker([
        'ps',
        '-aq',
        '--no-trunc',
        '--filter',
        `label=com.docker.compose.project=${project}`,
        '--filter',
        'label=com.docker.compose.service=sing-box',
      ])
    )
      .split(/\s+/)
      .filter(Boolean)
    if (ids.length !== 1) throw new Error('managed_runtime_missing_or_ambiguous')
    const runtime = await this.inspect(ids[0])
    if (runtime?.Config?.Image !== MANAGED_EGRESS_IMAGE) throw new Error('managed_runtime_image_mismatch')
    if (
      runtime.Config.Labels?.['com.docker.compose.project'] !== project ||
      runtime.Config.Labels?.['com.docker.compose.service'] !== 'sing-box'
    )
      throw new Error('managed_runtime_identity_mismatch')
    if (!Array.isArray(control.Mounts) || !Array.isArray(runtime.Mounts))
      throw new Error('managed_runtime_mount_mismatch')
    const parent = control.Mounts?.filter(
      (mount) =>
        this.configDir && (this.configDir === mount.Destination || this.configDir.startsWith(`${mount.Destination}/`)),
    ).sort((a, b) => b.Destination.length - a.Destination.length)[0]
    const expectedSource = parent && path.join(parent.Source, path.relative(parent.Destination, this.configDir))
    const configMount = runtime.Mounts?.find((mount) => mount.Destination === '/var/lib/vm2api-egress')
    if (!expectedSource || configMount?.Source !== expectedSource || configMount.RW !== false)
      throw new Error('managed_runtime_mount_mismatch')
    if (runtime.HostConfig?.NetworkMode !== 'host' || control.HostConfig?.NetworkMode !== 'host')
      throw new Error('managed_runtime_network_mismatch')
    if (
      runtime.HostConfig.Privileged ||
      runtime.HostConfig.CapAdd?.length ||
      !runtime.HostConfig.ReadonlyRootfs ||
      runtime.Mounts.some(
        (mount) =>
          ['/run/docker.sock', '/var/run/docker.sock'].includes(mount.Source) ||
          ['/run/docker.sock', '/var/run/docker.sock'].includes(mount.Destination),
      )
    )
      throw new Error('managed_runtime_isolation_mismatch')
    if (requireRunning && !runtime.State?.Running) throw new Error('managed_runtime_not_running')
    this.hostConfigDir = expectedSource
    return ids[0]
  }

  async check(file) {
    this.container = null
    this.checkedConfigDir = null
    if (!['candidate.json', 'config.json'].includes(path.basename(file)) || path.dirname(file) !== this.configDir)
      throw new Error('managed_candidate_path_invalid')
    const container = await this.locate({ requireRunning: false })
    const source = this.hostConfigDir
    if (!path.isAbsolute(source) || source.includes(':') || source.includes('\0'))
      throw new Error('managed_runtime_mount_mismatch')
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
      `${source}:/var/lib/vm2api-egress:ro`,
      MANAGED_EGRESS_IMAGE,
      'check',
      '-c',
      `/var/lib/vm2api-egress/${path.basename(file)}`,
    ])
    this.container = container
    this.checkedConfigDir = source
  }

  async restart() {
    if (!this.container) throw new Error('managed_runtime_not_checked')
    if (
      (await this.locate({ requireRunning: false })) !== this.container ||
      this.hostConfigDir !== this.checkedConfigDir
    )
      throw new Error('managed_runtime_replaced')
    await this.docker(['restart', '--time', '30', this.container])
  }

  async verify(config) {
    const current = await this.locate()
    if (current !== this.container || this.hostConfigDir !== this.checkedConfigDir)
      throw new Error('managed_runtime_replaced')
    return verifyManagedListeners(config, { timeoutMs: 8000 })
  }
}
