import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  CheckCircle2,
  Download,
  Loader2,
  Terminal,
  TriangleAlert,
  Upload,
} from 'lucide-react'
import { toast } from 'sonner'
import { api } from '@/lib/api'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog'
import { hermitPackageQueryOptions } from './queries'

type Receipt = {
  archive: { sha256: string; bytes: number }
  manifest_sha256: string
}
export function HermitPackageUpload({ disabled }: { disabled: boolean }) {
  const qc = useQueryClient()
  const packages = useQuery(hermitPackageQueryOptions())
  const item = packages.data?.item
  const [archive, setArchive] = useState<File | null>(null)
  const [receipt, setReceipt] = useState<File | null>(null)
  const install = useMutation({
    mutationFn: async () => {
      if (!archive || !receipt) throw new Error('请选择归档和 release.json')
      const expected = JSON.parse(await receipt.text()) as Receipt
      if (archive.size !== expected.archive.bytes)
        throw new Error('归档大小与清单不一致')
      return api('/api/panel/kernel-packages', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/gzip',
          'X-Kernel-Sha256': expected.archive.sha256,
          'X-Kernel-Bytes': String(expected.archive.bytes),
          'X-Kernel-Manifest-Sha256': expected.manifest_sha256,
        },
        body: archive,
      })
    },
    onSuccess: async () => {
      toast.success('当前内核包已更新，现有 VM 保持不变')
      await qc.invalidateQueries({ queryKey: ['kernel-packages'] })
    },
    onError: (error: Error) => toast.error(error.message),
  })
  const pull = useMutation({
    mutationFn: () =>
      api('/api/panel/kernel-packages/pull', {
        method: 'POST',
        body: JSON.stringify({}),
      }),
    onSuccess: async () => {
      toast.success('已拉取 Hermit 内核包，可在下方安装到 VM')
      await qc.invalidateQueries({ queryKey: ['kernel-packages'] })
    },
    onError: (error: Error) => toast.error(error.message),
  })
  const busy = disabled || install.isPending || pull.isPending
  return (
    <div className='grid gap-3 p-4 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-center sm:px-5'>
      <div className='min-w-0'>
        <div className='flex flex-wrap items-center gap-2.5'>
          <Terminal
            aria-hidden='true'
            className='size-5 text-muted-foreground'
          />
          <h3 className='text-lg font-semibold'>Hermit</h3>
          <Badge variant='secondary'>内核包</Badge>
        </div>
        <div className='mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-base sm:text-sm'>
          <span
            className={`inline-flex items-center gap-1.5 ${packages.data?.item ? 'text-primary' : 'text-muted-foreground'}`}
          >
            {packages.data?.item ? (
              <CheckCircle2 aria-hidden='true' className='size-4' />
            ) : (
              <TriangleAlert aria-hidden='true' className='size-4' />
            )}
            {packages.isPending
              ? '加载中'
              : packages.data?.item
                ? '已就绪'
                : '未就绪'}
          </span>
          <span className='text-muted-foreground'>
            {packages.data?.item
              ? `${packages.data.item.version} · ${packages.data.item.target}`
              : '上传内核包或拉取最新版本'}
          </span>
        </div>
        {packages.error && (
          <p role='alert' className='mt-2 text-sm text-destructive'>
            {packages.error.message}
          </p>
        )}
      </div>
      <div className='flex flex-wrap gap-2'>
        <Dialog>
          <DialogTrigger asChild>
            <Button variant='outline' className='h-11' disabled={busy}>
              <Upload aria-hidden='true' />
              上传内核包
            </Button>
          </DialogTrigger>
          <DialogContent className='max-h-[85dvh] overflow-y-auto sm:max-w-3xl'>
            <DialogHeader>
              <DialogTitle>Hermit 内核包</DialogTitle>
              <DialogDescription>
                上传内核包和 release.json。新包替换当前安装包。现有 VM
                在重装后更新。
              </DialogDescription>
            </DialogHeader>
            <fieldset disabled={busy} className='min-w-0 space-y-3'>
              <div className='flex flex-wrap items-center gap-3'>
                <label className='text-sm'>
                  版本归档{' '}
                  <input
                    aria-label='Hermit 版本归档'
                    className='block w-full min-w-0'
                    type='file'
                    accept='.gz'
                    onChange={(event) =>
                      setArchive(event.target.files?.[0] || null)
                    }
                  />
                </label>
                <label className='text-sm'>
                  release.json{' '}
                  <input
                    aria-label='Hermit 发布清单'
                    className='block w-full min-w-0'
                    type='file'
                    accept='.json'
                    onChange={(event) =>
                      setReceipt(event.target.files?.[0] || null)
                    }
                  />
                </label>
                <Button
                  disabled={!archive || !receipt || install.isPending}
                  onClick={() => install.mutate()}
                >
                  更新内核包
                </Button>
              </div>
              {packages.error && (
                <p className='text-sm text-destructive'>
                  {packages.error.message}
                </p>
              )}
              {item && (
                <div
                  key={`${item.target}/${item.version}`}
                  className='flex flex-wrap items-center justify-between gap-3 rounded border p-3'
                >
                  <div>
                    <p className='font-medium'>
                      {item.version} · {item.target}
                    </p>
                    <p className='text-sm text-muted-foreground'>
                      Claude Code {item.cli.version} ·{' '}
                      {item.capabilities.production
                        ? '生产包'
                        : '仅完成模拟验收，不能激活生产槽位'}
                    </p>
                  </div>
                </div>
              )}
            </fieldset>
          </DialogContent>
        </Dialog>
        <Button
          variant='outline'
          className='h-11'
          aria-label='拉取 Hermit 最新内核包'
          disabled={busy}
          aria-busy={pull.isPending}
          onClick={() => pull.mutate()}
        >
          {pull.isPending ? (
            <Loader2 aria-hidden='true' className='animate-spin' />
          ) : (
            <Download aria-hidden='true' />
          )}
          {pull.isPending ? '拉取中…' : '拉取最新'}
        </Button>
      </div>
    </div>
  )
}
