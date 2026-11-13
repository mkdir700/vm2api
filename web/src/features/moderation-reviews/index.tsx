import { useState } from 'react'
import { useInfiniteQuery, useQuery } from '@tanstack/react-query'
import { Link } from '@tanstack/react-router'
import { api } from '@/lib/api'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { PageHeader } from '@/components/page-header'
import { JevUsagePanel } from '@/features/risk/jev-usage'
import { usageMoney } from '@/features/risk/jev-usage-format'

type Review = {
  id: string
  created_at: string
  request_id: string
  provider: string
  config_id: string
  config_revision: string
  requested_model: string
  response_model: string
  result: string
  action: string
  safety_threshold: number
  block_if_below: number
  reason: string
  categories: string[]
  cache_hit: boolean
  source_review_id: string
  duration_ms: number
  attempt_count: number
  input_tokens: number | null
  output_tokens: number | null
  estimated_cost_nano_usd: number | null
  known_cost_nano_usd: number
  unknown_cost_attempts: number
}
type Attempt = {
  id: string
  created_at: string
  provider: string
  model: string
  requested_model: string
  http_status: number | null
  outcome: string
  duration_ms: number
  input_tokens: number | null
  output_tokens: number | null
  estimated_cost_nano_usd: number | null
  input_nano_usd_per_token: number | null
  pricing_basis: string
  upstream_request_id: string
  key_fingerprint: string
}
type Cursor = { created_at: string; id: string }
type Totals = {
  provider: string
  requested_model: string
  reviews: number
  cache_hits: number
  attempts: number
  known_cost_nano_usd: number
  unknown_cost_reviews: number
}
type Page = {
  rows: Review[]
  totals: Totals[]
  has_more: boolean
  next_cursor: Cursor | null
  detail_retention_days: number
  storage_errors_since_start: number
}
const PROVIDERS: Record<string, string> = {
  jev: 'Jev',
  perplexity: 'Perplexity',
  laya: 'Laya',
  modernbert: 'ModernBERT',
}
const RESULTS: Record<string, string> = {
  pass: '通过',
  block: '拦截',
  unavailable: '服务不可用',
  skipped: '未审查',
}
const REASONS: Record<string, string> = {
  safe: '模型通过',
  replay: '缓存命中',
  policy: '命中策略',
  unavailable: '审查失败',
  skip: '跳过审查',
}
const OUTCOMES: Record<string, string> = {
  success: '完成',
  http_error: '上游错误',
  network_error: '网络错误',
  invalid_response: '响应无效',
}
const tokens = (value: number | null) =>
  value === null ? '未知' : value.toLocaleString('zh-CN')
const time = (value: string) =>
  new Date(value).toLocaleString('zh-CN', {
    timeZone: 'Asia/Shanghai',
    hour12: false,
  })
const selectClass = 'h-9 rounded-md border bg-background px-3 text-sm'

export function ModerationReviewsPage() {
  const [provider, setProvider] = useState('')
  const [model, setModel] = useState('')
  const [result, setResult] = useState('')
  const [filters, setFilters] = useState({
    provider: '',
    model: '',
    result: '',
  })
  const [selected, setSelected] = useState<string | null>(null)
  const query = useInfiniteQuery({
    queryKey: ['panel', 'moderation-reviews', filters],
    initialPageParam: null as Cursor | null,
    queryFn: ({ pageParam, signal }) => {
      const search = new URLSearchParams({ ...filters, limit: '50' })
      if (pageParam) {
        search.set('cursor_created_at', pageParam.created_at)
        search.set('cursor_id', pageParam.id)
      }
      return api<Page>(`/api/panel/moderation-reviews?${search}`, { signal })
    },
    getNextPageParam: (page) =>
      page.has_more ? (page.next_cursor ?? undefined) : undefined,
    refetchOnWindowFocus: false,
    staleTime: 30000,
  })
  const detail = useQuery({
    queryKey: ['panel', 'moderation-review', selected],
    enabled: Boolean(selected),
    queryFn: ({ signal }) =>
      api<{ review: Review; attempts: Attempt[] }>(
        `/api/panel/moderation-reviews/${selected}`,
        { signal }
      ),
  })
  const rows = [
    ...new Map(
      (query.data?.pages.flatMap((page) => page.rows) || []).map((row) => [
        row.id,
        row,
      ])
    ).values(),
  ]
  const totals = query.data?.pages[0]?.totals || []
  return (
    <PageHeader
      title='审查记录'
      description='逐次查看模型审查、缓存命中和上游调用费用。时间使用北京时间。'
      extra={
        <Link
          to='/settings/$tab'
          params={{ tab: 'moderation' }}
          className='text-sm text-primary underline'
        >
          配置审查服务
        </Link>
      }
    >
      <div className='space-y-6'>
        <form
          className='flex flex-wrap items-center gap-3'
          onSubmit={(event) => {
            event.preventDefault()
            setFilters({ provider, model: model.trim(), result })
          }}
        >
          <select
            aria-label='审查服务'
            className={selectClass}
            value={provider}
            onChange={(event) => setProvider(event.target.value)}
          >
            <option value=''>全部服务</option>
            {Object.entries(PROVIDERS).map(([id, label]) => (
              <option key={id} value={id}>
                {label}
              </option>
            ))}
          </select>
          <Input
            aria-label='审查模型'
            placeholder='模型名称（精确匹配）'
            className='w-64'
            value={model}
            onChange={(event) => setModel(event.target.value)}
          />
          <select
            aria-label='审查结果'
            className={selectClass}
            value={result}
            onChange={(event) => setResult(event.target.value)}
          >
            <option value=''>全部结果</option>
            {Object.entries(RESULTS).map(([id, label]) => (
              <option key={id} value={id}>
                {label}
              </option>
            ))}
          </select>
          <Button type='submit'>筛选</Button>
          <Button
            type='button'
            variant='outline'
            disabled={query.isFetching}
            onClick={() => void query.refetch()}
          >
            刷新
          </Button>
        </form>
        <p className='text-xs text-muted-foreground'>
          记录保留 30 天。汇总使用当前筛选范围。费用为按返回用量和当时单价计算的
          USD
          估算，不是官方账单。未知费用不等于免费。缓存命中不新增调用费用。一次业务请求可能执行多次审查，可通过请求
          ID 关联。
        </p>
        {query.error && (
          <p role='alert' className='text-sm text-destructive'>
            读取失败：{query.error.message}
          </p>
        )}
        {(query.data?.pages[0]?.storage_errors_since_start || 0) > 0 && (
          <p role='alert' className='text-sm text-destructive'>
            本进程发生审查记录存储异常，记录和费用统计可能不完整。
          </p>
        )}
        {query.isPending && (
          <p className='text-sm text-muted-foreground'>读取审查记录…</p>
        )}
        {totals.length > 0 && (
          <div className='overflow-x-auto rounded-md border'>
            <table className='w-full text-left text-sm'>
              <thead>
                <tr className='border-b'>
                  <th className='p-3'>服务 / 模型</th>
                  <th className='p-3'>审查 / 缓存 / 调用</th>
                  <th className='p-3'>已知估算 USD</th>
                  <th className='p-3'>费用未知</th>
                </tr>
              </thead>
              <tbody>
                {totals.map((total) => (
                  <tr
                    key={`${total.provider}:${total.requested_model}`}
                    className='border-b'
                  >
                    <td className='p-3'>
                      {PROVIDERS[total.provider] || total.provider} ·{' '}
                      {total.requested_model}
                    </td>
                    <td className='p-3'>
                      {total.reviews} / {total.cache_hits} / {total.attempts}
                    </td>
                    <td className='p-3'>
                      {usageMoney(total.known_cost_nano_usd)}
                    </td>
                    <td className='p-3'>{total.unknown_cost_reviews} 次</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <div className='overflow-x-auto rounded-md border'>
          <table className='w-full min-w-[1050px] text-left text-sm'>
            <thead>
              <tr className='border-b'>
                <th className='p-3'>时间</th>
                <th className='p-3'>服务 / 模型</th>
                <th className='p-3'>结果</th>
                <th className='p-3'>调用来源</th>
                <th className='p-3'>输入 / 输出 Token</th>
                <th className='p-3'>估算 USD</th>
                <th className='p-3'>耗时</th>
                <th className='p-3'>详情</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.id} className='border-b'>
                  <td className='p-3 whitespace-nowrap'>
                    {time(row.created_at)}
                  </td>
                  <td className='p-3'>
                    {PROVIDERS[row.provider] || row.provider}
                    <div className='font-mono text-xs'>
                      {row.requested_model || '未指定'}
                    </div>
                  </td>
                  <td className='p-3'>
                    {RESULTS[row.result] || row.result}
                    {row.result === 'unavailable'
                      ? row.action === 'pass'
                        ? '（放行）'
                        : '（拦截）'
                      : ''}
                    <div className='text-xs text-muted-foreground'>
                      {row.categories.join('、')}
                    </div>
                  </td>
                  <td className='p-3'>
                    {row.cache_hit
                      ? '缓存命中'
                      : `${row.attempt_count} 次上游调用`}
                  </td>
                  <td className='p-3'>
                    {tokens(row.input_tokens)} / {tokens(row.output_tokens)}
                  </td>
                  <td className='p-3'>
                    {usageMoney(row.estimated_cost_nano_usd)}
                    {row.unknown_cost_attempts > 0 && (
                      <div className='text-xs text-muted-foreground'>
                        已知部分 {usageMoney(row.known_cost_nano_usd)}
                      </div>
                    )}
                  </td>
                  <td className='p-3'>{row.duration_ms} ms</td>
                  <td className='p-3'>
                    <Button
                      variant='ghost'
                      size='sm'
                      onClick={() => setSelected(row.id)}
                    >
                      查看
                    </Button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {query.isSuccess && rows.length === 0 && (
            <p className='p-6 text-sm text-muted-foreground'>
              当前筛选没有审查记录。功能启用前的审查无法补回。
            </p>
          )}
        </div>
        {query.hasNextPage && (
          <Button
            variant='outline'
            disabled={query.isFetchingNextPage}
            onClick={() => void query.fetchNextPage()}
          >
            加载更多
          </Button>
        )}
        <JevUsagePanel />
      </div>
      <Dialog
        open={selected !== null}
        onOpenChange={(open) => {
          if (!open) setSelected(null)
        }}
      >
        <DialogContent className='max-h-[85vh] overflow-auto sm:max-w-5xl'>
          <DialogHeader>
            <DialogTitle>审查详情</DialogTitle>
            <DialogDescription>
              模型、配置快照和每次上游调用。费用使用当时的单价。
            </DialogDescription>
          </DialogHeader>
          {detail.isPending && <p>读取中…</p>}
          {detail.error && (
            <p role='alert' className='text-destructive'>
              {detail.error.message}
            </p>
          )}
          {detail.data && (
            <div className='space-y-4 text-sm'>
              <dl className='grid gap-2 break-all'>
                <div>审查 ID：{detail.data.review.id}</div>
                <div>请求 ID：{detail.data.review.request_id || '未提供'}</div>
                <div>
                  服务 / 配置：{PROVIDERS[detail.data.review.provider]} /{' '}
                  {detail.data.review.config_id}
                </div>
                <div>配置版本：{detail.data.review.config_revision}</div>
                <div>
                  拦截阈值：{detail.data.review.safety_threshold}（
                  {detail.data.review.block_if_below
                    ? '低于阈值拦截'
                    : '达到阈值拦截'}
                  ）
                </div>
                <div>请求模型：{detail.data.review.requested_model}</div>
                <div>
                  返回模型：{detail.data.review.response_model || '未返回'}
                  （别名不代表实际版本）
                </div>
                <div>
                  结果：{RESULTS[detail.data.review.result]} ·{' '}
                  {REASONS[detail.data.review.reason] ||
                    detail.data.review.reason}
                </div>
              </dl>
              {detail.data.review.source_review_id && (
                <Button
                  variant='outline'
                  onClick={() =>
                    setSelected(detail.data.review.source_review_id)
                  }
                >
                  查看缓存来源
                </Button>
              )}
              <div className='overflow-x-auto'>
                <table className='w-full min-w-[750px] text-left text-xs'>
                  <thead>
                    <tr className='border-b'>
                      <th className='p-2'>状态 / 耗时</th>
                      <th className='p-2'>模型 / 上游请求 ID</th>
                      <th className='p-2'>Token</th>
                      <th className='p-2'>估算 USD / 单价</th>
                      <th className='p-2'>计价版本</th>
                    </tr>
                  </thead>
                  <tbody>
                    {detail.data.attempts.map((attempt) => (
                      <tr key={attempt.id} className='border-b'>
                        <td className='p-2'>
                          {attempt.http_status || '网络失败'} ·{' '}
                          {OUTCOMES[attempt.outcome] || attempt.outcome}
                          <br />
                          {attempt.duration_ms} ms
                        </td>
                        <td className='p-2 break-all'>
                          {attempt.model || attempt.requested_model}
                          <br />
                          {attempt.upstream_request_id || '未返回'}
                          <br />
                          密钥指纹：{attempt.key_fingerprint || '无'}
                        </td>
                        <td className='p-2'>
                          {tokens(attempt.input_tokens)} /{' '}
                          {tokens(attempt.output_tokens)}
                        </td>
                        <td className='p-2'>
                          {usageMoney(attempt.estimated_cost_nano_usd)}
                          <br />
                          {attempt.input_nano_usd_per_token === null
                            ? '单价未知'
                            : `$${attempt.input_nano_usd_per_token / 1000} / 百万输入 Token`}
                        </td>
                        <td className='p-2'>{attempt.pricing_basis}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              {detail.data.attempts.length === 0 && (
                <p className='text-muted-foreground'>本次没有上游调用。</p>
              )}
            </div>
          )}
        </DialogContent>
      </Dialog>
    </PageHeader>
  )
}
