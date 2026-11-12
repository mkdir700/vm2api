import { queryOptions } from '@tanstack/react-query'
import { api } from '@/lib/api'

export type ReleaseKernelId = 'cli-node'
export type KernelId = ReleaseKernelId | 'hermit'

export type KernelProduct = {
  id: ReleaseKernelId
  name: string
  ready: boolean
  version: string | null
  updated_at: string | null
  code?: string
  error?: string
}

export type KernelInstallation = {
  kernel: KernelId
  version: string | null
  installed_at: string
}

export type KernelCatalog = {
  kernels: KernelProduct[]
  installations?: Record<string, KernelInstallation>
}

export type KernelTarget = {
  id: string
  kernel: KernelId
  manifest_sha256?: string
}

export type HermitPackage = {
  runtime: 'hermit'
  version: string
  target: string
  manifest_sha256: string
  acceptance: string
  cli: { version: string }
  capabilities: {
    production: boolean
    helper_integration?: boolean
    https_upstream?: boolean
    switch_readiness?: boolean
  }
}

export function hermitPackageReady(item: HermitPackage) {
  return (
    item.target === 'linux-amd64' &&
    item.acceptance === 'production' &&
    item.capabilities.production &&
    item.capabilities.helper_integration &&
    item.capabilities.https_upstream &&
    item.capabilities.switch_readiness
  )
}

export function hermitPackageQueryOptions() {
  return queryOptions({
    queryKey: ['kernel-packages'] as const,
    queryFn: () =>
      api<{ item: HermitPackage | null }>('/api/panel/kernel-packages'),
  })
}

export type KernelInstallItem = KernelTarget & {
  ok: boolean
  stopped: boolean
  version?: string | null
  code?: string
  error?: string
}

export type KernelInstallReport = {
  ok: boolean
  total: number
  ok_count: number
  failed_count: number
  items: KernelInstallItem[]
}

export function kernelCatalogQueryOptions() {
  return queryOptions({
    queryKey: ['panel', 'kernels'] as const,
    queryFn: () => api<KernelCatalog>('/api/panel/kernels'),
  })
}

export function pullKernelRelease(body: {
  kernel: ReleaseKernelId
  tag?: string
}) {
  return api<{
    kernel: KernelProduct
    release?: { tag: string; version: string; asset: string }
  }>('/api/panel/kernels/pull', {
    method: 'POST',
    body: JSON.stringify(body),
  })
}

export function installKernelTargets(targets: KernelTarget[]) {
  return api<KernelInstallReport>('/api/panel/kernels/install', {
    method: 'POST',
    body: JSON.stringify({ targets }),
  })
}

// Fleet actions outside /wrap still consume the existing runtime-sync report.
export type WrapSyncReport = {
  ok?: boolean
  src?: string
  meta?: {
    source?: string
    source_vm?: string
    captured_at?: string
    kernel?: string
    release_tag?: string
    glibc_shim?: boolean
    files?: string[]
  } | null
  total?: number
  ok_count?: number
  failed_count?: number
  items?: {
    id?: string
    ok?: boolean
    error?: string
    code?: string
    kernel?: { ok?: boolean; skipped?: boolean; error?: string }
  }[]
}
