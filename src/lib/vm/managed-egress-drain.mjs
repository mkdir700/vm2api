import http from 'node:http'
import { pauseManagedEgress } from './managed-egress-admission.mjs'

/** Each request opens a fresh Unix connection and pins the helper's boot identity. */
export class EgressDrainClient {
  constructor({ id, socketPath }) {
    this.id = id
    this.socketPath = socketPath
    this.instance = null
  }
  request(method, route, timeoutMs = 1500) {
    return new Promise((resolve, reject) => {
      let timer
      const fail = () => {
        clearTimeout(timer)
        reject(new Error('managed_helper_control_failed'))
      }
      const request = http.request(
        {
          socketPath: this.socketPath,
          path: route,
          method,
          agent: false,
          headers: this.instance ? { 'if-match': this.instance } : {},
          timeout: 1500,
        },
        (response) => {
          let body = ''
          response.on('error', fail)
          response.on('data', (chunk) => {
            body += chunk
            if (body.length > 8192) response.destroy()
          })
          response.on('end', () => {
            try {
              const state = JSON.parse(body)
              if (
                response.statusCode !== 200 ||
                state.version !== 1 ||
                state.proxy_id !== this.id ||
                !/^[a-f0-9]{32}$/.test(state.instance) ||
                typeof state.paused !== 'boolean' ||
                !Number.isSafeInteger(state.active) ||
                state.active < 0 ||
                (this.instance && state.instance !== this.instance)
              )
                throw new Error()
              clearTimeout(timer)
              resolve(state)
            } catch {
              fail()
            }
          })
        },
      )
      request.on('error', fail)
      request.on('timeout', () => request.destroy(new Error('control timeout')))
      timer = setTimeout(() => request.destroy(new Error('control deadline')), Math.max(1, Math.min(1500, timeoutMs)))
      request.end()
    })
  }
  async pause(timeoutMs = 1500) {
    const deadline = Date.now() + timeoutMs
    const state = await this.request('GET', '/status', timeoutMs)
    this.instance = state.instance
    const remaining = deadline - Date.now()
    if (remaining <= 0) throw new Error('managed_helper_pause_timeout')
    const paused = await this.request('POST', '/pause', remaining)
    if (!paused.paused) throw new Error('managed_helper_not_paused')
    return paused
  }
  async status(timeoutMs) {
    if (!this.instance) throw new Error('managed_helper_not_pinned')
    return this.request('GET', '/status', timeoutMs)
  }
  async resume() {
    if (!this.instance) throw new Error('managed_helper_not_pinned')
    const state = await this.request('POST', '/resume')
    if (state.paused) throw new Error('managed_helper_resume_failed')
  }
}

export async function acquireManagedDrain({ ids, helpers }) {
  const admission = pauseManagedEgress(ids)
  const paused = []
  let targets = Array.isArray(helpers) ? helpers : null
  async function resumeHelpers() {
    const results = await Promise.allSettled(paused.map((helper) => helper.resume()))
    return results.every((result) => result.status === 'fulfilled')
  }
  let released = false
  return {
    async wait(timeoutMs) {
      const deadline = Date.now() + timeoutMs
      if (!(await admission.wait(Math.max(0, deadline - Date.now())))) return false
      if (targets == null) targets = await helpers()
      if (paused.length !== targets.length) {
        try {
          for (const helper of targets.slice(paused.length)) {
            if (Date.now() >= deadline) return false
            paused.push(helper)
            await helper.pause(Math.max(1, deadline - Date.now()))
          }
        } catch {
          if (Date.now() >= deadline) return false
          throw new Error('managed_helper_pause_failed')
        }
      }
      do {
        if (!paused.length) return true
        const remaining = deadline - Date.now()
        if (remaining <= 0) return false
        let states
        try {
          states = await Promise.all(paused.map((helper) => helper.status(remaining)))
        } catch (error) {
          if (Date.now() >= deadline) return false
          throw error
        }
        if (states.some((state) => !state.paused)) throw new Error('managed_helper_not_paused')
        if (states.every((state) => state.active === 0)) return true
        if (Date.now() >= deadline) return false
        await new Promise((resolve) => setTimeout(resolve, Math.min(25, Math.max(1, deadline - Date.now()))))
      } while (true)
    },
    async release({ unavailable = false } = {}) {
      if (released) return
      released = true
      const resumed = !unavailable && (await resumeHelpers())
      await admission.release({ unavailable: unavailable || !resumed })
      if (!unavailable && !resumed) throw new Error('managed_helper_resume_failed')
    },
  }
}
