import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { connectSsh, hostKeyDigest, privateKeyProblem } from '../../src/lib/cluster/ssh-link.mjs'

/** Use only the selected alias identity and a host key already trusted by OpenSSH. */
export function readSshAliasTarget(alias) {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/.test(alias || '')) throw new Error('invalid_ssh_alias')
  const config = execFileSync('ssh', ['-G', alias], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
  const values = (key) =>
    config
      .split('\n')
      .filter((line) => line.startsWith(`${key} `))
      .map((line) => line.slice(key.length + 1).trim())
  for (const option of ['proxyjump', 'proxycommand'])
    if (values(option).some((value) => value && value !== 'none')) throw new Error('ssh_alias_jump_not_supported')
  const expand = (file) => (file.startsWith('~/') ? path.join(os.homedir(), file.slice(2)) : file)
  const host = values('hostname')[0]
  const port = Number(values('port')[0])
  const username = values('user')[0]
  const identity = values('identityfile')
    .map(expand)
    .find((file) => fs.existsSync(file))
  if (!identity || !host || !username || !Number.isInteger(port)) throw new Error('ssh_alias_identity_unavailable')
  const privateKey = fs.readFileSync(identity, 'utf8')
  if (privateKeyProblem(privateKey)) throw new Error('ssh_alias_key_requires_supported_local_authentication')
  const lookup = port === 22 ? host : `[${host}]:${port}`
  const files = values('userknownhostsfile')
    .flatMap((value) => value.split(/\s+/))
    .map(expand)
  let key
  for (const file of files) {
    if (!fs.existsSync(file)) continue
    let entries
    try {
      entries = execFileSync('ssh-keygen', ['-F', lookup, '-f', file], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
      })
    } catch {
      continue
    }
    const line = entries.split('\n').find((entry) => !entry.startsWith('#') && entry.split(/\s+/)[1] === 'ssh-ed25519')
    if (line) {
      key = Buffer.from(line.split(/\s+/)[2], 'base64')
      break
    }
  }
  if (!key?.length) throw new Error('ssh_alias_trusted_ed25519_host_key_unavailable')
  return {
    host,
    port,
    username,
    authType: 'key',
    privateKey,
    expectedSha256: hostKeyDigest(key),
  }
}

export async function connectSshAlias(alias) {
  const result = await connectSsh(readSshAliasTarget(alias))
  return result.client
}
