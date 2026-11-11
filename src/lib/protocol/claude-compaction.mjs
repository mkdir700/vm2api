import { createHash } from 'node:crypto'

// Fingerprints of the default and retry compact instructions captured from stock 2.1.318 and 2.1.319.
const TEMPLATES = new Set([
  '63e2bfb4ded280d5057a66d8a034ef352a73960d97d955b990e78f04f0db1fb0',
  '3a2e12effb0d0f2feba2cbcc29ad0a3cdea3fce53e657730c4b2c53311049deb',
])
const CUSTOM_START = '\n\n\nAdditional Instructions:\n'
const REMINDER_START = '\n\nREMINDER:'
const REASONS = new Set(['auto', 'manual', 'reactive'])

export function isClaudeCompaction(body, headers, { officialTraffic } = {}) {
  if (!officialTraffic) return false
  const requestClass = headers['x-claude-code-request-class']
  if (requestClass && requestClass !== 'compaction') return false
  if (requestClass === 'compaction' || REASONS.has(headers['x-claude-code-compaction'])) return true
  if (REASONS.has(headers['x-claude-code-context-compacted'])) return false
  if (!/^claude-cli\/2\.1\.(?:318|319)(?:\s|$)/.test(headers['user-agent'] || '')) return false

  if (!Array.isArray(body.messages)) return false
  const tail = body.messages.at(-1)
  const prior = body.messages.at(-2)
  if (
    tail?.role !== 'user' ||
    prior?.role !== 'assistant' ||
    !Array.isArray(prior.content) ||
    prior.content.at(-1)?.cache_control?.type !== 'ephemeral'
  )
    return false
  // Manual compaction sends a string. Auto can append an unmarked block to
  // the last user message. An ordinary pasted instruction carries the marker.
  const blocks = Array.isArray(tail.content) ? tail.content : null
  if (blocks?.some((block) => block?.cache_control != null)) return false
  const last = blocks?.at(-1)
  let text = blocks ? (last?.type === 'text' ? last.text : null) : tail.content
  if (typeof text !== 'string' || !text.startsWith('CRITICAL: Respond with TEXT ONLY.')) return false
  const customAt = text.indexOf(CUSTOM_START)
  if (customAt !== -1) {
    const reminderAt = text.lastIndexOf(REMINDER_START)
    if (reminderAt <= customAt + CUSTOM_START.length) return false
    text = text.slice(0, customAt) + '\n' + text.slice(reminderAt)
  }
  return TEMPLATES.has(createHash('sha256').update(text).digest('hex'))
}
