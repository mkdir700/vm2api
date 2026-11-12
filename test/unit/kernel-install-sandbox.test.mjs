import test from 'node:test'
import assert from 'node:assert/strict'
import { suspendVmRuntimeRestart } from '../../src/lib/vm/vm-runtime.mjs'

const native = { id: 'vm-13', dataplane: 'wrap' }
const output = (securityOpts, restart = 'unless-stopped', init = 'true') =>
  `false|0|kin-eg-local||kin-os/ubuntu:24.04|existing-host|docker||false|${restart}|${JSON.stringify(securityOpts)}|${init}`

test('stopped kernel installation disables only Docker restart policy, without start, reset or recreation', () => {
  const mutations = []
  const result = suspendVmRuntimeRestart(native, {
    run(argv) {
      if (argv[1] === 'inspect') return { ok: true, stdout: output(['no-new-privileges']) }
      mutations.push(argv)
      assert.deepEqual(argv, ['docker', 'update', '--restart', 'no', 'kin-13'])
      return { ok: true }
    },
  })
  assert.equal(result.ok, true)
  assert.equal(mutations.length, 1)
})

test('policy suspension is idempotent and refuses uncertain Docker state rather than replacing a live slot', () => {
  for (const [run, expected] of [
    [
      (argv) => {
        assert.equal(argv[1], 'inspect')
        return { ok: true, stdout: output([], 'no') }
      },
      true,
    ],
    [
      (argv) => {
        assert.equal(argv[1], 'inspect')
        return { ok: false, code: 1, stderr: 'Error: No such object: kin-13' }
      },
      true,
    ],
    [
      (argv) => {
        assert.equal(argv[1], 'inspect')
        return { ok: false, code: 1, stderr: 'permission denied connecting to Docker daemon' }
      },
      false,
    ],
  ]) {
    const result = suspendVmRuntimeRestart(native, { run })
    assert.equal(result.ok, expected)
    if (!expected) assert.equal(result.code, 'kernel_restart_policy_failed')
  }
})
