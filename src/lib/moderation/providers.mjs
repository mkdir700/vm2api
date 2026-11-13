/** 审查服务的协议与公开价格。调用方不拼接服务专属路径。 */
const systemone = (base) => {
  if (/\/(systemone|decide)$/i.test(base)) return base
  return /\/v1$/i.test(base) ? `${base}/systemone` : `${base}/v1/systemone`
}
const decisions = (base) => {
  if (/\/decisions$/i.test(base)) return base
  return /\/v1$/i.test(base) ? `${base}/decisions` : `${base}/v1/decisions`
}
const probabilityRequest = ({ state, questions, model }) => ({ state, questions, ...(model ? { model } : {}) })
const definitions = [
  {
    id: 'jev',
    label: 'Jev',
    default_model: 'jev-latest',
    default_base_url: 'https://api.typesafe.ai',
    url: systemone,
    request: probabilityRequest,
  },
  {
    id: 'perplexity',
    label: 'Perplexity',
    default_model: 'pplx-decider-v1.3',
    default_timeout_ms: 30000,
    default_base_url: 'https://api.perplexity.ai',
    url: decisions,
    request: probabilityRequest,
  },
  {
    id: 'laya',
    label: 'Laya',
    default_model: '',
    default_base_url: 'http://127.0.0.1:8000',
    url: systemone,
    request: probabilityRequest,
  },
  {
    id: 'modernbert',
    label: 'ModernBERT',
    default_model: 'english',
    default_base_url: 'http://127.0.0.1:8000',
    url: systemone,
    request: probabilityRequest,
  },
]
export const POLICY_PROVIDERS = Object.freeze(
  definitions.map(({ url, request, ...metadata }) => Object.freeze(metadata)),
)
export const providerOf = (id) => definitions.find((item) => item.id === id) || definitions[0]
export function decisionEndpoint(baseUrl, provider = 'jev') {
  const base = String(baseUrl || '')
    .trim()
    .replace(/\/+$/, '')
  return base ? providerOf(provider).url(base) : ''
}
export const PERPLEXITY_MODELS = [
  'pplx-decider-v1.3',
  'pplx-decider-flash-v1.3',
  'pplx-decider-v1.2',
  'pplx-decider-flash-v1.2',
]
export function decisionRequest(provider, input) {
  return providerOf(provider).request(input)
}

export function retiresKey(provider, status) {
  return provider === 'perplexity' ? status === 401 : [401, 429, 529].includes(status)
}
export function reviewPrice({ provider, model, official_typesafe, official_perplexity }) {
  if (provider === 'jev' && official_typesafe)
    return { input: 42, output: 0, basis: 'typesafe-public-2026-10-25-estimate' }
  if (provider === 'perplexity' && official_perplexity) {
    const name = String(model || '').replace(/^perplexity\//, '')
    if (/^pplx-decider-(v1\.[23]|latest)$/.test(name))
      return { input: 20, output: 0, basis: 'perplexity-public-2026-11-13-estimate' }
    if (/^pplx-decider-flash-(v1\.[23]|latest)$/.test(name))
      return { input: 10, output: 0, basis: 'perplexity-public-2026-11-13-estimate' }
  }
  return null
}
