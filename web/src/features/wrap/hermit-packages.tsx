import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import { api } from '@/lib/api'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'

type Receipt = { archive: { sha256: string; bytes: number }; manifest_sha256: string }
type Package = { runtime: 'hermit'; version: string; target: string; manifest_sha256: string; acceptance: string; cli: { version: string }; capabilities: { production: boolean } }

export function HermitPackages({ ids }: { ids: string[] }) {
  const qc = useQueryClient()
  const packages = useQuery({ queryKey: ['kernel-packages'], queryFn: () => api<{ items: Package[] }>('/api/panel/kernel-packages') })
  const [archive, setArchive] = useState<File | null>(null)
  const [receipt, setReceipt] = useState<File | null>(null)
  const install = useMutation({
    mutationFn: async () => {
      if (!archive || !receipt) throw new Error('请选择归档和 release.json')
      const expected = JSON.parse(await receipt.text()) as Receipt
      if (archive.size !== expected.archive.bytes) throw new Error('归档大小与清单不一致')
      return api('/api/panel/kernel-packages', { method: 'POST', headers: {
        'Content-Type': 'application/gzip', 'X-Kernel-Sha256': expected.archive.sha256,
        'X-Kernel-Bytes': String(expected.archive.bytes), 'X-Kernel-Manifest-Sha256': expected.manifest_sha256,
      }, body: archive })
    },
    onSuccess: async () => { toast.success('版本已安装，槽位保持不变'); await qc.invalidateQueries({ queryKey: ['kernel-packages'] }) },
    onError: (error: Error) => toast.error(error.message),
  })
  const select = useMutation({
    mutationFn: (item: Package) => {
      if (!ids.length) throw new Error('请先选择 Claude 槽位')
      return api('/api/panel/dataplane', { method: 'POST', body: JSON.stringify({
        dataplane: 'hermit', ids, version: item.version, target: item.target, restart: false,
      }) })
    },
    onSuccess: async () => { toast.success('已暂存 Hermit 版本，当前运行内核保持不变'); await qc.invalidateQueries({ queryKey: ['dashboard'] }) },
    onError: (error: Error) => toast.error(error.message),
  })
  return <Card className='mb-4'>
    <CardHeader><CardTitle>Hermit 内核包</CardTitle></CardHeader>
    <CardContent className='space-y-3'>
      <p className='text-sm text-muted-foreground'>安装精简版本包。固定 Claude Code 按摘要共享缓存。安装不切换槽位。</p>
      <div className='flex flex-wrap items-center gap-3'>
        <label className='text-sm'>版本归档 <input aria-label='Hermit 版本归档' type='file' accept='.gz' onChange={event => setArchive(event.target.files?.[0] || null)} /></label>
        <label className='text-sm'>release.json <input aria-label='Hermit 发布清单' type='file' accept='.json' onChange={event => setReceipt(event.target.files?.[0] || null)} /></label>
        <Button disabled={!archive || !receipt || install.isPending} onClick={() => install.mutate()}>安装版本</Button>
      </div>
      {packages.error && <p className='text-sm text-destructive'>{packages.error.message}</p>}
      {packages.data?.items.map(item => <div key={`${item.target}/${item.version}`} className='flex flex-wrap items-center justify-between gap-3 rounded border p-3'>
        <div><p className='font-medium'>{item.version} · {item.target}</p><p className='text-sm text-muted-foreground'>Claude Code {item.cli.version} · {item.capabilities.production ? '生产包' : '仅完成模拟验收，不能激活生产槽位'}</p></div>
        <Button variant='outline' disabled={!ids.length || select.isPending} onClick={() => select.mutate(item)}>暂存到所选槽位</Button>
      </div>)}
    </CardContent>
  </Card>
}
