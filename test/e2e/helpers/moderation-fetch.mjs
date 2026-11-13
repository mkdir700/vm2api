/** 仅在端到端测试子进程中把官方地址转到本地协议模拟上游。 */
const original = globalThis.fetch
if (!process.env.MODERATION_TEST_UPSTREAM) throw new Error('缺少本地模拟上游')
globalThis.fetch = (input, options) => {
  const url = new URL(typeof input === 'string' ? input : input.url || input)
  if (url.origin === 'https://api.perplexity.ai')
    return original(`${process.env.MODERATION_TEST_UPSTREAM}${url.pathname}${url.search}`, options)
  return original(input, options)
}
