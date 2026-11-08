import { useEffect, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { ArrowUpCircle, Copy, ExternalLink, RefreshCw } from 'lucide-react'
import { toast } from 'sonner'
import { ApiError, api, isApiError } from '@/lib/api'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { ConfirmDialog } from '@/components/confirm-dialog'
import {
  changelogQueryOptions,
  versionQueryOptions,
  type ChangelogEntry,
  type ReleaseStatus,
} from '@/features/settings/queries'

async function copyText(text: string) {
  await navigator.clipboard.writeText(text)
}

type OfflineTask = {
  task_id: string
  result: string
  phase: string
  source_revision: string
  events: { phase: string; time: number }[]
}
const upgradePhases: Record<string, string> = {
  queued: '等待执行',
  preflight: '检查发布包',
  drain: '等待请求结束',
  backup: '备份数据',
  replace: '切换版本',
  verify: '验证服务',
  resume: '恢复调度',
  active: '升级完成',
  rollback: '恢复原版本',
  rolled_back: '已恢复原版本',
  failed: '升级失败',
  recovery_required: '需要人工恢复',
  executor_failed: '执行器异常退出',
}

export function AboutPane() {
  const offline = useQuery({
    queryKey: ['panel', 'upgrade-task'],
    queryFn: () => api<{ task: OfflineTask | null }>('/api/panel/upgrade-task'),
    refetchInterval: 2000,
  })
  const offlineTask = offline.data?.task
  const qc = useQueryClient()
  const [upgradeTarget, setUpgradeTarget] = useState<string | null>(null)
  const version = useQuery({
    ...versionQueryOptions(),
    enabled: offline.isSuccess && !offlineTask,
    refetchInterval: (query) =>
      upgradeTarget || query.state.data?.upgrade?.state === 'running'
        ? 2000
        : false,
  })
  const changelog = useQuery(changelogQueryOptions())
  const [confirmOpen, setConfirmOpen] = useState(false)
  const data = version.data
  const checkFailed =
    version.isError || !!data?.source_error || data?.check_status === 'failed'
  const updateRunning = !!upgradeTarget || data?.upgrade?.state === 'running'

  useEffect(() => {
    if (!upgradeTarget) return
    if (data?.upgrade?.target !== upgradeTarget) return
    if (data.upgrade.state === 'failed') {
      setUpgradeTarget(null)
      toast.error('升级失败，后端未完成验证，请检查更新日志')
    } else if (
      data.upgrade.state === 'succeeded' &&
      data.current_tag === upgradeTarget
    ) {
      setUpgradeTarget(null)
      window.location.reload()
    }
  }, [data, upgradeTarget])

  const upgrade = useMutation({
    mutationFn: () =>
      api<ReleaseStatus>('/api/panel/update', {
        method: 'POST',
        body: JSON.stringify({
          confirm: true,
          version: data?.latest_tag,
        }),
      }),
    onSuccess: async (payload) => {
      setConfirmOpen(false)
      if (payload?.message === 'already_latest') {
        toast.success(`已是最新 ${payload.current_tag}`)
        return
      }
      if (payload?.started) {
        setUpgradeTarget(payload.target || payload.latest_tag)
        qc.setQueryData(versionQueryOptions().queryKey, payload)
        toast.info(`正在升级到 ${payload.target || payload.latest_tag}`)
      }
    },
    onError: (error: Error) => {
      setConfirmOpen(false)
      if (isApiError(error) && error.code === 'host_upgrade_required') {
        const command =
          (error.data as { command?: string } | undefined)?.command ||
          data?.upgrade_command
        toast.error(error.message)
        if (command) {
          copyText(command)
            .then(() => toast.success('已复制宿主机命令'))
            .catch(() => undefined)
        }
        return
      }
      if (
        error instanceof TypeError ||
        /failed to fetch|network|load failed/i.test(error.message)
      ) {
        toast.info('连接中断，正在检查后端更新状态')
        void qc.invalidateQueries({ queryKey: versionQueryOptions().queryKey })
        return
      }
      toast.error(error.message)
    },
  })

  const rawEntries =
    data?.changelog && data.changelog.length > 0
      ? data.changelog
      : changelog.data?.entries?.filter(
          (entry) => entry.version !== 'unreleased'
        ) || []
  const entries = data?.update_available ? rawEntries : rawEntries.slice(0, 8)

  return (
    <div className='space-y-3'>
      {offlineTask && (
        <Card>
          <CardHeader>
            <CardTitle>本机发布升级</CardTitle>
          </CardHeader>
          <CardContent className='space-y-2'>
            <p>当前版本：{changelog.data?.current || '读取中'}</p>
            <p>{upgradePhases[offlineTask.phase] || offlineTask.phase}</p>
            <p className='text-sm text-muted-foreground'>
              目标提交：{offlineTask.source_revision.slice(0, 12)}
            </p>
            {offlineTask.result === 'RUNNING' && (
              <p className='text-sm'>任务独立运行。关闭页面不会中断升级。</p>
            )}
            {offlineTask.result === 'ROLLED_BACK' && (
              <p className='text-sm'>升级失败，已恢复原版本。</p>
            )}
            {offlineTask.result === 'RECOVERY_REQUIRED' && (
              <p className='text-sm text-destructive'>
                请检查任务记录并执行恢复操作。
              </p>
            )}
            <ul className='space-y-1 text-sm text-muted-foreground'>
              {offlineTask.events.slice(0, -1).map((event, index) => (
                <li key={`${event.phase}-${index}`}>
                  {upgradePhases[event.phase] || event.phase}：
                  {Math.max(
                    0,
                    Math.round(offlineTask.events[index + 1].time - event.time)
                  )}{' '}
                  秒
                </li>
              ))}
            </ul>
            <p className='text-sm text-muted-foreground'>
              使用本机验收后的发布包提交下一次升级。
            </p>
          </CardContent>
        </Card>
      )}
      {!offlineTask && (
        <>
          <Card>
            <CardHeader className='flex flex-row items-center justify-between space-y-0'>
              <CardTitle>版本</CardTitle>
              <Button
                size='sm'
                variant='outline'
                onClick={() => version.refetch()}
                loading={version.isFetching}
              >
                <RefreshCw />
                检查更新
              </Button>
            </CardHeader>
            <CardContent className='space-y-3'>
              {version.isError ? (
                <Alert variant='destructive'>
                  <AlertTitle>检查失败</AlertTitle>
                  <AlertDescription>
                    {version.error instanceof ApiError
                      ? version.error.message
                      : '无法读取版本'}
                  </AlertDescription>
                </Alert>
              ) : null}
              <dl className='grid gap-2 text-sm sm:grid-cols-2'>
                <div>
                  <dt className='text-muted-foreground'>当前</dt>
                  <dd className='font-mono'>{data?.current_tag || '—'}</dd>
                </div>
                <div>
                  <dt className='text-muted-foreground'>GitHub 最新</dt>
                  <dd className='flex items-center gap-2 font-mono'>
                    {checkFailed ? '—' : data?.latest_tag || '—'}
                    {checkFailed ? (
                      <Badge variant='destructive'>检查失败</Badge>
                    ) : data?.update_available ? (
                      <Badge>有更新</Badge>
                    ) : data?.update_available === false ? (
                      <Badge variant='secondary'>已是最新</Badge>
                    ) : null}
                  </dd>
                </div>
              </dl>
              {data?.source_error ? (
                <p className='text-sm text-muted-foreground'>
                  GitHub 不可达（{data.source_error}）。仍可复制宿主机命令。
                </p>
              ) : null}
              {updateRunning ? (
                <Alert>
                  <AlertTitle>
                    正在更新到 {upgradeTarget || data?.upgrade?.target}
                  </AlertTitle>
                  <AlertDescription>等待后端重启和版本验证。</AlertDescription>
                </Alert>
              ) : data?.upgrade?.state === 'failed' ? (
                <Alert variant='destructive'>
                  <AlertTitle>更新失败</AlertTitle>
                  <AlertDescription>
                    {data.upgrade.log_command}
                  </AlertDescription>
                </Alert>
              ) : null}
              {data?.needs_wrap_cli_sync ? (
                <Alert>
                  <AlertTitle>需要重装槽内 kernel</AlertTitle>
                  <AlertDescription>
                    此跨度 changelog 提到
                    wrap-cli/sync。控制面升完后到内核页重装 kernel，或给
                    install.sh 加 --sync-wrap。
                  </AlertDescription>
                </Alert>
              ) : null}
              {data?.html_url ? (
                <a
                  href={data.html_url}
                  target='_blank'
                  rel='noreferrer'
                  className='inline-flex items-center gap-1 text-sm text-primary hover:underline'
                >
                  GitHub Release
                  <ExternalLink className='size-3.5' />
                </a>
              ) : null}
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>一键更新</CardTitle>
            </CardHeader>
            <CardContent className='space-y-3'>
              <p className='text-sm text-muted-foreground'>
                在宿主机执行。保留 .env / vms / data。本地槽同步 kernel 与
                CLI；集群槽按同一份 kernel、cli-node 和 Go
                遥测重建镜像并换容器，不改凭证和指纹。
              </p>
              <pre className='overflow-x-auto rounded-md bg-muted px-3 py-2 font-mono text-xs'>
                {data?.upgrade_command ||
                  'curl -sSL https://raw.githubusercontent.com/dofastted/vm2api/main/deploy/install.sh | sudo bash -s -- upgrade'}
              </pre>
              <div className='flex flex-wrap gap-2'>
                <Button
                  size='sm'
                  variant='outline'
                  onClick={() => {
                    const command = data?.upgrade_command
                    if (!command) return
                    copyText(command)
                      .then(() => toast.success('已复制'))
                      .catch(() => toast.error('复制失败'))
                  }}
                >
                  <Copy />
                  复制命令
                </Button>
                <Button
                  size='sm'
                  disabled={
                    !!offlineTask ||
                    checkFailed ||
                    !data?.update_available ||
                    upgrade.isPending ||
                    updateRunning
                  }
                  onClick={() => setConfirmOpen(true)}
                >
                  <ArrowUpCircle />
                  从面板发起
                </Button>
              </div>
            </CardContent>
          </Card>
        </>
      )}
      <Card>
        <CardHeader>
          <CardTitle>Changelog</CardTitle>
        </CardHeader>
        <CardContent className='space-y-4'>
          {entries.length === 0 ? (
            <p className='text-sm text-muted-foreground'>
              没有比当前版本更新的条目。
            </p>
          ) : (
            entries.map((entry) => (
              <ChangelogBlock key={entry.heading} entry={entry} />
            ))
          )}
        </CardContent>
      </Card>

      <ConfirmDialog
        open={confirmOpen}
        onOpenChange={setConfirmOpen}
        title={`升级到 ${data?.latest_tag || ''}？`}
        desc='会更新并重启控制面，面板短暂不可用。完成后自动刷新。保留槽位、配置和数据。'
        confirmText='开始升级'
        cancelBtnText='取消'
        destructive
        isLoading={upgrade.isPending}
        handleConfirm={() => upgrade.mutate()}
      />
    </div>
  )
}

function ChangelogBlock({ entry }: { entry: ChangelogEntry }) {
  return (
    <article className='space-y-1.5 wrap-anywhere'>
      <div className='flex flex-wrap items-baseline gap-2'>
        <h3 className='font-medium'>
          {entry.tag || entry.version}
          {entry.date ? (
            <span className='ms-2 text-sm font-normal text-muted-foreground'>
              {entry.date}
            </span>
          ) : null}
        </h3>
        {entry.needs_wrap_cli_sync ? (
          <Badge variant='outline'>wrap-cli/sync</Badge>
        ) : null}
      </div>
      {entry.title ? (
        <p className='text-sm text-muted-foreground'>{entry.title}</p>
      ) : null}
      {entry.bullets.length > 0 ? (
        <ul className='list-disc space-y-1 ps-5 text-sm'>
          {entry.bullets.map((item) => (
            <li key={item}>{item}</li>
          ))}
        </ul>
      ) : null}
    </article>
  )
}
