import test from 'node:test'
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { createHash, randomBytes } from 'node:crypto'
import { mkdtemp, mkdir, readFile, writeFile, copyFile, stat, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { MANAGED_EGRESS_IMAGE } from '../../src/lib/vm/managed-egress-docker.mjs'

const execute = promisify(execFile)
const artifact = path.resolve('.tmp/managed-egress-e2e/compose-receipt.json')
async function receipt(value) {
  await mkdir(path.dirname(artifact), { recursive: true })
  const target = value.status === 'NOT RUN' ? artifact.replace('compose-receipt', 'compose-not-run-receipt') : artifact
  await writeFile(target, JSON.stringify(value, null, 2))
}

test('production Compose initializes and preserves managed egress configuration', { timeout: 120000 }, async (t) => {
  if (process.env.MANAGED_EGRESS_LINUX_E2E !== '1' || process.platform !== 'linux') {
    await receipt({ status: 'NOT RUN', reason: 'explicit Linux Docker acceptance is required' })
    t.skip('explicit Linux Docker acceptance is required')
    return
  }
  const docker = async (args, allowFailure = false) => {
    try {
      const result = await execute('docker', args, { timeout: 45000, maxBuffer: 1024 * 1024 })
      return { ok: true, stdout: result.stdout.trim() }
    } catch (error) {
      if (allowFailure) return { ok: false }
      throw new Error('controlled_compose_command_failed', { cause: error })
    }
  }
  assert.equal((await docker(['info', '--format', '{{.OSType}}'])).stdout, 'linux')
  await docker(['image', 'inspect', MANAGED_EGRESS_IMAGE])
  // The runner and daemon must see the same absolute fixture path.
  const root = await mkdtemp(path.join(tmpdir(), 'managed-compose-'))
  const results = []
  try {
    for (const overlay of [false, true]) {
      const fixture = path.join(root, overlay ? 'arm64' : 'base')
      await mkdir(path.join(fixture, 'deploy'), { recursive: true })
      for (const file of ['docker-compose.yml', 'docker-compose.arm64.yml', 'deploy/init-managed-egress.sh'])
        await copyFile(path.resolve(file), path.join(fixture, file))
      await writeFile(path.join(fixture, '.env'), '', { mode: 0o600 })
      const project = `me-bootstrap-${randomBytes(6).toString('hex')}`
      const prefix = [
        'compose',
        '--project-directory',
        fixture,
        '-p',
        project,
        '-f',
        path.join(fixture, 'docker-compose.yml'),
      ]
      if (overlay) prefix.push('-f', path.join(fixture, 'docker-compose.arm64.yml'))
      const compose = (args, allowFailure = false) => docker([...prefix, ...args], allowFailure)
      const configDir = path.join(fixture, overlay ? '.local/arm64/data/managed-egress' : 'data/managed-egress')
      const configFile = path.join(configDir, 'config.json')
      try {
        await compose(['config', '--quiet'])
        await compose(['up', '-d', '--pull', 'never', '--no-build', 'sing-box'])
        const id = (await compose(['ps', '-q', 'sing-box'])).stdout
        assert.ok(id)
        const container = JSON.parse((await docker(['inspect', id])).stdout)[0]
        assert.equal(container.State.Running, true)
        assert.equal(container.Config.Labels['com.docker.compose.project'], project)
        assert.equal(container.HostConfig.NetworkMode, 'host')
        assert.equal(container.HostConfig.ReadonlyRootfs, true)
        assert.notEqual(container.HostConfig.Privileged, true)
        assert.ok(container.HostConfig.CapDrop.includes('ALL'))
        assert.ok(!container.HostConfig.CapAdd?.length)
        assert.equal(container.Mounts.length, 1)
        assert.equal(container.Mounts[0].Source, configDir)
        assert.equal(container.Mounts[0].RW, false)
        const initial = await readFile(configFile, 'utf8')
        assert.deepEqual(JSON.parse(initial).inbounds, [])
        assert.equal((await stat(configFile)).mode & 0o777, 0o600)
        assert.equal((await stat(configDir)).mode & 0o777, 0o700)
        await compose(['run', '--rm', '--no-deps', '--pull', 'never', 'sing-box-init'])
        assert.equal(await readFile(configFile, 'utf8'), initial)
        await compose(['down', '--remove-orphans'])
        const invalid = '{"invalid-controlled-fixture":'
        await writeFile(configFile, invalid, { mode: 0o600 })
        assert.equal((await compose(['up', '-d', '--pull', 'never', '--no-build', 'sing-box'], true)).ok, false)
        assert.equal(await readFile(configFile, 'utf8'), invalid)
        const running = (await compose(['ps', '--status', 'running', '-q'])).stdout
        assert.equal(running, '', 'invalid configuration must prevent service startup')
        const failedInit = (await compose(['ps', '-a', '-q', 'sing-box-init'])).stdout
        assert.ok(failedInit)
        const initState = JSON.parse((await docker(['inspect', failedInit])).stdout)[0].State
        assert.equal(initState.Running, false)
        assert.equal(initState.ExitCode, 1, 'the real initializer must reject the invalid file')
        results.push({
          overlay: overlay ? 'arm64' : 'base',
          empty_start: true,
          repeat_preserves: true,
          invalid_preserves_and_blocks: true,
        })
      } finally {
        // The project is generated here and exists only under this owned fixture.
        await compose(['down', '--remove-orphans'])
      }
    }
    const files = [
      'test/e2e/managed-egress-compose.e2e.test.mjs',
      'docker-compose.yml',
      'docker-compose.arm64.yml',
      'deploy/init-managed-egress.sh',
    ]
    await receipt({
      status: 'PASS',
      command: 'MANAGED_EGRESS_LINUX_E2E=1 node --test test/e2e/managed-egress-compose.e2e.test.mjs',
      source_files: Object.fromEntries(
        await Promise.all(
          files.map(async (file) => [
            file,
            createHash('sha256')
              .update(await readFile(file))
              .digest('hex'),
          ]),
        ),
      ),
      sing_box_image: MANAGED_EGRESS_IMAGE,
      environment: `${process.platform}/${process.arch}`,
      results,
      scope:
        'production Compose sing-box bootstrap only; gateway image, installer, deployed upgrade, VM startup, and host reboot are not exercised',
    })
  } catch (error) {
    await receipt({ status: 'FAIL', reason: 'inspect the controlled Compose test assertion' })
    throw error
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
