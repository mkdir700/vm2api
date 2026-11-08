export type KernelDataplane = 'wrap' | 'cc' | 'crag' | 'hermit'

export const HOP_TRANSPORT_LABEL = 'Rust · cli-hop'

export const DATAPLANE_HINT =
  '运输固定 Rust cli-hop。cli-node + kernel 是默认（一进程 20 native 槽）；cc-node + kernel 用同一份 wrap kernel；crag + cc-node 用 crag kernel，claude_bin 指向仓内 cc-node。'

export function dataplaneLabel(value: unknown): string {
  if (value === 'hermit') return 'Hermit + 原版 Claude Code'
  if (value === 'crag') return 'crag + cc-node'
  if (value === 'cc') return 'cc-node + kernel'
  return 'cli-node + kernel'
}
