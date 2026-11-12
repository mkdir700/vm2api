const STAGES = ['pool_wait', 'context_check', 'managed_prepare', 'runtime_ready', 'delivery', 'history_confirm']
const UPSTREAM = ['dispatch_ms', 'headers_ms', 'first_byte_ms', 'first_protocol_ms', 'first_content_ms', 'complete_ms']

function measurements(value, keys) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const result = {}
  for (const key of keys) {
    if (!(key in value)) continue
    const n = value[key]
    if (n !== null && (typeof n !== 'number' || !Number.isFinite(n) || n < 0 || n > Number.MAX_SAFE_INTEGER))
      return null
    result[key] = n
  }
  return result
}

// Only a declared, versioned receipt for this exact hop can enter the log.
export function readKernelTiming(response, requestId) {
  if (response.headers?.['x-kernel-request-timing'] !== '1') return null
  const raw = response.trailers?.['x-kernel-timing']
  if (typeof raw !== 'string' || Buffer.byteLength(raw) > 8192) return null
  try {
    const value = JSON.parse(raw)
    if (value?.request_id !== requestId) return null
    return normalizeKernelTiming(value)
  } catch {
    return null
  }
}

export function normalizeKernelTiming(value) {
  if (value?.schema_version !== 1) return null
  const timings = measurements(value.timings_ms, STAGES)
  if (!timings || !Object.values(timings).some((n) => typeof n === 'number')) return null
  const upstream = value.upstream_timing == null ? null : measurements(value.upstream_timing, UPSTREAM)
  if (value.upstream_timing != null && !upstream) return null
  const selection = [
    'owner_created',
    'owner_reused',
    'prewarm_claimed',
    'checkpoint_restore',
    'context_replacement',
    'credential_rotation',
  ].includes(value.selection)
    ? value.selection
    : null
  return {
    schema_version: 1,
    selection,
    timings_ms: timings,
    upstream_timing: upstream,
  }
}

export function storedKernelTiming(raw) {
  try {
    return typeof raw === 'string' && raw.length <= 8192 ? normalizeKernelTiming(JSON.parse(raw)) : null
  } catch {
    return null
  }
}
