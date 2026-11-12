import { useMemo, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Link } from '@tanstack/react-router'
import type { Vm } from '@/types/panel-vm'
import {
  CheckCircle2,
  Download,
  Loader2,
  Power,
  RefreshCw,
  Terminal,
  TriangleAlert,
  X,
} from 'lucide-react'
import { toast } from 'sonner'
import { isApiError } from '@/lib/api'
import { cn } from '@/lib/utils'
import { isCodexVm } from '@/lib/vm-kind'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Progress } from '@/components/ui/progress'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Skeleton } from '@/components/ui/skeleton'
import { ConfirmDialog } from '@/components/confirm-dialog'
import { PageHeader } from '@/components/page-header'
import { QueryGate } from '@/components/query-gate'
import { meQueryOptions } from '@/features/auth/queries'
import { dashboardQueryOptions } from '@/features/overview/queries'
import { dataplaneLabel } from '@/features/vm/dataplane-contract'
import { KernelTransitionControls } from '@/features/vm/kernel-transition-controls'
import { isRemoteVm } from '@/features/vm/placement'
import { HermitPackageUpload } from './hermit-package'
import {
  installKernelTargets,
  hermitPackageQueryOptions,
  hermitPackageReady,
  type ReleaseKernelId,
  kernelCatalogQueryOptions,
  pullKernelRelease,
  type KernelId,
  type KernelInstallItem,
  type KernelTarget,
} from './queries'

const KERNEL_NAMES = {
  'cli-node': 'cli-node',
  hermit: 'Hermit',
} as const
const VM_STATUS: Record<string, string> = {
  running: '运行中',
  stopped: '已停用',
  created: '未启动',
  unknown: '未知',
  error: '异常',
}

type InstallProgress = {
  total: number
  completed: number
  activeId: string | null
  results: Record<string, KernelInstallItem>
}

export function WrapSamplePage() {
  const qc = useQueryClient()
  const catalog = useQuery(kernelCatalogQueryOptions())
  const packages = useQuery(hermitPackageQueryOptions())
  const dashboard = useQuery(dashboardQueryOptions())
  const me = useQuery(meQueryOptions())
  const canEdit = me.data?.role === 'admin'
  const [drafts, setDrafts] = useState<Record<string, KernelId>>({})
  const [confirm, setConfirm] = useState<KernelTarget[] | null>(null)
  const [installing, setInstalling] = useState(false)
  const [job, setJob] = useState<InstallProgress | null>(null)
  const [pullError, setPullError] = useState<{
    kernel: KernelId
    message: string
  } | null>(null)
  const rows = useMemo<{ vm: Vm; kernel: KernelId }[]>(
    () =>
      (dashboard.data?.vms || [])
        .filter((vm) => !isCodexVm(vm))
        .map((vm) => ({
          vm,
          kernel:
            drafts[vm.id] ??
            (vm.resolved_dataplane === 'hermit' ? 'hermit' : 'cli-node'),
        })),
    [dashboard.data?.vms, drafts]
  )
  const vmById = useMemo(
    () => new Map(rows.map(({ vm }) => [vm.id, vm])),
    [rows]
  )
  const pull = useMutation({
    mutationFn: (kernel: ReleaseKernelId) => pullKernelRelease({ kernel }),
    onMutate: () => setPullError(null),
    onSuccess: async (_data, kernel) => {
      await qc.invalidateQueries({
        queryKey: kernelCatalogQueryOptions().queryKey,
      })
      toast.success(`${KERNEL_NAMES[kernel]} 安装包已更新`)
    },
    onError: (error: Error, kernel) => {
      setPullError({ kernel, message: error.message })
    },
  })
  const busy = installing || pull.isPending
  function targetFor(vm: Vm, kernel: KernelId): KernelTarget {
    if (kernel !== 'hermit') return { id: vm.id, kernel }
    return {
      id: vm.id,
      kernel,
      manifest_sha256: packages.data?.item?.manifest_sha256,
    }
  }
  const allTargets = rows.map(({ vm, kernel }) => targetFor(vm, kernel))
  const failedCount = job
    ? Object.values(job.results).filter((item) => !item.ok).length
    : 0
  const succeededCount = job
    ? Object.values(job.results).filter((item) => item.ok).length
    : 0
  function requestInstall(targets: KernelTarget[]) {
    if (!canEdit || busy || !targets.length) return
    const invalidHermit = targets.find(
      (target) =>
        target.kernel === 'hermit' &&
        (!packages.data?.item ||
          !hermitPackageReady(packages.data.item) ||
          packages.data.item.manifest_sha256 !== target.manifest_sha256)
    )
    if (invalidHermit) {
      toast.error(
        `${vmById.get(invalidHermit.id)?.name || invalidHermit.id}：请先上传可用于生产的 Hermit 内核包`
      )
      return
    }
    if (
      targets.some(
        (target) => vmById.get(target.id)?.kernel_transition?.can_rollback
      )
    ) {
      toast.error('请先回滚或确认上次切换')
      return
    }
    const missingPackage = targets.find(
      (target) =>
        target.kernel !== 'hermit' &&
        !catalog.data?.kernels.some((p) => p.id === target.kernel && p.ready)
    )
    if (missingPackage) {
      toast.error(`请先下载 ${KERNEL_NAMES[missingPackage.kernel]} 安装包`)
      return
    }
    const unsupported = targets.find((target) => {
      const vm = vmById.get(target.id)
      return (
        target.kernel === 'hermit' &&
        vm &&
        (isRemoteVm(vm) || vm.runtime_type === 'kvm')
      )
    })
    if (unsupported) {
      toast.error(
        `${vmById.get(unsupported.id)?.name || unsupported.id} 仅能安装默认内核`
      )
      return
    }
    setConfirm(targets)
  }

  async function runInstall(targets: KernelTarget[]) {
    setConfirm(null)
    setInstalling(true)
    setJob({
      total: targets.length,
      completed: 0,
      activeId: targets[0].id,
      results: {},
    })
    let failures = 0
    try {
      for (let index = 0; index < targets.length; index++) {
        const target = targets[index]
        setJob((previous) =>
          previous ? { ...previous, activeId: target.id } : previous
        )
        let result: KernelInstallItem
        try {
          const report = await installKernelTargets([target])
          const item = report.items.find(
            (entry) => entry.id === target.id && entry.kernel === target.kernel
          )
          result = item || {
            ...target,
            ok: false,
            stopped: false,
            error: '未收到该 VM 的安装结果',
          }
          if (result.ok && !result.stopped)
            result = { ...result, ok: false, error: '服务未确认关闭' }
        } catch (error) {
          const data = isApiError(error)
            ? (error.data as { items?: KernelInstallItem[] } | undefined)
            : undefined
          const item = Array.isArray(data?.items)
            ? data.items.find((entry) => entry.id === target.id)
            : undefined
          result = {
            ...target,
            ok: false,
            stopped: item?.stopped === true,
            code: item?.code || (isApiError(error) ? error.code : undefined),
            error:
              item?.error ||
              (error instanceof Error ? error.message : '安装失败'),
          }
        }
        if (!result.ok) failures++
        setJob((previous) =>
          previous
            ? {
                ...previous,
                completed: index + 1,
                results: { ...previous.results, [target.id]: result },
              }
            : previous
        )
      }
      if (failures)
        toast.error(
          `${targets.length - failures}/${targets.length} 台安装成功，请检查失败项`
        )
      else toast.success(`${targets.length} 台内核已安装，服务保持关闭`)
    } finally {
      setJob((previous) =>
        previous ? { ...previous, activeId: null } : previous
      )
      await Promise.all([
        qc.invalidateQueries({
          queryKey: kernelCatalogQueryOptions().queryKey,
        }),
        qc.invalidateQueries({ queryKey: dashboardQueryOptions().queryKey }),
        qc.invalidateQueries({ queryKey: ['panel', 'vms'] }),
      ])
      setInstalling(false)
    }
  }

  return (
    <PageHeader
      title='内核'
      description='默认内核使用 cli-node，Hermit 支持上传内核包。'
      extra={
        <Button
          variant='ghost'
          className='h-11'
          disabled={busy}
          onClick={() => {
            void catalog.refetch()
            void dashboard.refetch()
            void qc.invalidateQueries({ queryKey: ['kernel-packages'] })
          }}
        >
          <RefreshCw aria-hidden='true' />
          刷新
        </Button>
      }
    >
      <QueryGate
        loading={catalog.isLoading || dashboard.isLoading}
        error={catalog.error || dashboard.error}
        skeleton={
          <div className='space-y-6'>
            <Skeleton className='h-48 rounded-xl' />
            <Skeleton className='h-80 rounded-xl' />
          </div>
        }
      >
        <div className='space-y-7 motion-reduce:[&_svg]:animate-none'>
          <section
            aria-label='可用内核'
            className='divide-y rounded-xl border bg-card'
          >
            {catalog.data?.kernels.map((product) => (
              <div
                key={product.id}
                className='grid gap-3 p-4 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-center sm:px-5'
              >
                <div className='min-w-0'>
                  <div className='flex flex-wrap items-center gap-2.5'>
                    <Terminal
                      aria-hidden='true'
                      className='size-5 text-muted-foreground'
                    />
                    <h3 className='text-lg font-semibold'>
                      {KERNEL_NAMES[product.id]}
                    </h3>
                    <Badge variant='secondary'>默认内核</Badge>
                  </div>
                  <div className='mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-base sm:text-sm'>
                    <span
                      className={cn(
                        'inline-flex items-center gap-1.5',
                        product.ready ? 'text-primary' : 'text-muted-foreground'
                      )}
                    >
                      {product.ready ? (
                        <CheckCircle2 aria-hidden='true' className='size-4' />
                      ) : (
                        <TriangleAlert aria-hidden='true' className='size-4' />
                      )}
                      {product.ready ? '已下载' : '未就绪'}
                    </span>
                    <span className='text-muted-foreground'>
                      {product.version || '版本未记录'}
                    </span>
                  </div>
                  {product.error && !product.ready ? (
                    <p className='mt-2 text-base break-words text-destructive sm:text-sm'>
                      {product.error}
                    </p>
                  ) : null}
                  {pullError?.kernel === product.id ? (
                    <p
                      role='alert'
                      className='mt-2 flex items-start gap-2 text-base text-destructive sm:text-sm'
                    >
                      <TriangleAlert
                        aria-hidden='true'
                        className='mt-0.5 size-4 shrink-0'
                      />
                      <span className='min-w-0 break-words'>
                        {pullError.message}
                      </span>
                    </p>
                  ) : null}
                </div>
                <Button
                  variant='outline'
                  className='h-11'
                  aria-label={`拉取 ${KERNEL_NAMES[product.id]} 最新二进制`}
                  disabled={!canEdit || busy}
                  loading={pull.isPending && pull.variables === product.id}
                  onClick={() => pull.mutate(product.id)}
                >
                  <Download aria-hidden='true' />
                  拉取最新
                </Button>
              </div>
            ))}
            <HermitPackageUpload disabled={!canEdit || busy} />
          </section>

          <section aria-labelledby='kernel-vms-heading' className='space-y-3'>
            <div className='flex flex-wrap items-end justify-between gap-3'>
              <div>
                <h3 id='kernel-vms-heading' className='text-lg font-semibold'>
                  VM 安装
                </h3>
                <p className='mt-1 text-base text-muted-foreground sm:text-sm'>
                  按所选内核重装，完成后保持停用。
                </p>
              </div>
              <Button
                variant='destructive'
                className='h-11'
                disabled={!canEdit || busy || !rows.length}
                loading={installing && (job?.total || 0) > 1}
                onClick={() => requestInstall(allTargets)}
              >
                <Power aria-hidden='true' />
                全部重装并停用{rows.length ? ` · ${rows.length} 台` : ''}
              </Button>
            </div>

            {job ? (
              <div
                role='status'
                aria-live='polite'
                className='space-y-2 rounded-lg bg-muted/60 p-3'
              >
                <div className='flex flex-wrap items-center justify-between gap-2 text-base sm:text-sm'>
                  <span className='inline-flex items-center gap-2'>
                    {installing ? (
                      <Loader2
                        aria-hidden='true'
                        className='size-4 animate-spin motion-reduce:animate-none'
                      />
                    ) : failedCount ? (
                      <TriangleAlert
                        aria-hidden='true'
                        className='size-4 text-destructive'
                      />
                    ) : (
                      <CheckCircle2
                        aria-hidden='true'
                        className='size-4 text-primary'
                      />
                    )}
                    {installing
                      ? `正在安装 ${Math.min(job.completed + (job.activeId ? 1 : 0), job.total)}/${job.total}`
                      : `已完成：${succeededCount} 台成功${failedCount ? `，${failedCount} 台失败` : ''}`}
                  </span>
                  {!installing ? (
                    <Button
                      variant='ghost'
                      className='size-11 p-0'
                      aria-label='收起安装结果'
                      onClick={() => setJob(null)}
                    >
                      <X aria-hidden='true' />
                    </Button>
                  ) : null}
                </div>
                <Progress
                  aria-label='内核安装进度'
                  value={(job.completed / job.total) * 100}
                  className='h-1.5'
                />
              </div>
            ) : null}

            {!rows.length ? (
              <div className='rounded-xl border border-dashed py-12 text-center text-muted-foreground'>
                暂无 Claude VM。
                <Link to='/vm' className='ml-2 underline underline-offset-4'>
                  前往创建
                </Link>
              </div>
            ) : (
              <div
                role='table'
                aria-label='VM 内核安装'
                aria-colcount={4}
                className='overflow-hidden rounded-xl border bg-card'
              >
                <div
                  role='row'
                  className='hidden grid-cols-[minmax(160px,1fr)_minmax(180px,230px)_minmax(160px,1fr)_120px] gap-4 border-b bg-muted/40 px-5 py-3 text-sm text-muted-foreground xl:grid'
                >
                  <div role='columnheader'>虚拟机</div>
                  <div role='columnheader'>安装内核</div>
                  <div role='columnheader'>当前内核</div>
                  <div role='columnheader' className='text-right'>
                    操作
                  </div>
                </div>
                <div role='rowgroup' className='divide-y'>
                  {rows.map(({ vm, kernel }) => {
                    const installed = catalog.data?.installations?.[vm.id]
                    const result = job?.results[vm.id]
                    const active = installing && job?.activeId === vm.id
                    const nativeUnsupported =
                      isRemoteVm(vm) || vm.runtime_type === 'kvm'
                    const currentKernel =
                      vm.resolved_dataplane === 'hermit'
                        ? 'hermit'
                        : vm.resolved_dataplane === 'wrap' ||
                            vm.resolved_dataplane === 'cc'
                          ? 'cli-node'
                          : null
                    const changed =
                      kernel !== currentKernel ||
                      (kernel === 'hermit' &&
                        targetFor(vm, kernel).manifest_sha256 !==
                          vm.kernel_package?.manifest_sha256)
                    return (
                      <div
                        role='row'
                        key={vm.id}
                        className='grid min-w-0 gap-3 p-4 sm:grid-cols-2 sm:gap-4 xl:grid-cols-[minmax(160px,1fr)_minmax(180px,230px)_minmax(160px,1fr)_120px] xl:items-center xl:px-5'
                      >
                        <div role='cell' className='min-w-0'>
                          <Link
                            to='/vm/$id'
                            params={{ id: vm.id }}
                            className='inline-block min-h-11 max-w-full content-center truncate font-medium underline-offset-4 hover:underline'
                          >
                            {vm.name || vm.id}
                          </Link>
                          <div className='flex flex-wrap items-center gap-2 text-base text-muted-foreground sm:text-sm'>
                            <span
                              className={cn(
                                'size-1.5 rounded-full',
                                vm.status === 'running'
                                  ? 'bg-primary'
                                  : 'bg-muted-foreground/60'
                              )}
                              aria-hidden='true'
                            />
                            {result?.stopped
                              ? '已停用'
                              : VM_STATUS[vm.status || 'unknown'] ||
                                vm.status ||
                                '未知'}
                            {installed?.version &&
                            installed.kernel === currentKernel ? (
                              <span>{installed.version}</span>
                            ) : null}
                          </div>
                          {result ? (
                            <p
                              className={cn(
                                'mt-2 flex min-w-0 items-start gap-2 text-base break-words sm:text-sm',
                                result.ok ? 'text-primary' : 'text-destructive'
                              )}
                            >
                              {result.ok ? (
                                <CheckCircle2
                                  aria-hidden='true'
                                  className='mt-0.5 size-4 shrink-0'
                                />
                              ) : (
                                <TriangleAlert
                                  aria-hidden='true'
                                  className='mt-0.5 size-4 shrink-0'
                                />
                              )}
                              <span>
                                {result.ok
                                  ? '安装完成，服务已停用'
                                  : `${result.error || '安装失败'}${result.stopped ? '；服务已停用' : ''}`}
                              </span>
                            </p>
                          ) : null}
                        </div>
                        <div role='cell' className='min-w-0 space-y-1.5'>
                          <span className='text-sm text-muted-foreground xl:hidden'>
                            安装内核
                          </span>
                          <Select
                            value={kernel}
                            disabled={!canEdit || busy}
                            onValueChange={(value) => {
                              if (value === 'cli-node' || value === 'hermit')
                                setDrafts((previous) => ({
                                  ...previous,
                                  [vm.id]: value,
                                }))
                            }}
                          >
                            <SelectTrigger
                              className='w-full text-base data-[size=default]:h-11 sm:text-sm'
                              aria-label={`${vm.name || vm.id} 安装内核`}
                            >
                              <SelectValue />
                            </SelectTrigger>
                            <SelectContent className='motion-reduce:animate-none [&_[role=option]]:min-h-11'>
                              <SelectItem value='cli-node'>
                                cli-node · 默认
                              </SelectItem>
                              <SelectItem
                                value='hermit'
                                disabled={nativeUnsupported}
                              >
                                Hermit
                              </SelectItem>
                            </SelectContent>
                          </Select>
                          {kernel === 'hermit' && (
                            <>
                              {packages.data?.item && (
                                <p className='text-sm text-muted-foreground'>
                                  当前安装包：{packages.data.item.version} ·{' '}
                                  {packages.data.item.target}
                                </p>
                              )}
                              {packages.error && (
                                <p
                                  role='alert'
                                  className='text-sm text-destructive'
                                >
                                  {packages.error.message}
                                </p>
                              )}
                              {!packages.isPending &&
                                (!packages.data?.item ||
                                  !hermitPackageReady(packages.data.item)) && (
                                  <p className='text-sm text-muted-foreground'>
                                    请先上传可用于生产的 Hermit 内核包。
                                  </p>
                                )}
                            </>
                          )}
                          {vm.kernel_transition?.can_rollback && (
                            <KernelTransitionControls
                              ids={[vm.id]}
                              disabled={!canEdit || busy}
                            />
                          )}
                          {changed ? (
                            <span className='text-sm text-muted-foreground'>
                              待安装
                            </span>
                          ) : null}
                        </div>
                        <div
                          role='cell'
                          className='flex min-w-0 flex-wrap items-center gap-2 sm:content-center'
                        >
                          <span className='text-base text-muted-foreground sm:text-sm'>
                            {dataplaneLabel(vm.resolved_dataplane)}
                          </span>
                        </div>
                        <div
                          role='cell'
                          className='flex items-center justify-end'
                        >
                          <Button
                            variant='outline'
                            className='h-11 w-full sm:w-auto'
                            disabled={
                              !canEdit ||
                              busy ||
                              (kernel === 'hermit' && nativeUnsupported)
                            }
                            loading={active}
                            aria-label={`${changed ? '安装' : '重装'} ${vm.name || vm.id} 并停用`}
                            onClick={() =>
                              requestInstall([targetFor(vm, kernel)])
                            }
                          >
                            <Power aria-hidden='true' />
                            {changed ? '安装' : '重装'}
                          </Button>
                        </div>
                      </div>
                    )
                  })}
                </div>
              </div>
            )}
            {!canEdit ? (
              <p className='text-sm text-muted-foreground'>
                仅管理员可安装或管理授权。
              </p>
            ) : null}
          </section>
        </div>
      </QueryGate>
      <ConfirmDialog
        open={confirm != null}
        onOpenChange={(open) => {
          if (!open) setConfirm(null)
        }}
        title={
          confirm?.length === 1
            ? `重装 ${vmById.get(confirm[0].id)?.name || confirm[0].id} 并停用？`
            : `重装全部 ${confirm?.length || 0} 台 VM 并停用？`
        }
        desc='按所选内核安装，完成后服务保持关闭。凭据和工作数据保留。涉及 Hermit 时会重建槽位容器并检查内核。安装成功后清理旧容器。'
        confirmText='重装并停用'
        cancelBtnText='取消'
        destructive
        className='motion-reduce:animate-none [&_button]:min-h-11'
        handleConfirm={() => {
          if (confirm) void runInstall(confirm)
        }}
      >
        <ul className='max-h-56 space-y-2 overflow-y-auto rounded-lg bg-muted/50 p-3 text-sm'>
          {confirm?.map((target) => (
            <li
              key={target.id}
              className='flex items-center justify-between gap-3'
            >
              <span className='min-w-0 truncate'>
                {vmById.get(target.id)?.name || target.id}
              </span>
              <span className='shrink-0 font-medium'>
                {KERNEL_NAMES[target.kernel]}
                {target.kernel === 'hermit' && packages.data?.item
                  ? ` · ${packages.data.item.version}`
                  : ''}
              </span>
            </li>
          ))}
        </ul>
      </ConfirmDialog>
    </PageHeader>
  )
}
