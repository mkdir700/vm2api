import { ErrorCode, isClientCancelledResult } from '../core/errors.mjs'
import { randomUUID, timingSafeEqual } from 'node:crypto'
import {
  context,
  trace,
  ROOT_CONTEXT,
  SpanKind,
  SpanStatusCode,
  isSpanContextValid,
  defaultTextMapGetter,
  defaultTextMapSetter,
} from '@opentelemetry/api'
import { TracerProvider, BatchSpanProcessor, ParentBasedSampler, AlwaysOnSampler } from '@opentelemetry/sdk-trace'
import { AsyncLocalStorageContextManager } from '@opentelemetry/context-async-hooks'
import { W3CTraceContextPropagator } from '@opentelemetry/core'
import { resourceFromAttributes } from '@opentelemetry/resources'
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-proto'

const errorCodes = new Set([
  ...Object.values(ErrorCode),
  'native_delivery_unknown',
  'session_capacity_exhausted',
  'native_credential_busy',
])
const safeErrorCode = (value) => (errorCodes.has(value) ? value : value ? 'upstream_error' : null)

const propagator = new W3CTraceContextPropagator()
let tracer = trace.getTracer('vm2api')
let resource

export function setupObservability(version = 'source') {
  if (
    process.env.OTEL_SDK_DISABLED === 'true' ||
    !(process.env.OTEL_EXPORTER_OTLP_ENDPOINT || process.env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT)
  )
    return async () => {}
  try {
    resource = {
      'service.namespace': 'truerouter',
      'service.name': 'vm2api',
      'service.version': version,
      'service.instance.id': process.env.TRUEROUTER_INSTANCE_ID || randomUUID(),
      'deployment.environment.name': process.env.TRUEROUTER_ENVIRONMENT || 'unspecified',
    }
    const exporter = new OTLPTraceExporter({ timeoutMillis: 3000 })
    const provider = new TracerProvider({
      resource: resourceFromAttributes(resource),
      sampler: new ParentBasedSampler({ root: new AlwaysOnSampler() }),
      spanProcessors: [
        new BatchSpanProcessor({
          exporter,
          maxQueueSize: 2048,
          maxExportBatchSize: 512,
          scheduledDelayMillis: 1000,
          exportTimeoutMillis: 3000,
        }),
      ],
    })
    const manager = new AsyncLocalStorageContextManager().enable()
    context.setGlobalContextManager(manager)
    trace.setGlobalTracerProvider(provider)
    tracer = provider.getTracer('vm2api')
    lifecycle('service_started')
    return async () => {
      lifecycle('service_stopping')
      let timer
      try {
        await Promise.race([
          provider.shutdown(),
          new Promise((resolve) => {
            timer = setTimeout(resolve, 4000)
          }),
        ])
      } finally {
        clearTimeout(timer)
        manager.disable()
      }
    }
  } catch {
    console.warn('observability_setup_failed')
    return async () => {}
  }
}

export function traceFields() {
  const sc = trace.getSpanContext(context.active())
  return sc && isSpanContextValid(sc) ? { trace_id: sc.traceId, span_id: sc.spanId } : {}
}

// Only application-owned metadata is accepted. Never pass bodies or raw errors.
export function event(name, fields = {}) {
  const ids = traceFields()
  if (!ids.trace_id || !resource) return
  if (process.stdout.writableLength > 1024 * 1024) return
  process.stdout.write(
    `${JSON.stringify({ time: new Date().toISOString(), level: ['failure', 'unknown'].includes(fields.outcome) ? 'ERROR' : 'INFO', msg: 'truerouter.observability', ...resource, event: name, ...ids, ...fields })}\n`,
  )
}

function lifecycle(name) {
  if (!resource || process.stdout.writableLength > 1024 * 1024) return
  process.stdout.write(
    `${JSON.stringify({ time: new Date().toISOString(), level: 'INFO', msg: 'truerouter.observability', ...resource, event: name })}\n`,
  )
}

function trusted(req, authenticated) {
  const expected = process.env.TRUEROUTER_TRACE_TOKEN || ''
  const actual = String(req.headers?.['x-observability-token'] || '')
  return (
    authenticated &&
    expected.length >= 32 &&
    Buffer.byteLength(expected) === Buffer.byteLength(actual) &&
    timingSafeEqual(Buffer.from(expected), Buffer.from(actual))
  )
}

class StreamState {
  pending = Buffer.alloc(0)
  discard = false
  complete = false
  failed = false
  content = false
  feed(chunk) {
    let data = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    while (data.length) {
      const end = data.indexOf(10)
      const part = end < 0 ? data : data.subarray(0, end)
      if (!this.discard) {
        if (this.pending.length + part.length <= 65536) this.pending = Buffer.concat([this.pending, part])
        else {
          this.pending = Buffer.alloc(0)
          this.discard = true
        }
      }
      if (end < 0) return
      if (!this.discard) this.line(this.pending.toString('utf8'))
      this.pending = Buffer.alloc(0)
      this.discard = false
      data = data.subarray(end + 1)
    }
  }
  line(line) {
    if (!line.startsWith('data:')) return
    const data = line.slice(5).trim()
    if (data === '[DONE]') {
      this.complete = true
      return
    }
    try {
      const value = JSON.parse(data)
      if (['message_stop', 'response.completed'].includes(value.type)) this.complete = true
      if (['error', 'response.failed'].includes(value.type) || value.error) this.failed = true
      if (
        value.delta?.text ||
        (value.type === 'response.output_text.delta' && value.delta) ||
        value.choices?.some((c) => c.delta?.content)
      )
        this.content = true
    } catch {}
  }
}

export function observeRequest(req, res, authenticated, operation, fn) {
  const trustedPeer = trusted(req, authenticated)
  const parent = trustedPeer ? propagator.extract(ROOT_CONTEXT, req.headers, defaultTextMapGetter) : ROOT_CONTEXT
  const span = tracer.startSpan('vm2api.request', { kind: SpanKind.SERVER, attributes: { operation } }, parent)
  const active = trace.setSpan(parent, span)
  return context.with(active, () => {
    const state = new StreamState()
    const started = performance.now()
    let ended = false
    let responseStarted = false
    let responseType = ''
    const contentType = () => responseType || String(res.getHeader('content-type') || '')
    const feed = (chunk) => {
      responseStarted = true
      if (!contentType().includes('text/event-stream')) return
      const was = state.content
      state.feed(chunk)
      if (!was && state.content)
        context.with(active, () => event('first_content', { duration_ms: performance.now() - started }))
    }
    const write = res.write
    const end = res.end
    const writeHead = res.writeHead
    const diagnosticOutcome = () => {
      const bag = res._observabilityResult?.() || {}
      if (
        ['transport_error', 'outcome_unknown', 'unknown'].includes(bag.final_state) ||
        String(bag.error_code || '').endsWith('_unknown')
      )
        return 'unknown'
      if (bag.final_state === 'cancelled') return 'cancelled'
      if (res.statusCode >= 400 || state.failed) return 'failure'
      if (contentType().includes('text/event-stream') && !state.complete) return 'unknown'
      return 'success'
    }
    res.writeHead = function (...args) {
      const headerIndex = args[1] && typeof args[1] === 'object' ? 1 : args[2] && typeof args[2] === 'object' ? 2 : -1
      const headers = headerIndex >= 0 ? { ...args[headerIndex] } : {}
      const supplied = Object.entries(headers).find(([key]) => key.toLowerCase() === 'content-type')?.[1]
      responseType = String(supplied || this.getHeader('content-type') || '')
      if (trustedPeer && !this.headersSent) {
        this.setHeader(
          'X-Observability-Outcome',
          contentType().includes('text/event-stream') ? 'pending' : diagnosticOutcome(),
        )
        if (contentType().includes('text/event-stream')) {
          const existing = this.getHeader('Trailer')
          this.setHeader('Trailer', existing ? `${existing}, X-Observability-Outcome` : 'X-Observability-Outcome')
          if (headerIndex >= 0) {
            const suppliedTrailer = Object.entries(headers).find(([key]) => key.toLowerCase() === 'trailer')?.[1]
            for (const key of Object.keys(headers)) if (key.toLowerCase() === 'trailer') delete headers[key]
            headers.Trailer = `${suppliedTrailer || existing ? `${suppliedTrailer || existing}, ` : ''}X-Observability-Outcome`
            args[headerIndex] = headers
          }
        }
      }
      return writeHead.apply(this, args)
    }
    res.write = function (chunk, ...args) {
      const result = write.call(this, chunk, ...args)
      if (chunk != null) feed(chunk)
      return result
    }
    res.end = function (chunk, ...args) {
      if (chunk != null && typeof chunk !== 'function') feed(chunk)
      if (trustedPeer && this.headersSent && contentType().includes('text/event-stream'))
        this.addTrailers({ 'X-Observability-Outcome': diagnosticOutcome() })
      return end.call(this, chunk, ...args)
    }
    const finish = (finished) => {
      if (ended) return
      ended = true
      const stream = contentType().includes('text/event-stream')
      const bag = res._observabilityResult?.() || {}
      const unknown =
        ['transport_error', 'outcome_unknown', 'unknown'].includes(bag.final_state) ||
        String(bag.error_code || '').endsWith('_unknown')
      const outcome = unknown
        ? 'unknown'
        : state.failed || res.statusCode >= 400
          ? 'failure'
          : !finished
            ? 'cancelled'
            : stream && !state.complete
              ? 'unknown'
              : 'success'
      span.setAttributes({
        outcome,
        'http.response.status_code': res.statusCode,
        stream_complete: stream && state.complete,
      })
      if (['failure', 'unknown'].includes(outcome)) span.setStatus({ code: SpanStatusCode.ERROR, message: outcome })
      context.with(active, () =>
        event('request_completed', {
          error_code: safeErrorCode(bag.error_code),
          request_id: res._kinRequestId || '',
          outcome,
          status: res.statusCode,
          response_started: responseStarted,
          stream_complete: stream && state.complete,
          duration_ms: performance.now() - started,
          vm_id: bag.vm_id || null,
          account_id: bag.account_id || null,
          attempt_count: bag.attempt_count || null,
        }),
      )
      span.end()
    }
    res.once('finish', () => finish(true))
    res.once('close', () => finish(false))
    event('request_started')
    try {
      const result = fn()
      if (res._kinRequestId) span.setAttribute('request_id', res._kinRequestId)
      return Promise.resolve(result).catch((error) => {
        span.setStatus({ code: SpanStatusCode.ERROR, message: 'handler_failure' })
        throw error
      })
    } catch (error) {
      span.setStatus({ code: SpanStatusCode.ERROR, message: 'handler_failure' })
      throw error
    }
  })
}

export function injectSlot(headers, trustedHermit = false, reqHeaders = {}) {
  const result = { ...headers }
  // Never let caller headers choose the next span's context.
  for (const key of Object.keys(result))
    if (['traceparent', 'tracestate', 'baggage', 'x-observability-token'].includes(key.toLowerCase()))
      delete result[key]
  if (trustedHermit) {
    propagator.inject(context.active(), result, defaultTextMapSetter)
    const correlation = reqHeaders['x-hermit-gateway-request-id']
    if (typeof correlation === 'string' && correlation.length <= 128 && !/[\u0000\r\n]/.test(correlation))
      result['x-hermit-gateway-request-id'] = correlation
  }
  return result
}

export function observeAttempt(exec, requestId, fn, signal) {
  return tracer.startActiveSpan('vm2api.slot', { kind: SpanKind.CLIENT }, async (span) => {
    const metadata = { attempt_id: requestId, vm_id: exec?.vmId || exec?.vm?.id || '' }
    const started = performance.now()
    span.setAttributes(metadata)
    event('attempt_started', metadata)
    try {
      const result = await fn()
      const outcome =
        signal?.aborted || isClientCancelledResult(result)
          ? 'cancelled'
          : result?.ok
            ? 'success'
            : result?.outcomeUnknown ||
                ['transport_error', 'unknown', 'incomplete'].includes(result?.terminalState) ||
                String(result?.body?.error?.code || '').endsWith('_unknown')
              ? 'unknown'
              : 'failure'
      span.setAttribute('outcome', outcome)
      if (outcome === 'failure' || outcome === 'unknown')
        span.setStatus({ code: SpanStatusCode.ERROR, message: outcome })
      event('attempt_completed', {
        ...metadata,
        outcome,
        error_code: safeErrorCode(result?.body?.error?.code),
        duration_ms: performance.now() - started,
      })
      return result
    } catch (error) {
      span.setStatus({ code: SpanStatusCode.ERROR, message: 'attempt_failure' })
      event('attempt_completed', { ...metadata, outcome: 'unknown', duration_ms: performance.now() - started })
      throw error
    } finally {
      span.end()
    }
  })
}
