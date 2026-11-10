import { useQuery } from '@tanstack/react-query'
import type { UsageLogRow } from '@/types/panel-usage-logs'
import { api } from '@/lib/api'
import { Button } from '@/components/ui/button'

type Prefix = {
  change: string
  retained_messages: number
  message_count: number
  tools_sha256: string
  system_sha256: string
  profile_sha256: string
  cache_ttls: string[]
}
type Observation = {
  request_id: string
  gateway_request_id?: string
  external_session_id: string
  routing_session_id: string
  branch_id: string
  parent_branch_id: string | null
  purpose: string
  query_source?: string
  native_owner: string
  native_session_id?: string
  generation?: string
  selection: string
  retirement_reason?: string
  status: number
  complete: boolean
  prefix: Prefix | null
  usage: {
    cache_read_input_tokens: number
    cache_creation_input_tokens: number
  } | null
}
type Snapshot = {
  generation: string
  scope: string
  retention: {
    request_limit: number
    dropped_requests: number
    resets_on_restart: boolean
  }
  requests: Observation[]
  branches: {
    branch_id: string
    purpose: string
    requests: number
    measured_requests: number
    cache_read_tokens: number
    cache_write_tokens: number
  }[]
}
const purposes: Record<string, string> = {
  conversation: '会话分支',
  agent: '代理分支',
  classifier: '自动模式分类',
}
const changes: Record<string, string> = {
  first_observation: '首次观测',
  append_only: '追加历史',
  unchanged: '前缀未变',
  tools_changed: '工具变化',
  system_changed: '系统提示变化',
  profile_changed: '模型参数变化',
  history_changed: '历史前缀变化',
}
const selections: Record<string, string> = {
  owner_created: '创建',
  owner_reused: '复用',
  contract_replacement: '契约变化后重建',
}
const short = (id?: string | null) => (id ? id.slice(0, 12) : '未知')

export function SessionCacheTab({ row }: { row: UsageLogRow }) {
  const session = row.clientSessionId || row.sessionId
  const query = useQuery({
    queryKey: ['panel', 'session-cache', row.vmId, session],
    queryFn: () =>
      api<Snapshot>(
        `/api/panel/vms/${encodeURIComponent(row.vmId!)}/session-cache?session=${encodeURIComponent(session!)}`
      ),
    enabled: !!row.vmId && !!session,
    retry: false,
    staleTime: 5000,
  })
  if (!row.vmId || !session)
    return (
      <p className='text-sm text-muted-foreground'>
        该请求没有可关联的槽位或会话。
      </p>
    )
  if (query.isPending)
    return (
      <p className='text-sm text-muted-foreground'>正在读取会话缓存记录…</p>
    )
  if (query.isError)
    return (
      <p className='text-sm text-muted-foreground'>
        会话缓存记录不可用。此功能需要管理员权限和支持诊断的内核。
      </p>
    )
  const data = query.data
  if (!data) return null
  return (
    <div className='space-y-4 text-sm'>
      <div className='flex items-center justify-between gap-3'>
        <div className='min-w-0'>
          <p>
            槽位 {row.vmName || row.vmId} · 当前运行代次 {data.generation}
          </p>
          <p className='break-all text-muted-foreground'>会话 {session}</p>
        </div>
        <Button
          size='sm'
          variant='outline'
          onClick={() => void query.refetch()}
          disabled={query.isFetching}
        >
          刷新
        </Button>
      </div>
      <p className='text-muted-foreground'>
        仅统计当前运行代次最近 {data.retention.request_limit}{' '}
        条已分配原生会话的请求。重启后清空。以下计数属于该窗口，不是会话累计用量。
      </p>
      {!data.requests.length ? (
        <p>该会话没有近期记录。旧请求可能早于功能启用、内核重启或保留窗口。</p>
      ) : (
        <>
          <div className='overflow-x-auto'>
            <table className='w-full text-left'>
              <thead>
                <tr className='border-b'>
                  <th className='p-2'>分支</th>
                  <th className='p-2'>请求</th>
                  <th className='p-2'>有用量记录</th>
                  <th className='p-2'>缓存读取</th>
                  <th className='p-2'>缓存写入</th>
                </tr>
              </thead>
              <tbody>
                {data.branches.map((branch) => (
                  <tr key={branch.branch_id} className='border-b'>
                    <td className='p-2'>
                      {purposes[branch.purpose] || '未知用途'}{' '}
                      <span className='font-mono'>
                        {short(branch.branch_id)}
                      </span>
                    </td>
                    <td className='p-2'>{branch.requests}</td>
                    <td className='p-2'>{branch.measured_requests}</td>
                    <td className='p-2'>
                      {branch.measured_requests
                        ? branch.cache_read_tokens.toLocaleString()
                        : '未知'}
                    </td>
                    <td className='p-2'>
                      {branch.measured_requests
                        ? branch.cache_write_tokens.toLocaleString()
                        : '未知'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className='space-y-3'>
            {data.requests
              .slice(-20)
              .reverse()
              .map((item) => (
                <details
                  key={item.request_id}
                  className='rounded border p-3'
                  open={
                    !!row.requestId && item.gateway_request_id === row.requestId
                  }
                >
                  <summary className='cursor-pointer'>
                    {purposes[item.purpose] || '未知用途'} · {item.native_owner}{' '}
                    · {selections[item.selection] || item.selection} ·{' '}
                    {item.status || '未提交'} ·{' '}
                    {item.complete ? '响应完整' : '响应未确认完整'}
                  </summary>
                  <dl className='mt-3 grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 break-all'>
                    <dt>客户端会话</dt>
                    <dd className='font-mono'>
                      {item.external_session_id || '未知'}
                    </dd>
                    <dt>路由会话</dt>
                    <dd className='font-mono'>
                      {item.routing_session_id || '未知'}
                    </dd>
                    <dt>原生会话</dt>
                    <dd className='font-mono'>
                      {item.native_session_id || '未知'}
                    </dd>
                    <dt>原生请求用途</dt>
                    <dd>{item.query_source || '未知'}</dd>
                    <dt>父分支</dt>
                    <dd>{item.parent_branch_id || '未知；请求未提供'}</dd>
                    <dt>前缀</dt>
                    <dd>
                      {item.prefix
                        ? `${changes[item.prefix.change] || item.prefix.change}；保留 ${item.prefix.retained_messages} 条，共 ${item.prefix.message_count} 条消息`
                        : '没有原生前缀观测'}
                    </dd>
                    <dt>缓存读取 / 写入</dt>
                    <dd>
                      {item.usage
                        ? `${item.usage.cache_read_input_tokens.toLocaleString()} / ${item.usage.cache_creation_input_tokens.toLocaleString()}`
                        : '未知'}
                    </dd>
                    {item.prefix && (
                      <>
                        <dt>工具哈希</dt>
                        <dd className='font-mono'>
                          {item.prefix.tools_sha256}
                        </dd>
                        <dt>系统提示哈希</dt>
                        <dd className='font-mono'>
                          {item.prefix.system_sha256}
                        </dd>
                        <dt>模型参数哈希</dt>
                        <dd className='font-mono'>
                          {item.prefix.profile_sha256}
                        </dd>
                        <dt>缓存时长</dt>
                        <dd>
                          {item.prefix.cache_ttls.join('、') ||
                            '未观察到缓存标记'}
                        </dd>
                      </>
                    )}
                    {item.retirement_reason && (
                      <>
                        <dt>结束原因</dt>
                        <dd>{item.retirement_reason}</dd>
                      </>
                    )}
                  </dl>
                </details>
              ))}
          </div>
        </>
      )}
    </div>
  )
}
