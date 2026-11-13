import test from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { pathToFileURL } from 'node:url'
import { createHash } from 'node:crypto'
import { startGateway, REPO_ROOT, api as rawApi } from '../harness.mjs'

async function api(...args) {
  const response = await rawApi(...args)
  return {
    ...response,
    json: response.json?.ok === true && response.json.data !== undefined ? response.json.data : response.json,
  }
}

test('settings switch review providers while review history preserves model, attempts and price', async () => {
  const calls = []
  let mode = 'safe'
  let questionScores = null
  const upstream = http.createServer(async (req, res) => {
    const chunks = []
    for await (const chunk of req) chunks.push(chunk)
    if (req.method === 'GET') {
      res.setHeader('content-type', 'application/json')
      return res.end(JSON.stringify({ data: [{ id: 'pplx-decider-v1.3' }] }))
    }
    const body = JSON.parse(Buffer.concat(chunks))
    calls.push({
      url: req.url,
      model: body.model,
      authorization: req.headers.authorization,
      state: body.state,
      questions: body.questions,
    })
    res.setHeader('content-type', 'application/json')
    res.setHeader('x-request-id', `upstream-${calls.length}`)
    if (mode === 'retry' && req.headers.authorization === 'Bearer synthetic-first') {
      res.statusCode = 401
      return res.end('{}')
    }
    if (mode === 'rate-limit') {
      res.statusCode = 429
      return res.end('{}')
    }
    if (mode === 'timeout') {
      const timer = setTimeout(() => res.end('{}'), 500)
      res.on('close', () => clearTimeout(timer))
      return
    }
    if (mode === 'network') return res.destroy()
    if (mode === 'invalid-json') return res.end('{')
    if (mode === 'invalid') return res.end(JSON.stringify({ answers: {} }))
    const answers = Object.fromEntries(
      Object.keys(body.questions).map((id) => [
        id,
        {
          noul:
            questionScores?.[id] ??
            (mode === 'block' || (mode === 'baseline' && body.state.includes('steals its passwords'))
              ? 0.05
              : mode === 'out-of-range'
                ? 2
                : 0.95),
        },
      ]),
    )
    if (mode === 'multi-partial') delete answers.attack_check
    res.end(
      JSON.stringify({
        model: body.model,
        answers,
        ...(mode === 'no-usage' ? {} : { usage: { input_tokens: 600, output_tokens: 3 } }),
      }),
    )
  })
  await new Promise((resolve) => upstream.listen(0, '127.0.0.1', resolve))
  const base = `http://127.0.0.1:${upstream.address().port}`
  const evidence = { command: 'node --test test/e2e/moderation-services.e2e.test.mjs', checks: [] }
  let gw
  try {
    const env = {
      NODE_OPTIONS: `--import=${pathToFileURL(path.resolve('test/e2e/helpers/moderation-fetch.mjs')).href}`,
      MODERATION_TEST_UPSTREAM: base,
      KIN_RATE_CAP: '10000',
      KIN_RATE_REFILL: '10000',
    }
    gw = await startGateway({ readyMs: 60000, env })
    const endpoint = await api(gw, 'POST', '/api/panel/api-endpoints', {
      body: {
        kind: 'custom',
        protocol: 'anthropic',
        base_url: base,
        models: [{ name: 'claude-review-fixture', upstream_model: 'claude-review-fixture' }],
        api_key_entries: [{ api_key: 'synthetic-inference' }],
      },
    })
    assert.equal(endpoint.status, 201, endpoint.text)
    const opted = await api(gw, 'PATCH', `/api/panel/api-endpoints/${endpoint.json.item.id}`, {
      body: { risk_review_enabled: true },
    })
    assert.equal(opted.status, 200, opted.text)
    const configure = async (body) => {
      const result = await api(gw, 'PUT', '/api/panel/jev-intercept', { body })
      assert.equal(result.status, 200, result.text)
      assert.ok(!result.text.includes('synthetic-'), 'credentials must not be returned')
      return result.json
    }
    await configure({
      provider: 'jev',
      enabled: true,
      base_url: base,
      api_keys: ['synthetic-jev'],
      model: 'jev-latest',
      hard_regex_enabled: false,
      fail_open: false,
      dedup_sec: 60,
      questions: [{ id: 'safety', label: '安全', instructions: 'Is the content safe?', enabled: true }],
    })
    assert.equal((await configure({ provider: 'perplexity' })).timeout_ms, 30000)
    const saved = await configure({
      base_url: 'https://api.perplexity.ai',
      api_keys: ['synthetic-pplx'],
      model: 'pplx-decider-v1.3',
      enabled: true,
      fail_open: false,
      dedup_sec: 60,
    })
    assert.equal(saved.provider, 'perplexity')
    const classify = async (text) =>
      api(gw, 'POST', '/v1/messages', {
        body: { model: 'claude-review-fixture', max_tokens: 8, messages: [{ role: 'user', content: text }] },
      })
    await classify('Summarize the museum opening hours.')
    assert.equal(calls.at(-1).url, '/v1/decisions')
    const beforeCache = calls.length
    await classify('Summarize the museum opening hours.')
    assert.equal(calls.length, beforeCache)
    const history = async (query = '') => {
      const result = await api(gw, 'GET', `/api/panel/moderation-reviews${query}`)
      assert.equal(result.status, 200, result.text)
      return result.json
    }
    let records = await history()
    assert.equal(records.rows.length, 2, JSON.stringify(records.rows))
    const cached = records.rows.find((row) => row.cache_hit)
    const actual = records.rows.find((row) => !row.cache_hit)
    assert.equal(actual.provider, 'perplexity')
    assert.equal(actual.requested_model, 'pplx-decider-v1.3')
    assert.equal(actual.estimated_cost_nano_usd, 12000)
    assert.equal(cached.estimated_cost_nano_usd, 0)
    assert.equal(cached.source_review_id, actual.id)
    assert.equal(actual.result, 'pass')
    assert.ok(actual.config_revision)
    const detail = await api(gw, 'GET', `/api/panel/moderation-reviews/${actual.id}`)
    assert.equal(detail.json.attempts.length, 1)
    assert.equal(detail.json.attempts[0].upstream_request_id, `upstream-${beforeCache}`)
    assert.equal(detail.json.attempts[0].input_nano_usd_per_token, 20)
    evidence.checks.push('Perplexity 地址、模型、600 Token 费用、缓存归属和调用明细')
    const multiQuestions = [
      {
        id: 'policy_check',
        label: '使用政策',
        instructions: 'Is this content compliant with the usage policy?',
        enabled: true,
      },
      {
        id: 'sexual_check',
        label: '色情检查',
        instructions: 'Is this content free of sexual material?',
        enabled: true,
      },
      {
        id: 'attack_check',
        label: '攻击检查',
        instructions: 'Is this content free of instructions for cyber abuse?',
        enabled: true,
      },
      {
        id: 'disabled_check',
        label: '已停用检查',
        instructions: 'This disabled question must not be sent.',
        enabled: false,
      },
    ]
    const enabledIds = ['policy_check', 'sexual_check', 'attack_check']
    evidence.multi_question_cases = []
    for (const [model, expectedCost, rate] of [
      ['pplx-decider-v1.3', 12000, 20],
      ['pplx-decider-flash-v1.3', 6000, 10],
    ]) {
      await configure({ model, questions: multiQuestions, safety_instruction: '', dedup_sec: 60 })
      for (const failedId of [null, ...enabledIds, 'missing-answer']) {
        const beforeIds = new Set((await history()).rows.map((row) => row.id))
        const beforeCalls = calls.length
        mode = failedId === 'missing-answer' ? 'multi-partial' : 'safe'
        questionScores = Object.fromEntries(enabledIds.map((id) => [id, id === failedId ? 0.05 : 0.95]))
        const message = `museum multi-question scenario ${model} ${failedId || 'all-safe'}`
        const response = await classify(message)
        assert.equal(calls.length - beforeCalls, 1, '全部问题必须通过一次上游请求发送')
        const sent = calls.at(-1)
        assert.equal(sent.url, '/v1/decisions')
        assert.equal(sent.model, model)
        assert.ok(sent.state.includes(message), `正文必须随问题组发送：${JSON.stringify(sent.state)}`)
        assert.deepEqual(Object.keys(sent.questions), enabledIds, '同一请求包含三道启用题，不包含停用题')
        for (const question of multiQuestions.filter((item) => item.enabled)) {
          assert.equal(sent.questions[question.id].type, 'noul')
          assert.equal(sent.questions[question.id].instructions, question.instructions)
        }
        const newRows = (await history()).rows.filter((row) => !beforeIds.has(row.id))
        assert.equal(newRows.length, 1, '一个问题组对应一条审查记录')
        const review = newRows[0]
        assert.equal(review.provider, 'perplexity')
        assert.equal(review.requested_model, model)
        assert.equal(review.attempt_count, 1)
        assert.equal(review.input_tokens, 600)
        assert.equal(review.output_tokens, 3)
        assert.equal(review.estimated_cost_nano_usd, expectedCost, '使用返回用量计价，不额外乘问题数')
        const attemptDetail = await api(gw, 'GET', `/api/panel/moderation-reviews/${review.id}`)
        assert.equal(attemptDetail.json.attempts.length, 1)
        assert.equal(attemptDetail.json.attempts[0].input_nano_usd_per_token, rate)
        assert.equal(attemptDetail.json.attempts[0].estimated_cost_nano_usd, expectedCost)
        if (failedId === 'missing-answer') {
          assert.equal(response.status, 403, response.text)
          assert.equal(review.result, 'unavailable', '漏答一道题不能作为完整审查通过')
          assert.equal(attemptDetail.json.attempts[0].outcome, 'invalid_response')
        } else if (failedId) {
          assert.equal(response.status, 403, response.text)
          assert.equal(review.result, 'block')
          assert.deepEqual(review.categories, [failedId], '只记录实际低分的问题')
        } else {
          assert.equal(review.result, 'pass')
          assert.deepEqual(review.categories, [])
          const beforeCacheIds = new Set((await history()).rows.map((row) => row.id))
          await classify(message)
          assert.equal(calls.length, beforeCalls + 1, '相同问题组命中缓存，不再次调用上游')
          const cacheRows = (await history()).rows.filter((row) => !beforeCacheIds.has(row.id))
          assert.equal(cacheRows.length, 1)
          assert.equal(cacheRows[0].source_review_id, review.id)
          assert.equal(cacheRows[0].cache_hit, true)
          assert.equal(cacheRows[0].attempt_count, 0)
          assert.equal(cacheRows[0].estimated_cost_nano_usd, 0)
        }
        evidence.multi_question_cases.push({
          model,
          question_count: enabledIds.length,
          scenario: failedId || 'all-safe',
          result: review.result,
          upstream_calls: calls.length - beforeCalls,
          input_tokens: review.input_tokens,
          estimated_cost_nano_usd: review.estimated_cost_nano_usd,
        })
      }
    }
    questionScores = null
    mode = 'safe'
    await configure({
      model: saved.model,
      questions: saved.question_bank,
      safety_instruction: saved.safety_instruction,
    })
    evidence.checks.push('标准与 Flash v1.3 三题同发、停用题排除、逐题拦截、漏答失败、问题组缓存，以及一次用量计费')
    mode = 'block'
    const blocked = await classify('Please classify this distinct museum request.')
    assert.equal(blocked.status, 403, blocked.text)
    assert.equal((await history()).rows[0].result, 'block')
    mode = 'invalid'
    const invalid = await classify('A distinct malformed response scenario.')
    assert.equal(invalid.status, 403, invalid.text)
    assert.equal((await history()).rows[0].result, 'unavailable')
    mode = 'no-usage'
    await classify('A distinct missing usage scenario.')
    assert.equal((await history()).rows[0].estimated_cost_nano_usd, null)
    evidence.checks.push('拦截结果、无效响应按失败策略处理、缺少用量时费用未知')
    await configure({ timeout_ms: 200 })
    for (const failure of ['timeout', 'invalid-json', 'out-of-range', 'network']) {
      mode = failure
      const failed = await classify(`Distinct ${failure} scenario`)
      assert.equal(failed.status, 403, failed.text)
      assert.equal((await history()).rows[0].result, 'unavailable')
    }
    await configure({ fail_open: true, timeout_ms: 30000 })
    mode = 'invalid'
    const open = await classify('Distinct fail open scenario')
    assert.notEqual(open.status, 403)
    assert.equal((await history()).rows[0].action, 'pass')
    await configure({ fail_open: false })
    mode = 'safe'
    await configure({ model: 'pplx-decider-flash-v1.3' })
    await classify('Summarize the museum opening hours.')
    assert.equal((await history()).rows[0].estimated_cost_nano_usd, 6000)
    assert.equal((await history()).rows[0].cache_hit, false)
    await configure({ model: 'unknown-price-model' })
    await classify('Summarize the museum opening hours.')
    assert.equal((await history()).rows[0].estimated_cost_nano_usd, null)
    await configure({
      model: 'pplx-decider-v1.3',
      safety_threshold: 0.6,
      endpoints: [{ base_url: 'https://api.perplexity.ai/v1/decisions', api_keys: ['synthetic-pplx'] }],
    })
    const catalog = await api(gw, 'POST', '/api/panel/jev-intercept/models', { body: {} })
    assert.ok(catalog.json.models.includes('pplx-decider-v1.3'))
    const beforeProbe = (await history()).rows.length
    mode = 'baseline'
    const probe = await api(gw, 'POST', '/api/panel/jev-intercept/probe', { body: {} })
    assert.equal(probe.status, 200, probe.text)
    assert.equal(probe.json.results[0].baseline_ok, true)
    assert.equal((await history()).rows.length, beforeProbe)
    const beforeQuota = calls.length
    const quota = await api(gw, 'POST', '/api/panel/jev-intercept/quota', { body: {} })
    assert.equal(quota.json.results[0].status, 'unsupported')
    assert.equal(calls.length, beforeQuota)
    evidence.checks.push(
      '超时、网络、JSON 和分数异常；失败放行；Flash 计价；未知价格；模型缓存隔离；基准测试与不支持的余额查询',
    )
    mode = 'retry'
    await configure({ api_keys: ['synthetic-first', 'synthetic-second'], dedup_sec: 0 })
    for (let i = 0; i < 2; i++) await classify(`Retry scenario ${i}`)
    records = await history()
    assert.ok(records.rows.some((row) => row.attempt_count === 2 && row.unknown_cost_attempts === 1))
    assert.equal(calls.filter((call) => call.authorization === 'Bearer synthetic-first').length, 1)
    mode = 'rate-limit'
    await configure({ api_keys: ['synthetic-limited'] })
    for (let i = 0; i < 2; i++) await classify(`Rate limit scenario ${i}`)
    assert.equal(
      calls.filter((call) => call.authorization === 'Bearer synthetic-limited').length,
      2,
      '429 must not permanently retire a Perplexity key',
    )
    records = await history()
    mode = 'safe'
    const jev = await configure({ provider: 'jev' })
    assert.equal(jev.model, 'jev-latest')
    assert.equal(jev.api_key_count, 1)
    assert.equal(jev.safety_threshold, 0.5)
    await classify('Summarize the museum opening hours.')
    assert.equal(calls.at(-1).url, '/v1/systemone')
    assert.equal(calls.at(-1).authorization, 'Bearer synthetic-jev')
    const filtered = await history('?provider=perplexity&model=pplx-decider-v1.3&limit=1')
    assert.equal(filtered.rows.length, 1)
    assert.equal(filtered.has_more, true)
    const cursor = filtered.next_cursor
    const next = await history(
      `?provider=perplexity&model=pplx-decider-v1.3&limit=1&cursor_created_at=${encodeURIComponent(cursor.created_at)}&cursor_id=${cursor.id}`,
    )
    assert.notEqual(next.rows[0].id, filtered.rows[0].id)
    assert.equal((await history('?provider=jev')).rows.length, 1)
    assert.equal((await api(gw, 'GET', '/api/panel/moderation-reviews?result=invalid')).status, 400)
    evidence.checks.push('服务配置恢复、缓存隔离、重试费用、429 不永久停用密钥、筛选和游标分页')
    const old = await api(gw, 'GET', `/api/panel/moderation-reviews/${actual.id}`)
    assert.equal(old.json.review.estimated_cost_nano_usd, 12000)
    await gw.stop()
    gw = await startGateway({ project: gw.project, readyMs: 60000, env })
    assert.equal((await history()).rows.length, records.rows.length + 1)
    evidence.checks.push('历史费用不变、审查记录在重启后保留')
    const createdUser = await api(gw, 'POST', '/api/panel/users', {
      body: { username: 'review-reader', password: 'review-reader-password', role: 'user' },
    })
    assert.equal(createdUser.status, 201, createdUser.text)
    const login = await fetch(`${gw.baseUrl}/api/panel/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: 'review-reader', password: 'review-reader-password' }),
    })
    assert.equal(login.status, 200)
    for (const url of [
      '/api/panel/moderation-reviews',
      `/api/panel/moderation-reviews/${actual.id}`,
      '/api/panel/jev-intercept',
    ]) {
      const denied = await fetch(`${gw.baseUrl}${url}`, { headers: { cookie: login.headers.get('set-cookie') } })
      assert.equal(denied.status, 403)
    }
    assert.ok(!JSON.stringify(await history()).includes('synthetic-'))
    evidence.checks.push('租户不能访问审查列表、详情或服务配置；记录不含完整密钥')
    evidence.status = 'passed'
    evidence.node_version = process.version
    evidence.sources = Object.fromEntries(
      [
        'src/lib/moderation/providers.mjs',
        'src/lib/protocol/jev-intercept.mjs',
        'src/lib/protocol/jev-usage.mjs',
        'src/lib/db/repos/moderation-reviews-repo.mjs',
        'src/lib/db/repos/jev-usage-repo.mjs',
        'src/lib/db/migrations/057_moderation_reviews.sql',
        'src/lib/admin/panel-routes.mjs',
        'src/lib/admin/panel-acl.mjs',
        'src/server.mjs',
        'web/src/features/moderation-reviews/index.tsx',
        'web/src/features/settings/moderation-pane.tsx',
        'test/e2e/moderation-services.e2e.test.mjs',
        'test/e2e/helpers/moderation-fetch.mjs',
      ].map((file) => [
        file,
        createHash('sha256')
          .update(fs.readFileSync(path.join(REPO_ROOT, file)))
          .digest('hex'),
      ]),
    )
    const target = process.env.MODERATION_E2E_ARTIFACT || path.join(os.tmpdir(), 'vm2api-moderation-services-e2e.json')
    fs.mkdirSync(path.dirname(target), { recursive: true })
    fs.writeFileSync(target, JSON.stringify(evidence, null, 2) + '\n')
    console.log(`验收工件：${target}`)
  } finally {
    if (gw) await gw.stop()
    await new Promise((resolve) => upstream.close(resolve))
  }
})
