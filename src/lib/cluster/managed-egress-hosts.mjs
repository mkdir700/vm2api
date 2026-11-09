import path from 'node:path'
import { createHash, randomBytes } from 'node:crypto'
import { ManagedEgressHost } from '../vm/managed-egress-host.mjs'
import { acquireManagedDrain } from '../vm/managed-egress-drain.mjs'
import {
  setManagedEgressReady,
  managedEgressIdForUrl,
  registerManagedEgressEndpoint,
} from '../vm/managed-egress-readiness.mjs'
import { RemoteManagedEgressFiles } from './managed-egress-files.mjs'
import { RemoteManagedEgressDocker } from './managed-egress-runtime.mjs'
import { startRemoteManagedEgressEndpoint } from './managed-egress-endpoint.mjs'
import { startRemoteEgressDrain } from './managed-egress-drain.mjs'
import { execCollect } from './ssh-link.mjs'
import { shellQuote } from './remote-fs.mjs'
import { slotEgressNames, remoteIptablesScript } from './remote-slot.mjs'
import { iptablesPlan } from '../vm/egress.mjs'

/** One shared lifecycle per node and SSH connection. Lookup and inspection never provision. */
export class RemoteManagedEgressHosts {
  constructor({ db, cluster, rowsFor, socketDir }) {
    this.db = db
    this.cluster = cluster
    this.rowsFor = rowsFor
    this.socketDir = socketDir
    this.records = new Map()
  }

  async record(nodeId) {
    const client = this.cluster.client(nodeId)
    const existing = this.records.get(nodeId)
    if (existing?.client === client && !existing.closed) return existing
    if (existing) await this.invalidate(nodeId)
    const facts = await this.cluster.remoteHost(nodeId)
    if (facts.platform !== 'linux' || !facts.root?.startsWith('/')) throw new Error('managed_host_unsupported')
    // Host-fact reads may overlap a reconnect. Never attach those facts to a new client.
    if (this.cluster.client(nodeId) !== client) throw new Error('managed_remote_link_changed')
    const current = this.records.get(nodeId)
    if (current?.client === client && !current.closed) return current
    const record = {
      client,
      uid: facts.uid,
      root: `${facts.root}/managed-egress`,
      endpoints: new Map(),
      controls: new Set(),
      closed: false,
    }
    const clientFor = () => {
      if (record.closed || this.cluster.client(nodeId) !== client) throw new Error('managed_remote_link_changed')
      return client
    }
    record.files = new RemoteManagedEgressFiles({ nodeId, root: record.root, clientFor })
    record.runtime = new RemoteManagedEgressDocker({
      nodeId,
      root: record.root,
      project: `vm2api-egress-${createHash('sha256').update(nodeId).digest('hex').slice(0, 16)}`,
      clientFor,
      endpointFor: ({ id, port }) => this.endpoint(record, nodeId, id, port, clientFor),
    })
    record.host = new ManagedEgressHost({
      db: this.db,
      hostId: nodeId,
      configDir: record.root,
      files: record.files,
      runtime: record.runtime,
      acquireDrain: async () => {
        clientFor()
        const rows = this.rowsFor(nodeId)
        const controls = []
        const lease = await acquireManagedDrain({
          ids: rows.map((row) => row.id),
          helpers: async () => {
            controls.push(...(await this.helpers(record, nodeId, rows, facts.root, clientFor)))
            return controls
          },
        })
        return {
          wait: (timeout) => lease.wait(timeout),
          release: async (options) => {
            try {
              await lease.release(options)
            } finally {
              await this.closeControls(record, controls)
            }
          },
        }
      },
    })
    this.records.set(nodeId, record)
    record.dropped = () => {
      void this.invalidate(nodeId, record).catch(() => {})
    }
    client.once('close', record.dropped)
    return record
  }

  async get(nodeId) {
    return (await this.record(nodeId)).host
  }

  /** A restored ledger requires fresh host objects and verified SSH endpoints. */
  async rebind(db) {
    await this.close()
    this.db = db
  }

  /** Called by the deployment path, never by get() or the health monitor. */
  async provision(nodeId) {
    const record = await this.record(nodeId)
    return record.host.serialize(() => record.runtime.provision(record.files))
  }

  /** Import inspects listeners on the selected host without deploying a service. */
  async occupiedPorts(nodeId) {
    const record = await this.record(nodeId)
    try {
      if (record.closed || this.cluster.client(nodeId) !== record.client) throw new Error()
      const result = await execCollect(record.client, 'ss -H -ltn', { timeoutMs: 5000, maxBytes: 1024 * 1024 })
      if (result.code !== 0 || record.closed || this.cluster.client(nodeId) !== record.client) throw new Error()
      const ports = new Set()
      for (const line of result.stdout.split('\n').filter((line) => line.trim())) {
        const match = line
          .trim()
          .split(/\s+/)[3]
          ?.match(/:(\d+)$/)
        if (!match) throw new Error()
        const port = Number(match[1])
        if (port < 1 || port > 65535) throw new Error()
        ports.add(port)
      }
      return ports
    } catch {
      throw new Error('managed_remote_ports_unavailable')
    }
  }

  /** Apply bootstraps only a missing service. Existing instances wait for the host drain. */
  async ensureProvisioned(nodeId) {
    const record = await this.record(nodeId)
    return record.host.serialize(async () => {
      if (['applying', 'unavailable'].includes(record.host.state().status))
        throw new Error('managed_host_recovery_required')
      try {
        await record.runtime.locate({ requireRunning: false })
      } catch (error) {
        if (error.code !== 'managed_remote_runtime_missing') throw error
        await record.runtime.provision(record.files)
      }
    })
  }

  async endpoint(record, nodeId, id, port, clientFor) {
    clientFor()
    let entry = record.endpoints.get(id)
    if (entry && entry.port !== port) throw new Error('managed_remote_endpoint_changed')
    if (!entry) {
      entry = { port, pending: startRemoteManagedEgressEndpoint({ id, nodeId, port, clientFor }) }
      record.endpoints.set(id, entry)
    }
    try {
      const endpoint = await entry.pending
      clientFor()
      entry.address = { host: endpoint.host, port: endpoint.port }
      // Pool reload clears registrations and readiness. Reverification must restore
      // the URL identity even when the bridge itself remains alive.
      if (managedEgressIdForUrl(`socks5h://${endpoint.host}:${endpoint.port}`) !== id)
        registerManagedEgressEndpoint(id, endpoint.host, endpoint.port)
      return endpoint
    } catch (error) {
      if (record.endpoints.get(id) === entry) record.endpoints.delete(id)
      await entry.pending.then(
        (endpoint) => endpoint.close(),
        () => {},
      )
      throw error
    }
  }

  /** Synchronous caller resolution uses only an existing bridge on the current client. */
  addressFor(proxy) {
    const record = this.records.get(proxy.managed_host_id)
    try {
      if (!record || record.closed || this.cluster.client(proxy.managed_host_id) !== record.client) throw new Error()
      const entry = record.endpoints.get(proxy.id)
      if (entry?.port !== proxy.port || !entry.address) throw new Error()
      return { ...entry.address }
    } catch {
      setManagedEgressReady(proxy.id, false)
      return null
    }
  }

  supportsPlacement(proxy, nodeId) {
    const record = this.records.get(nodeId)
    // Readiness/admission owns the live gate. Keep placement usable by admitted
    // requests while an update checks or drains the previously applied version.
    if (proxy.managed_host_id !== nodeId || !record || record.closed || !record.host.state().applied_version)
      return false
    return this.addressFor(proxy) !== null
  }

  async helpers(record, nodeId, rows, slotRoot, clientFor) {
    const controls = []
    try {
      clientFor()
      const ids = (await record.runtime.docker(['ps', '-aq', '--no-trunc', '--filter', 'label=kin.egress=1']))
        .split(/\s+/)
        .filter(Boolean)
      const containers = ids.length ? JSON.parse(await record.runtime.docker(['inspect', ...ids])) : []
      if (
        !Array.isArray(containers) ||
        containers.length !== ids.length ||
        new Set(ids).size !== ids.length ||
        containers.some((container, index) => container.Id !== ids[index])
      )
        throw new Error()
      const expected = new Map(rows.map((row) => [row.id, row]))
      const found = new Map()
      for (const container of containers) {
        const labels = container.Config?.Labels || {}
        const proxyId = labels['kin.egress.proxy']
        if (!expected.has(proxyId)) continue
        const vmId = labels['kin.egress.vm']
        if (!/^[a-zA-Z0-9_-]{1,128}$/.test(vmId || '') || found.has(vmId)) throw new Error()
        const mount = container.Mounts?.find((entry) => entry.Destination === '/run/kin-egress')
        const dir = `${slotRoot}/vms/${vmId}/egress-control`
        if (
          !container.State?.Running ||
          container.State.Restarting ||
          container.HostConfig?.NetworkMode !== 'host' ||
          mount?.Source !== dir ||
          mount.RW !== true
        )
          throw new Error()
        found.set(vmId, proxyId)
        const control = await startRemoteEgressDrain({
          id: proxyId,
          nodeId,
          remotePath: `${dir}/drain.sock`,
          socketPath: path.join(
            this.socketDir,
            `me-${createHash('sha256').update(nodeId).digest('hex').slice(0, 8)}-${randomBytes(4).toString('hex')}.sock`,
          ),
          getClient: clientFor,
        })
        record.controls.add(control)
        controls.push(control)
      }
      for (const row of rows) {
        const bound = new Set([...(row.bound_vm_ids || []), ...(row.bound_vm_id ? [row.bound_vm_id] : [])])
        for (const vmId of bound) if (found.get(vmId) !== row.id) throw new Error()
      }
      return controls
    } catch {
      await this.closeControls(record, controls)
      throw new Error('managed_remote_helpers_unavailable')
    }
  }

  async helperStatus(proxy) {
    let record
    let controls = []
    try {
      record = await this.record(proxy.managed_host_id)
      const clientFor = () => {
        if (record.closed || this.cluster.client(proxy.managed_host_id) !== record.client) throw new Error()
        return record.client
      }
      controls = await this.helpers(record, proxy.managed_host_id, [proxy], path.posix.dirname(record.root), clientFor)
      const states = await Promise.all(controls.map((control) => control.inspect()))
      return states.every((state) => !state.paused) && (await this.routing(record, proxy))
    } catch {
      return false
    } finally {
      if (record) await this.closeControls(record, controls)
    }
  }

  /** Host firewall rules disappear at OS boot even when Docker restarts a healthy helper. */
  async routing(record, proxy, repair = false) {
    const bound = new Set([...(proxy.bound_vm_ids || []), ...(proxy.bound_vm_id ? [proxy.bound_vm_id] : [])])
    const sudo = record.uid !== 0
    for (const vmId of bound) {
      if (!/^[a-zA-Z0-9_-]{1,128}$/.test(vmId)) return false
      const names = slotEgressNames(vmId)
      const networks = JSON.parse(await record.runtime.docker(['network', 'inspect', names.network]))
      const network = networks?.[0]
      const subnet = network?.IPAM?.Config?.[0]?.Subnet
      if (
        networks.length !== 1 ||
        network?.Name !== names.network ||
        network.Driver !== 'bridge' ||
        network.Labels?.['kin.egress.vm'] !== vmId ||
        network.Options?.['com.docker.network.bridge.name'] !== names.bridge ||
        network.Options?.['com.docker.network.bridge.enable_ip_masquerade'] !== 'false' ||
        typeof subnet !== 'string' ||
        !/^\d+\.\d+\.\d+\.\d+\/\d+$/.test(subnet)
      )
        return false
      const plan = iptablesPlan({
        chain: names.chain,
        bridge: names.bridge,
        subnet,
        tcpPort: names.ports.tcp,
        dnsPort: names.ports.dns,
      })
      // Check all expected jumps, redirects and fail-closed filters without changing them.
      const checks = plan.add
        .filter((args) => args.includes('-C') || args.includes('-A'))
        .map((args) => args.map((arg) => (arg === '-A' ? '-C' : arg)))
      const script = repair
        ? remoteIptablesScript(plan, { sudo })
        : `set -e\n${checks.map((args) => `${sudo ? 'sudo -n ' : ''}iptables ${args.map(shellQuote).join(' ')} 2>/dev/null`).join('\n')}`
      const response = await execCollect(record.client, script, { timeoutMs: 10000, maxBytes: 65536 })
      if (record.closed || this.cluster.client(proxy.managed_host_id) !== record.client || response.code !== 0)
        return false
    }
    return true
  }

  /** Called only from the pool's verified applied-config maintenance admission. */
  async repairRouting(proxy) {
    let record
    let controls = []
    try {
      record = await this.record(proxy.managed_host_id)
      const clientFor = () => {
        if (record.closed || this.cluster.client(proxy.managed_host_id) !== record.client) throw new Error()
        return record.client
      }
      controls = await this.helpers(record, proxy.managed_host_id, [proxy], path.posix.dirname(record.root), clientFor)
      const states = await Promise.all(controls.map((control) => control.inspect()))
      if (!states.every((state) => !state.paused)) return false
      return await this.routing(record, proxy, true)
    } catch {
      return false
    } finally {
      if (record) await this.closeControls(record, controls)
    }
  }

  async closeControls(record, controls) {
    await Promise.all(
      controls.map(async (control) => {
        record.controls.delete(control)
        await control.close()
      }),
    )
  }

  async invalidate(nodeId, expected = null) {
    const record = this.records.get(nodeId)
    if (!record || (expected && record !== expected)) return
    record.closed = true
    this.records.delete(nodeId)
    record.client.off('close', record.dropped)
    for (const row of this.rowsFor(nodeId)) setManagedEgressReady(row.id, false)
    await Promise.all([
      this.closeControls(record, [...record.controls]),
      ...[...record.endpoints.values()].map((entry) =>
        entry.pending.then(
          (endpoint) => endpoint.close(),
          () => {},
        ),
      ),
    ])
  }

  async close() {
    await Promise.all([...this.records.keys()].map((nodeId) => this.invalidate(nodeId)))
  }
}
