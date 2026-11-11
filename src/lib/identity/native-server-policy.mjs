/** Recognized automatic client envelopes only. Tool payloads are opaque. */
import { isKnownOfficialSystemText } from './crs-persona.mjs'
import { OFFICIAL_303_GUIDANCE } from './official-profiles.mjs'

export const NATIVE_SERVER_POLICY = 'native_server'
const escapeRegex = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
const generatedGuidance = new RegExp(
  `^${OFFICIAL_303_GUIDANCE.split('{{memory_dir}}').map(escapeRegex).join('[^\\r\\n`]+')}$`,
)
const ENV_INTRO = '# Environment\nYou have been invoked in the following environment: '
const ENV_LINE =
  /^ - (?:Primary working directory|Is a git repository|Platform|Shell|OS Version|Hostname|Host name|Memory directory|Timezone|Locale|Current date): [^\n]*(?:\n|$)/

function systemText(text) {
  if (isKnownOfficialSystemText(text) || generatedGuidance.test(text.trim())) return ''
  // Consume a recognized generated section, stopping before any custom prose.
  // Never match generic paths or a heading without the generated introduction.
  return text.replace(
    /(?:^|(?<=\n))# Environment\nYou have been invoked in the following environment: *\n(?: - (?:Primary working directory|Is a git repository|Platform|Shell|OS Version|Hostname|Host name|Memory directory|Timezone|Locale|Current date): [^\n]*(?:\n|$))+/g,
    '',
  )
}

function automaticReminder(text) {
  const match = text.match(/^<system-reminder>\n([\s\S]*)\n<\/system-reminder>\n?$/)
  if (!match) return false
  const inner = match[1]
  if (/^The current working directory is [^\n]+\.?$/.test(inner)) return true
  if (/^Today's date is \d{4}-\d{2}-\d{2}\.?$/.test(inner)) return true
  if (!inner.startsWith(`${ENV_INTRO}\n`)) return false
  let tail = inner.slice(ENV_INTRO.length + 1)
  while (ENV_LINE.test(tail)) tail = tail.replace(ENV_LINE, '')
  return !tail.trim()
}

function mapSystem(value) {
  if (typeof value === 'string') return systemText(value)
  if (!Array.isArray(value)) return value
  return value.flatMap((block) => {
    if (typeof block?.text !== 'string') return [block]
    const text = systemText(block.text)
    return text.trim() ? [{ ...block, text }] : []
  })
}

export function applyNativeServerPolicy(body) {
  return {
    ...body,
    hermit_environment_policy: NATIVE_SERVER_POLICY,
    system: mapSystem(body.system),
    messages: (body.messages || []).flatMap((message) => {
      if (message.role === 'system') {
        const content = mapSystem(message.content)
        return (typeof content === 'string' && !content.trim()) || (Array.isArray(content) && !content.length)
          ? []
          : [{ ...message, content }]
      }
      if (message.role !== 'user') return [message]
      if (typeof message.content === 'string') return automaticReminder(message.content) ? [] : [message]
      if (!Array.isArray(message.content)) return [message]
      const content = message.content.filter((block) => block?.type !== 'text' || !automaticReminder(block.text))
      return content.length ? [{ ...message, content }] : []
    }),
  }
}
