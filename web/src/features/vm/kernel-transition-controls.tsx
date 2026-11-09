import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { api } from '@/lib/api'
import { Button } from '@/components/ui/button'
import { ConfirmDialog } from '@/components/confirm-dialog'

export type HermitPackage = {
  version: string
  target: string
  acceptance: string
  capabilities: {
    production: boolean
    helper_integration?: boolean
    https_upstream?: boolean
    switch_readiness?: boolean
  }
}
type Transition = { state: string; can_rollback: boolean; code?: string | null }
type Action = 'apply' | 'rollback' | 'finalize'

export function KernelTransitionControls({
  ids,
  target,
  disabled = false,
  recovery = true,
}: {
  ids: string[]
  target?: { dataplane: 'hermit'; target: string; version: string }
  disabled?: boolean
  recovery?: boolean
}) {
  const qc = useQueryClient()
  const [confirm, setConfirm] = useState<Action | null>(null)
  const [results, setResults] = useState<string[]>([])
  const states = useQuery({
    queryKey: ['kernel-transitions', ids],
    enabled: ids.length > 0,
    queryFn: () =>
      Promise.all(
        ids.map(async (id) => ({
          id,
          ...(await api<{ transition: Transition | null }>(
            `/api/panel/vms/${encodeURIComponent(id)}/kernel-transition`
          )),
        }))
      ),
    refetchInterval: 5000,
  })
  const pending =
    states.data?.filter((row) => row.transition?.can_rollback) || []
  const mutation = useMutation({
    mutationFn: async (action: Action) => {
      const receipts: string[] = []
      for (const id of ids) {
        if (action !== 'apply' && !pending.some((row) => row.id === id))
          continue
        try {
          const result = await api<{ unchanged?: boolean }>(
            `/api/panel/vms/${encodeURIComponent(id)}/kernel-transition`,
            {
              method: 'POST',
              body: JSON.stringify({ action, target }),
            }
          )
          receipts.push(
            `${id}：${action === 'apply' ? (result.unchanged ? '当前版本和运行状态保持不变' : '切换完成，可回滚') : action === 'rollback' ? '回滚完成' : '已确认当前内核'}`
          )
        } catch (error) {
          receipts.push(
            `${id}：${error instanceof Error ? error.message : '操作失败'}`
          )
        }
      }
      return receipts
    },
    onSuccess: (receipts) => {
      setResults(receipts)
      setConfirm(null)
    },
    onSettled: async () => {
      await Promise.all([
        qc.invalidateQueries({ queryKey: ['kernel-transitions'] }),
        qc.invalidateQueries({ queryKey: ['panel', 'dashboard'] }),
        qc.invalidateQueries({ queryKey: ['panel', 'vms'] }),
        ...ids.map((id) =>
          qc.invalidateQueries({ queryKey: ['panel', 'vm', id] })
        ),
      ])
    },
  })
  const busy = mutation.isPending || states.isFetching
  return (
    <div className='space-y-2'>
      <div className='flex flex-wrap gap-2'>
        {target && (
          <Button
            disabled={
              disabled ||
              !ids.length ||
              busy ||
              pending.length > 0 ||
              states.isError
            }
            onClick={() => {
              setResults([])
              setConfirm('apply')
            }}
          >
            切换并应用
          </Button>
        )}
        {recovery && pending.length > 0 && (
          <>
            <Button
              variant='outline'
              disabled={busy}
              onClick={() => setConfirm('rollback')}
            >
              回滚上次切换
            </Button>
            <Button
              variant='outline'
              disabled={
                busy ||
                pending.some((row) => row.transition?.state !== 'applied')
              }
              onClick={() => setConfirm('finalize')}
            >
              确认保留当前内核
            </Button>
          </>
        )}
      </div>
      {recovery &&
        pending.map((row) => (
          <p key={row.id} className='text-xs text-muted-foreground'>
            {row.id}：
            {row.transition?.state === 'applied'
              ? '切换已完成，可回滚。确认后删除旧容器。'
              : '切换未完成，请回滚。'}{' '}
            {row.transition?.code}
          </p>
        ))}
      {states.error && (
        <p role='alert' className='text-sm text-destructive'>
          {states.error.message}
        </p>
      )}
      {results.map((message) => (
        <p key={message} role='status' className='text-sm'>
          {message}
        </p>
      ))}
      <ConfirmDialog
        open={confirm !== null}
        onOpenChange={(open) => {
          if (!open && !mutation.isPending) setConfirm(null)
        }}
        title={
          confirm === 'apply'
            ? '切换所选槽位的内核？'
            : confirm === 'rollback'
              ? '回滚所选槽位？'
              : '确认当前内核？'
        }
        desc={
          confirm === 'finalize'
            ? '删除本次切换保留的旧容器。确认后不能通过本记录回滚。'
            : '先结束这些槽位的工具调用。系统暂停本槽调度并等待在途请求结束。切换会重建本槽容器。系统保留凭据和本地会话文件。内核启动失败时自动回滚。原来停止的槽位仍保持停止。'
        }
        confirmText={confirm === 'finalize' ? '删除旧容器并确认' : '执行'}
        cancelBtnText='取消'
        isLoading={mutation.isPending}
        handleConfirm={() => {
          if (confirm) mutation.mutate(confirm)
        }}
      />
    </div>
  )
}

export function HermitSlotSwitch({
  id,
  disabled,
}: {
  id: string
  disabled: boolean
}) {
  const [value, setValue] = useState('')
  const packages = useQuery({
    queryKey: ['kernel-packages'],
    queryFn: () =>
      api<{ items: HermitPackage[] }>('/api/panel/kernel-packages'),
  })
  const selected = packages.data?.items.find(
    (p) => `${p.target}/${p.version}` === value
  )
  const qualified =
    selected?.acceptance === 'production' &&
    selected.capabilities.production &&
    selected.capabilities.helper_integration &&
    selected.capabilities.https_upstream &&
    selected.capabilities.switch_readiness
  return (
    <div className='mt-4 space-y-2 border-t pt-3'>
      <label className='text-sm'>
        Hermit 版本{' '}
        <select
          aria-label='Hermit 版本'
          className='rounded border bg-background p-1'
          disabled={disabled}
          value={value}
          onChange={(e) => setValue(e.target.value)}
        >
          <option value=''>请选择已安装版本</option>
          {packages.data?.items.map((p) => (
            <option
              key={`${p.target}/${p.version}`}
              value={`${p.target}/${p.version}`}
            >
              {p.version} · {p.target}
              {p.capabilities.production ? '' : ' · 模拟验收包'}
            </option>
          ))}
        </select>
      </label>
      {packages.error && (
        <p role='alert' className='text-sm text-destructive'>
          {packages.error.message}
        </p>
      )}
      <KernelTransitionControls
        ids={[id]}
        target={
          selected
            ? {
                dataplane: 'hermit',
                target: selected.target,
                version: selected.version,
              }
            : undefined
        }
        disabled={disabled || !qualified}
      />
      {selected && !qualified && (
        <p className='text-xs text-muted-foreground'>
          该版本未获生产资格，不能应用到生产槽位。
        </p>
      )}
    </div>
  )
}
