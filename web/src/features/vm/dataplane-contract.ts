export type KernelDataplane = 'wrap' | 'cc' | 'hermit'

export const HOP_TRANSPORT_LABEL = 'Rust · cli-hop'

export const DATAPLANE_HINT =
  '默认内核使用 cli-node；cc-node 复用默认内核。Hermit 使用独立内核包和官方 Claude Code。'

export function dataplaneLabel(value: unknown): string {
  if (value === 'hermit') return 'Hermit + 原版 Claude Code'
  if (value === 'cc') return 'cc-node + kernel'
  if (value && value !== 'wrap') return `不支持的内核：${String(value)}`
  return 'cli-node + kernel'
}
