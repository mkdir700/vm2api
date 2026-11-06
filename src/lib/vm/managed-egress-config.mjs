/** Protocol configuration only. Runtime placement and credentials belong to the host manager. */
function invalid() {
  // Never include input: links and configuration fields can contain secrets.
  throw new Error('invalid_managed_egress_config')
}

export function hysteria2Fields(input) {
  if (!input || typeof input !== 'object') invalid()
  const server = String(input.server || '').trim()
  const port = Number(input.server_port ?? 443)
  const password = input.password
  if (!server || /[\s/@?#]/.test(server) || !Number.isInteger(port) || port < 1 || port > 65535) invalid()
  if (typeof password !== 'string' || !password || Buffer.byteLength(password) > 4096) invalid()
  const serverName = String(input.server_name || '').trim()
  if (/[\s/@?#]/.test(serverName)) invalid()
  if (input.insecure != null && typeof input.insecure !== 'boolean') invalid()
  const result = { server, server_port: port, password, server_name: serverName, insecure: input.insecure === true }
  if (input.obfs != null) {
    if (input.obfs !== 'salamander' || typeof input.obfs_password !== 'string' || !input.obfs_password) invalid()
    result.obfs = 'salamander'
    result.obfs_password = input.obfs_password
  } else if (input.obfs_password != null) invalid()
  return result
}

export function parseHysteria2Link(value) {
  try {
    const url = new URL(value)
    if (!['hy2:', 'hysteria2:'].includes(url.protocol) || url.password || !url.username) invalid()
    if (url.pathname && url.pathname !== '/') invalid()
    const allowed = new Set(['sni', 'insecure', 'obfs', 'obfs-password'])
    for (const key of url.searchParams.keys()) {
      if (!allowed.has(key) || url.searchParams.getAll(key).length !== 1) invalid()
    }
    const insecure = url.searchParams.get('insecure')
    if (insecure != null && !['0', '1'].includes(insecure)) invalid()
    return hysteria2Fields({
      server: url.hostname.replace(/^\[|\]$/g, ''),
      server_port: url.port || 443,
      password: decodeURIComponent(url.username),
      server_name: url.searchParams.get('sni') || '',
      insecure: insecure === '1',
      obfs: url.searchParams.get('obfs'),
      obfs_password: url.searchParams.get('obfs-password'),
    })
  } catch {
    invalid()
  }
}

export function managedEgressConfig(exits) {
  if (!Array.isArray(exits)) invalid()
  const ids = new Set()
  const ports = new Set()
  const inbounds = []
  const outbounds = []
  const rules = []
  for (const exit of exits) {
    if (!exit || !/^[a-zA-Z0-9_-]{1,80}$/.test(exit.id || '') || ids.has(exit.id)) invalid()
    if (!Number.isInteger(exit.port) || exit.port < 1024 || exit.port > 65535 || ports.has(exit.port)) invalid()
    for (const value of [exit.username, exit.password]) {
      if (typeof value !== 'string' || !value || Buffer.byteLength(value) > 255) invalid()
    }
    if (exit.protocol !== 'hysteria2') invalid()
    ids.add(exit.id)
    ports.add(exit.port)
    const fields = hysteria2Fields(exit.config)
    const inbound = `in-${exit.id}`
    const outbound = `out-${exit.id}`
    inbounds.push({
      type: 'socks',
      tag: inbound,
      listen: '127.0.0.1',
      listen_port: exit.port,
      users: [{ username: exit.username, password: exit.password }],
    })
    outbounds.push({
      type: 'hysteria2',
      tag: outbound,
      server: fields.server,
      server_port: fields.server_port,
      password: fields.password,
      tls: {
        enabled: true,
        ...(fields.server_name ? { server_name: fields.server_name } : {}),
        insecure: fields.insecure,
      },
      ...(fields.obfs ? { obfs: { type: fields.obfs, password: fields.obfs_password } } : {}),
    })
    rules.push({ inbound: [inbound], action: 'route', outbound })
  }
  // Explicit terminal rejection also makes the zero-node bootstrap safe.
  rules.push({ action: 'reject' })
  return { log: { disabled: true }, inbounds, outbounds, route: { rules } }
}
