import { useEffect, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import type {
  JevEndpointKey,
  JevInterceptConfig,
  PolicyQuestion,
} from '@/types/panel-routing'
import type { StatusTone } from '@/types/status'
import { toast } from 'sonner'
import { api } from '@/lib/api'
import { cn } from '@/lib/utils'
import { useServerDraft } from '@/hooks/use-server-draft'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Switch } from '@/components/ui/switch'
import { Textarea } from '@/components/ui/textarea'
import { SettingRow } from '@/components/setting-row'
import { StatusMark } from '@/components/status-mark'
import { FieldLine, ToggleItem } from '@/features/risk/blocks'
import { jevInterceptQueryOptions } from '@/features/risk/queries'
import { QuestionBank } from '@/features/risk/question-bank'
import { SaveBar } from '@/features/settings/save-bar'

const KEY_MAX = 999
const KEY_STATUS: Record<string, StatusTone> = {
  normal: { key: 'ok', cls: 'ok', text: '正常' },
  unrequested: { key: 'none', cls: 'none', text: '未请求' },
  paused: { key: 'off', cls: 'off', text: '已暂停' },
  auth_error: { key: 'bad', cls: 'bad', text: '鉴权失败' },
  insufficient_balance: { key: 'bad', cls: 'bad', text: '额度用尽' },
  rate_limited: { key: 'warn', cls: 'warn', text: '限流' },
  request_error: { key: 'caution', cls: 'caution', text: '异常' },
  unsupported: { key: 'caution', cls: 'caution', text: '无余额接口' },
}

/** Fields this stage owns. Hard-regex fields on the same config stay untouched. */
const OWNED = [
  'enabled',
  'provider',
  'base_url',
  'model',
  'timeout_ms',
  'safety_instruction',
  'safety_threshold',
  'block_if_below',
  'fail_open',
  'dedup_sec',
  'max_state_chars',
] as const

type EndpointForm = {
  uid: string
  base_url: string
  from_base_url: string
  keys: string[]
  expanded: boolean
  clearSaved: boolean
}

type ProbeRow = {
  masked_key: string
  key_fingerprint: string
  available: boolean
  baseline_ok: boolean | null
  http_status: number | null
  safe_score: number | null
  unsafe_score: number | null
  message: string
}

type QuotaRow = {
  masked_key: string
  key_fingerprint: string
  status: string
  remaining: number | null
  unit: string | null
  message: string
}

type CheckState = { ok: boolean; text: string }

function ownedOf(data: JevInterceptConfig) {
  return JSON.stringify([
    ...OWNED.map((key) => data[key] ?? null),
    data.question_bank || [],
  ])
}

function asDraft(data: JevInterceptConfig) {
  return data
}

function ownedDiffers(a: JevInterceptConfig, b: JevInterceptConfig) {
  return ownedOf(a) !== ownedOf(b)
}

function isTypeSafe(base: string) {
  try {
    return new URL(base.trim()).hostname === 'api.typesafe.ai'
  } catch {
    return false
  }
}

function savedBases(data: JevInterceptConfig) {
  const rows = (data.endpoints || []).filter((endpoint) => endpoint.base_url)
  if (rows.length) return rows.map((endpoint) => endpoint.base_url)
  return [data.base_url || '']
}

function formsFrom(data: JevInterceptConfig): EndpointForm[] {
  return savedBases(data).map((base, index) => ({
    uid: `saved:${index}:${base}`,
    base_url: base,
    from_base_url: base,
    keys: [''],
    expanded: false,
    clearSaved: false,
  }))
}

function endpointsDirty(
  forms: EndpointForm[] | null,
  data: JevInterceptConfig
) {
  if (!forms) return false
  const current = forms.map((form) => form.base_url.trim())
  if (savedBases(data).join('\n') !== current.join('\n')) return true
  return forms.some(
    (form) => form.clearSaved || form.keys.some((key) => key.trim())
  )
}

function toneOf(status: string | undefined): StatusTone {
  return KEY_STATUS[status || ''] || KEY_STATUS.request_error
}

function scoreOf(value: number | null) {
  return value == null ? '—' : value.toFixed(2)
}

function probeStatus(row: ProbeRow) {
  if (row.http_status === 401 || row.http_status === 403) return 'auth_error'
  if (row.http_status === 402) return 'insufficient_balance'
  if (row.http_status === 429 || row.http_status === 529) return 'rate_limited'
  if (row.baseline_ok === false || !row.available) return 'request_error'
  return 'normal'
}

/** Decision model: connection, scoring and the question bank, saved together. */
export function ModerationSettings({
  onDirtyChange,
}: {
  onDirtyChange: (dirty: boolean) => void
}) {
  const qc = useQueryClient()
  const q = useQuery(jevInterceptQueryOptions())
  // 只同步本块字段：别的块保存会改写同一份缓存，本块有未保存改动时保留草稿。
  const [draft, setDraft] = useServerDraft(q.data, asDraft, ownedDiffers)
  const [forms, setForms] = useState<EndpointForm[] | null>(null)
  const [synced, setSynced] = useState('')
  const [listed, setListed] = useState<string[]>([])
  const [live, setLive] = useState<Record<string, string>>({})
  const [checks, setChecks] = useState<Record<string, CheckState>>({})
  const [pending, setPending] = useState<
    Record<string, 'probe' | 'quota' | ''>
  >({})

  const savedSig = (q.data ? savedBases(q.data) : []).join('\n')
  const dirty =
    !!draft &&
    !!q.data &&
    (ownedOf(draft) !== ownedOf(q.data) || endpointsDirty(forms, q.data))

  useEffect(() => {
    if (!q.data || dirty) return
    if (forms && synced === savedSig) return
    setForms(formsFrom(q.data))
    setSynced(savedSig)
  }, [q.data, dirty, forms, savedSig, synced])

  useEffect(() => onDirtyChange(dirty), [dirty, onDirtyChange])

  const load = (data: JevInterceptConfig) => {
    setDraft(data)
    setForms(formsFrom(data))
    setSynced(savedBases(data).join('\n'))
    setLive({})
    setChecks({})
  }

  const switchProvider = useMutation({
    mutationFn: (provider: JevInterceptConfig['provider']) =>
      api<JevInterceptConfig>('/api/panel/jev-intercept', {
        method: 'PUT',
        body: JSON.stringify({ provider }),
      }),
    onSuccess: (data) => {
      qc.setQueryData(jevInterceptQueryOptions().queryKey, data)
      load(data)
      setListed([])
      toast.success('已切换审查服务，后续审查使用新配置')
    },
    onError: (error: Error) => toast.error(error.message),
  })

  const patchForm = (uid: string, patch: Partial<EndpointForm>) =>
    setForms(
      (prev) =>
        prev?.map((form) =>
          form.uid === uid ? { ...form, ...patch } : form
        ) || prev
    )

  const save = useMutation({
    mutationFn: () => {
      if (!draft || !forms) throw new Error('没有可保存的配置')
      const filled = forms.filter((form) => form.base_url.trim())
      const body: Record<string, unknown> = {
        enabled: draft.enabled,
        model: draft.model,
        timeout_ms: Number(draft.timeout_ms),
        safety_instruction: draft.safety_instruction || '',
        safety_threshold: Number(draft.safety_threshold ?? 0.5),
        block_if_below: draft.block_if_below !== false,
        fail_open: draft.fail_open !== false,
        dedup_sec: Number(draft.dedup_sec ?? 60),
        max_state_chars: Number(draft.max_state_chars ?? 16000),
        questions: draft.question_bank || [],
      }
      body.provider = draft.provider
      if (!filled.length) {
        body.base_url = ''
        body.api_keys = []
      } else {
        body.base_url = filled[0].base_url.trim()
        body.endpoints = filled.map((form) => {
          const typed = form.keys.map((key) => key.trim()).filter(Boolean)
          const row: Record<string, unknown> = {
            base_url: form.base_url.trim(),
          }
          if (form.from_base_url) row.from_base_url = form.from_base_url
          if (form.clearSaved) {
            row.api_keys = typed
            row.append = false
          } else if (typed.length) {
            row.api_keys = typed
            row.append = true
          }
          return row
        })
      }
      return api<JevInterceptConfig>('/api/panel/jev-intercept', {
        method: 'PUT',
        body: JSON.stringify(body),
      })
    },
    onSuccess: (data) => {
      toast.success('已保存审查配置')
      load(data)
      qc.setQueryData(jevInterceptQueryOptions().queryKey, data)
    },
    onError: (error: Error) => toast.error(error.message),
  })

  const runCheck = async (form: EndpointForm, kind: 'probe' | 'quota') => {
    if (!draft) return
    const base = form.base_url.trim()
    if (!base) {
      toast.error('请先填写连接地址')
      return
    }
    setPending((prev) => ({ ...prev, [form.uid]: kind }))
    try {
      const typed = form.keys.map((key) => key.trim()).filter(Boolean)
      const path =
        kind === 'probe'
          ? '/api/panel/jev-intercept/probe'
          : '/api/panel/jev-intercept/quota'
      const data = await api<{
        results: Array<ProbeRow | QuotaRow>
        omitted: number
      }>(path, {
        method: 'POST',
        body: JSON.stringify({
          base_url: base,
          api_keys: typed,
          model: draft.model,
          timeout_ms: Number(draft.timeout_ms) || 2000,
        }),
      })
      const results = data.results || []
      const omitted = data.omitted ? `\n还有 ${data.omitted} 把这次没测。` : ''
      if (kind === 'probe') {
        const rows = results as ProbeRow[]
        setLive((prev) => {
          const next = { ...prev }
          for (const row of rows) {
            if (row.key_fingerprint)
              next[row.key_fingerprint] = probeStatus(row)
          }
          return next
        })
        const ok =
          rows.length > 0 && rows.every((row) => row.baseline_ok === true)
        setChecks((prev) => ({
          ...prev,
          [form.uid]: {
            ok,
            text:
              rows
                .map((row) => {
                  const name = row.masked_key || '无 Key'
                  const scores =
                    row.safe_score == null && row.unsafe_score == null
                      ? ''
                      : `（安全 ${scoreOf(row.safe_score)}，违规 ${scoreOf(row.unsafe_score)}）`
                  return `${name}：${row.message}${scores}`
                })
                .join('\n') + omitted,
          },
        }))
      } else {
        const rows = results as QuotaRow[]
        setLive((prev) => {
          const next = { ...prev }
          for (const row of rows) {
            if (
              row.key_fingerprint &&
              (row.status === 'auth_error' ||
                row.status === 'insufficient_balance')
            )
              next[row.key_fingerprint] = row.status
          }
          return next
        })
        const ok =
          rows.length > 0 && rows.every((row) => row.status === 'normal')
        setChecks((prev) => ({
          ...prev,
          [form.uid]: {
            ok,
            text:
              rows
                .map((row) => {
                  const name = row.masked_key || '无 Key'
                  const money =
                    row.remaining == null
                      ? row.message
                      : `剩余 ${row.remaining}${row.unit ? ` ${row.unit}` : ''}`
                  return `${name}：${money}`
                })
                .join('\n') + omitted,
          },
        }))
      }
      void qc.invalidateQueries({ queryKey: ['panel', 'jev-usage'] })
      if (kind === 'probe')
        void qc.invalidateQueries({
          queryKey: jevInterceptQueryOptions().queryKey,
        })
    } catch (error) {
      const message = error instanceof Error ? error.message : '测试失败'
      setChecks((prev) => ({
        ...prev,
        [form.uid]: { ok: false, text: message },
      }))
      toast.error(message)
    } finally {
      setPending((prev) => ({ ...prev, [form.uid]: '' }))
    }
  }

  const fetchModels = useMutation({
    mutationFn: () => {
      const base = forms?.[0]?.base_url.trim() || ''
      if (!base) throw new Error('请先填写连接地址')
      const typed =
        forms?.[0]?.keys.map((key) => key.trim()).find(Boolean) || ''
      return api<{ models: string[] }>('/api/panel/jev-intercept/models', {
        method: 'POST',
        body: JSON.stringify({
          base_url: base,
          api_key: typed,
          timeout_ms: Number(draft?.timeout_ms) || 2000,
        }),
      })
    },
    onSuccess: (data) => {
      const ids = data.models || []
      setListed(ids)
      setDraft((prev) => {
        if (!prev || prev.model.trim()) return prev
        const preferred =
          prev.providers?.find((provider) => provider.id === prev.provider)
            ?.default_model || ''
        const pick = (ids.includes(preferred) ? preferred : ids[0]) || ''
        return pick ? { ...prev, model: pick } : prev
      })
      toast.success(
        ids.length ? `拉到 ${ids.length} 个模型` : '上游没有返回模型'
      )
    },
    onError: (error: Error) => toast.error(error.message),
  })

  if (q.error) {
    return (
      <p className='p-4 text-sm text-destructive' role='alert'>
        {(q.error as Error).message}
      </p>
    )
  }
  if (!draft || !forms)
    return <div className='h-40 animate-pulse bg-muted/40' />

  const restoreScore = () => {
    const defaults = draft.defaults
    setDraft({
      ...draft,
      safety_instruction: '',
      safety_threshold: defaults?.safety_threshold ?? 0.5,
      block_if_below: defaults?.block_if_below !== false,
      fail_open: defaults?.fail_open !== false,
      dedup_sec: defaults?.dedup_sec ?? 60,
      max_state_chars: defaults?.max_state_chars ?? 16000,
    })
  }
  const questions = draft.question_bank || []
  const setQuestions = (rows: PolicyQuestion[]) =>
    setDraft({ ...draft, question_bank: rows })
  const enabledQuestions = questions.filter((row) => row.enabled).length
  const modelPlaceholder =
    draft.provider === 'perplexity'
      ? 'pplx-decider-v1.3'
      : isTypeSafe(forms[0]?.base_url || '')
        ? 'jev-latest'
        : '留空则由上游路由'

  return (
    <div className={cn('space-y-3', dirty && 'pb-20')}>
      <Card>
        <CardHeader>
          <div className='flex flex-wrap items-center justify-between gap-3'>
            <CardTitle>决策模型</CardTitle>
            <Badge
              variant={q.data?.enabled ? 'default' : 'secondary'}
              aria-label='决策模型当前状态'
            >
              {q.data?.enabled ? '已启用' : '未启用'}
            </Badge>
          </div>
          <p className='text-xs text-muted-foreground'>
            蒸馏、硬正则和拒答缓存均未拦截的正文，才会进入决策模型审查。
          </p>
        </CardHeader>
        <CardContent>
          <SettingRow
            label='启用决策模型'
            desc='保存后生效。关闭后跳过决策模型审查，不影响其他风险审计规则。'
          >
            <Switch
              aria-label='启用决策模型'
              checked={draft.enabled}
              onCheckedChange={(enabled) => setDraft({ ...draft, enabled })}
            />
          </SettingRow>
          <p className='mt-3 text-xs text-muted-foreground' aria-live='polite'>
            {draft.enabled !== q.data?.enabled
              ? `待保存：${draft.enabled ? '启用' : '关闭'}决策模型。`
              : q.data?.enabled
                ? q.data && savedBases(q.data).some((base) => base.trim())
                  ? '当前已启用。请求按已保存的服务、题库和阈值审查。'
                  : '当前已启用，但未配置连接地址。请求将跳过决策模型审查。'
                : '当前未启用。可先配置审查服务，再启用决策模型。'}
          </p>
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle>服务与连接</CardTitle>
          <p className='text-xs text-muted-foreground'>
            各服务分别保存地址、密钥、模型、题库和阈值。切换服务立即生效；切换前请保存或放弃当前修改。
          </p>
        </CardHeader>
        <CardContent className='space-y-4'>
          <SettingRow
            label='审查服务'
            desc='选择提供审查模型的服务。具体模型在下方填写或获取。'
          >
            <select
              id='moderation-provider'
              aria-label='审查服务'
              className='h-9 rounded-md border bg-background px-3 text-sm'
              value={draft.provider}
              disabled={
                dirty ||
                switchProvider.isPending ||
                save.isPending ||
                fetchModels.isPending ||
                Object.values(pending).some(Boolean)
              }
              onChange={(event) =>
                switchProvider.mutate(
                  event.target.value as JevInterceptConfig['provider']
                )
              }
            >
              {(draft.providers || []).map((provider) => (
                <option key={provider.id} value={provider.id}>
                  {provider.label}
                </option>
              ))}
            </select>
          </SettingRow>
          {draft.provider === 'perplexity' && (
            <p className='text-xs text-muted-foreground'>
              默认使用明确版本 pplx-decider-v1.3。按上游返回的输入 Token
              与公开单价估算费用。未启用联网检索。
            </p>
          )}
          <div className='space-y-4'>
            {forms.map((form) => {
              const saved = (q.data?.endpoints || []).find(
                (endpoint) => endpoint.base_url === form.from_base_url
              )?.keys
              const savedKeys = saved || []
              const shownSaved = form.expanded
                ? savedKeys
                : savedKeys.slice(0, 1)
              const hidden = form.expanded ? [] : savedKeys.slice(1)
              const hiddenSummary = hidden
                .map(
                  (row) => toneOf(live[row.key_fingerprint] || row.status).text
                )
                .join('、')
              const adding = savedKeys.length > 0
              const extra = adding ? form.keys : form.keys.slice(1)
              const check = checks[form.uid]
              return (
                <div key={form.uid} className='space-y-3 rounded-xl border p-4'>
                  <FieldLine label='地址' htmlFor={`jev-base-${form.uid}`}>
                    <div className='flex flex-wrap gap-2'>
                      <Input
                        id={`jev-base-${form.uid}`}
                        className='min-w-48 flex-1 font-mono'
                        value={form.base_url}
                        placeholder={
                          draft.providers?.find(
                            (provider) => provider.id === draft.provider
                          )?.default_base_url || '输入当前审查服务的地址'
                        }
                        onChange={(e) =>
                          patchForm(form.uid, { base_url: e.target.value })
                        }
                      />
                      {forms.length > 1 ? (
                        <Button
                          type='button'
                          variant='ghost'
                          className='shrink-0 cursor-pointer'
                          onClick={() =>
                            setForms((prev) =>
                              prev
                                ? prev.filter((item) => item.uid !== form.uid)
                                : prev
                            )
                          }
                        >
                          移除
                        </Button>
                      ) : null}
                    </div>
                  </FieldLine>
                  <FieldLine label='Key' htmlFor={`jev-key-${form.uid}`}>
                    <div className='space-y-2'>
                      <div className='flex flex-wrap gap-2'>
                        {adding ? (
                          <SavedKey
                            row={shownSaved[0]}
                            live={live}
                            placeholder='还没有 Key'
                          />
                        ) : (
                          <Input
                            id={`jev-key-${form.uid}`}
                            type='password'
                            autoComplete='off'
                            className='min-w-40 flex-1'
                            value={form.keys[0] || ''}
                            placeholder='本地服务可留空'
                            onChange={(e) =>
                              patchForm(form.uid, {
                                keys: form.keys.map((key, i) =>
                                  i === 0 ? e.target.value : key
                                ),
                                clearSaved: e.target.value
                                  ? false
                                  : form.clearSaved,
                              })
                            }
                          />
                        )}
                        <Button
                          type='button'
                          variant='outline'
                          className='cursor-pointer'
                          aria-expanded={form.expanded}
                          onClick={() =>
                            patchForm(form.uid, { expanded: !form.expanded })
                          }
                        >
                          {form.expanded ? '收起' : '展开更多'}
                        </Button>
                        <Button
                          type='button'
                          variant='outline'
                          className='cursor-pointer'
                          loading={pending[form.uid] === 'probe'}
                          disabled={!!pending[form.uid]}
                          onClick={() => void runCheck(form, 'probe')}
                        >
                          测试连接
                        </Button>
                        <Button
                          type='button'
                          variant='outline'
                          className='cursor-pointer'
                          loading={pending[form.uid] === 'quota'}
                          disabled={!!pending[form.uid]}
                          onClick={() => void runCheck(form, 'quota')}
                        >
                          检查剩余额度
                        </Button>
                      </div>
                      {shownSaved.length ? (
                        <KeyList rows={shownSaved} live={live} />
                      ) : null}
                      {form.expanded ? (
                        <div className='space-y-2 border-t pt-2'>
                          {extra.map((value, keyIndex) => {
                            const realIndex = adding ? keyIndex : keyIndex + 1
                            return (
                              <div key={realIndex} className='flex gap-2'>
                                <Input
                                  type='password'
                                  autoComplete='off'
                                  aria-label={`追加 Key ${realIndex + 1}`}
                                  value={value}
                                  placeholder='再添加一把'
                                  onChange={(e) =>
                                    patchForm(form.uid, {
                                      keys: form.keys.map((key, i) =>
                                        i === realIndex ? e.target.value : key
                                      ),
                                    })
                                  }
                                />
                                <Button
                                  type='button'
                                  variant='ghost'
                                  className='cursor-pointer'
                                  onClick={() =>
                                    patchForm(form.uid, {
                                      keys: form.keys.filter(
                                        (_, i) => i !== realIndex
                                      ),
                                    })
                                  }
                                >
                                  删除
                                </Button>
                              </div>
                            )
                          })}
                          <div className='flex flex-wrap items-center justify-between gap-2'>
                            <Button
                              type='button'
                              variant='outline'
                              size='sm'
                              className='cursor-pointer'
                              disabled={form.keys.length >= KEY_MAX}
                              onClick={() =>
                                patchForm(form.uid, {
                                  keys: [...form.keys, ''],
                                })
                              }
                            >
                              再加一把
                            </Button>
                            {savedKeys.length ? (
                              <ToggleItem
                                label='清除已存 Key'
                                desc='保存时用本次填写的密钥替换已保存的密钥。未填写时清除全部密钥。'
                              >
                                <Switch
                                  checked={form.clearSaved}
                                  onCheckedChange={(v) =>
                                    patchForm(form.uid, { clearSaved: v })
                                  }
                                />
                              </ToggleItem>
                            ) : null}
                          </div>
                        </div>
                      ) : null}
                      {check ? (
                        <p
                          className={cn(
                            'text-xs whitespace-pre-wrap',
                            check.ok ? 'text-foreground' : 'text-destructive'
                          )}
                          role={check.ok ? undefined : 'alert'}
                        >
                          {check.text}
                        </p>
                      ) : (
                        <p className='text-xs text-muted-foreground'>
                          {savedKeys.length
                            ? `已存 ${savedKeys.length} 把${hiddenSummary ? `，未展开 ${hiddenSummary}` : ''}。展开后可继续添加。`
                            : '还没有 Key。'}
                          连接测试检查模型连通性，并使用普通文本和攻击文本核对已保存的题库与阈值。调用费用可在「审查记录」查看。
                        </p>
                      )}
                    </div>
                  </FieldLine>
                </div>
              )
            })}
          </div>
          <div className='grid gap-3 sm:grid-cols-[minmax(0,1fr)_9rem]'>
            <FieldLine label='模型' htmlFor='jev-model'>
              <div className='flex gap-2'>
                <Input
                  id='jev-model'
                  className='font-mono'
                  value={draft.model}
                  placeholder={modelPlaceholder}
                  onChange={(e) =>
                    setDraft({ ...draft, model: e.target.value })
                  }
                />
                <Button
                  type='button'
                  variant='outline'
                  className='shrink-0 cursor-pointer'
                  loading={fetchModels.isPending}
                  disabled={fetchModels.isPending || !forms[0]?.base_url.trim()}
                  onClick={() => fetchModels.mutate()}
                >
                  获取模型
                </Button>
              </div>
            </FieldLine>
            <div className='space-y-1.5'>
              <Label htmlFor='jev-timeout'>超时 ms</Label>
              <Input
                id='jev-timeout'
                type='number'
                min={200}
                max={60000}
                className='tabular-nums'
                value={draft.timeout_ms}
                onChange={(e) =>
                  setDraft({ ...draft, timeout_ms: Number(e.target.value) })
                }
              />
            </div>
          </div>
          {listed.length ? (
            <div className='flex flex-wrap gap-1.5'>
              {listed.map((id) => (
                <button
                  key={id}
                  type='button'
                  className={cn(
                    'cursor-pointer rounded-md px-2 py-1 font-mono text-xs transition-colors duration-200',
                    draft.model === id
                      ? 'bg-primary text-primary-foreground'
                      : 'bg-muted text-muted-foreground hover:text-foreground'
                  )}
                  onClick={() => setDraft({ ...draft, model: id })}
                >
                  {id}
                </button>
              ))}
            </div>
          ) : null}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <div className='flex items-center justify-between gap-3'>
            <CardTitle>拦截规则</CardTitle>

            <button
              type='button'
              className='cursor-pointer text-xs text-muted-foreground underline-offset-4 transition-colors duration-200 hover:text-foreground hover:underline'
              onClick={restoreScore}
            >
              恢复默认
            </button>
          </div>
          <p className='text-xs text-muted-foreground'>
            高分表示安全。按启用的题目分别打分。任一题满足拦截条件时拦截请求；色情题命中时封禁设备。
          </p>
        </CardHeader>
        <CardContent className='space-y-4'>
          <div className='divide-y'>
            <SettingRow
              label='审查失败时放行'
              desc='开启后，审查失败时放行请求。关闭后，仅拦截当前请求，不封禁设备。'
            >
              <Switch
                aria-label='审查失败时放行'
                checked={draft.fail_open !== false}
                onCheckedChange={(fail_open) =>
                  setDraft({ ...draft, fail_open })
                }
              />
            </SettingRow>
            <SettingRow
              label='低于阈值时拦截'
              desc='开启后，分数低于阈值时拦截。关闭后，分数高于阈值时拦截。'
            >
              <Switch
                aria-label='低于阈值时拦截'
                checked={draft.block_if_below !== false}
                onCheckedChange={(block_if_below) =>
                  setDraft({ ...draft, block_if_below })
                }
              />
            </SettingRow>
          </div>
          <div className='grid gap-3 sm:grid-cols-3'>
            <div className='space-y-1.5'>
              <Label htmlFor='jev-threshold'>阈值</Label>
              <Input
                id='jev-threshold'
                type='number'
                min={0}
                max={1}
                step={0.05}
                className='tabular-nums'
                value={draft.safety_threshold ?? 0.5}
                onChange={(e) =>
                  setDraft({
                    ...draft,
                    safety_threshold: Number(e.target.value),
                  })
                }
              />
            </div>
            <div className='space-y-1.5'>
              <Label htmlFor='jev-dedup'>缓存有效期（秒）</Label>
              <Input
                id='jev-dedup'
                type='number'
                min={0}
                max={3600}
                className='tabular-nums'
                value={draft.dedup_sec ?? 60}
                onChange={(e) =>
                  setDraft({ ...draft, dedup_sec: Number(e.target.value) })
                }
              />
            </div>
            <div className='space-y-1.5'>
              <Label htmlFor='jev-state'>审查文本上限（字符）</Label>
              <Input
                id='jev-state'
                type='number'
                min={256}
                max={64000}
                className='tabular-nums'
                value={draft.max_state_chars ?? 16000}
                onChange={(e) =>
                  setDraft({
                    ...draft,
                    max_state_chars: Number(e.target.value),
                  })
                }
              />
            </div>
          </div>
          <div className='space-y-1.5'>
            <Label htmlFor='jev-instruction'>自定义要求</Label>
            <Textarea
              id='jev-instruction'
              rows={2}
              value={draft.safety_instruction || ''}
              placeholder='留空则只用题库。填写后会多问这一题'
              onChange={(e) =>
                setDraft({ ...draft, safety_instruction: e.target.value })
              }
            />
          </div>
          <p className='text-xs text-muted-foreground'>
            相同文本在缓存有效期内复用审查结果。文本超过上限时，仅审查末尾的指定字符数。
          </p>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <div className='flex items-center justify-between gap-3'>
            <CardTitle>题库</CardTitle>
            <Button
              size='sm'
              variant='outline'
              className='cursor-pointer'
              onClick={() => setQuestions(q.data?.builtin_questions || [])}
            >
              恢复内置
            </Button>
          </div>
          <p className='text-xs text-muted-foreground'>
            启用的题目在同一次请求中审查。当前启用 {enabledQuestions} /{' '}
            {questions.length} 题。
          </p>
        </CardHeader>
        <CardContent>
          <QuestionBank rows={questions} onChange={setQuestions} />
        </CardContent>
      </Card>

      {dirty ? (
        <SaveBar
          saving={save.isPending}
          onSave={() => save.mutate()}
          onDiscard={() => q.data && load(q.data)}
        />
      ) : null}
    </div>
  )
}

function SavedKey({
  row,
  live,
  placeholder,
}: {
  row: JevEndpointKey | undefined
  live: Record<string, string>
  placeholder: string
}) {
  if (!row) {
    return <span className='text-sm text-muted-foreground'>{placeholder}</span>
  }
  const status = live[row.key_fingerprint] || row.status
  return (
    <span className='flex min-w-40 flex-1 items-center gap-2'>
      <span className='font-mono text-sm'>{row.masked_key}</span>
      <StatusMark tone={toneOf(status)} />
    </span>
  )
}

function KeyList({
  rows,
  live,
}: {
  rows: JevEndpointKey[]
  live: Record<string, string>
}) {
  if (rows.length <= 1) return null
  return (
    <ul className='space-y-1'>
      {rows.slice(1).map((row) => (
        <li key={row.key_fingerprint || row.number}>
          <SavedKey row={row} live={live} placeholder='' />
        </li>
      ))}
    </ul>
  )
}
