/** Fill missing display metadata through the slot's existing OAuth transport. */
import path from 'node:path'
import { getVm, patchVmRecord } from '../vm/vm-registry.mjs'
import { withVmLock } from '../vm/vm-file.mjs'
import { runSlotOauth } from '../transport/slot-oauth.mjs'
import { canOfficialUsage, credentialModeOfVm } from './credential-mode.mjs'
import { readWorkerCredentialFile } from './oauth-credentials.mjs'
import { flattenOauthIdentity } from './oauth-identity.mjs'

export async function syncMissingSlotEmail(projectRoot, vm) {
  if (vm.claude?.email?.trim() || !canOfficialUsage(credentialModeOfVm(vm))) return vm
  const scope = vm.claude?.scope || vm.claude?.scopes?.join(' ') || ''
  if (scope && !scope.split(/\s+/).includes('user:profile')) return vm
  const homeDir = path.join(projectRoot, 'vms', vm.id, 'cli-home')
  const vmPath = path.join(projectRoot, 'vms', `${vm.id}.json`)
  const before = JSON.stringify(vm.claude)
  const credentialBefore = JSON.stringify(readWorkerCredentialFile(homeDir))
  try {
    const response = await runSlotOauth({ vmId: vm.id, vm, homeDir }, 'profile', { timeoutMs: 5000 })
    if (!response?.ok) return vm
    const identity = flattenOauthIdentity(response.body)
    if (!identity.email) return vm
    return await withVmLock(vmPath, () => {
      const current = getVm(projectRoot, vm.id)
      if (!current) return vm
      // Credential import or refresh may have won while the profile was in flight.
      if (JSON.stringify(current.claude) !== before) return current
      if (JSON.stringify(readWorkerCredentialFile(homeDir)) !== credentialBefore) return current
      if (current.claude?.account_uuid && current.claude.account_uuid !== identity.account_uuid) return current
      return patchVmRecord(projectRoot, vm.id, { claude: { ...current.claude, email: identity.email } }) || current
    })
  } catch {
    // Display metadata must not change the authoritative usage/import outcome.
    return vm
  }
}
