# Native cache TTL production deployment — 2026-11-11

Status: PASS. Deployed on primaryserver at `2026-11-11T05:50:44.727001+00:00`.

## Active release

- vm2api source: `8126700761ea7ae0ebc18eb0a7cd2f82c4364495`
- Controller image: `sha256:354270caa77793f5034cb43ccafe197edaf0a35b237bcc12d2a1ea8eb5f10a0d`
- Hermit source: `1a2ea1a87ffd47d4528cd7306696054b95698891`
- Native package: `0.0.0-production.cache-ttl-1a2ea1a`
- Native binary SHA-256: `aa9dd171a58da03743e3b5e8cfc5866a58cda09adadb45eb5c75922c6d78756a`
- Native manifest SHA-256: `cb3516639f39f33157b0b221723c1de7613b4c24dc9dfabc6322e65b7977c5a2`
- Native archive SHA-256: `0cc8e915c309f15280e1631f9e696eeb52a3d69366cccc0c9a1d655f7af30e29`
- Upgrade task: `81f5d1a6a4064a8cbdf5deb5d416dee2`, PASS / active.
- Kernel transition: `kernel-2b2c09da-07b7-4602-8ab0-e35191db520d`, finalized.

## Authorized retained-state cleanup

The user explicitly authorized discarding the retained external tool-result state for request `655c0f2e-f055-4437-be73-e2805fa8ac9e`. Before acting, revalidated the exact request, owner `s-1`, zero active requests, one retained result, and the stopped owner/process-family receipt.

Paused scheduling with a task-owned hold. Used `POST /api/panel/vms/vm-01/recover` to close the old runtime lease and start the same slot with a fresh native pool. This cleared only the approved retained state. It did not reset the account, delete credentials, or change the selected package.

Recovery preserved credential bytes, native authentication, protected slot fields, routing, and unrelated containers. Captured fresh post-recovery baselines before applying the offline upgrade. No old token snapshot was restored.

## Deployment and verification

Applied the [qualified release](native-cache-ttl-acceptance-20261111.md) through the standard offline executor. Verified the actual controller image and preserved state. Captured a fresh native baseline, applied the registered Hermit package through the ordinary kernel-transition API, verified running binary/CLI/tmux/hook fingerprints, and finalized the transition. Resumed only this task's scheduling hold.

Final production read-back:

- Persona: `native_server` (原生 Claude Code（服务端环境）).
- Selected cache TTL: `1h`.
- `healthy=true`, `native_cache_ttl=true`, `native_server_environment=true`.
- 20 ready session slots, zero active requests, zero pending tool results, zero resident sessions.
- `switch_ready=true`.
- Database `PRAGMA quick_check`: `ok`.
- Credentials, native authentication, protected slot fields, routing, and unrelated containers unchanged against the fresh baseline.
- Scheduling restored to its pre-maintenance state.

The isolated real-CLI E2E proved both TTLs, both response modes, continuation pinning, native resume, independent queries, classifier completion, and legacy compatibility. Production verification checked deployment identity, capabilities, preservation, health, and database integrity. The agent sent zero production model requests. Live-provider cache hits and billing were NOT RUN.

Machine receipt: [native-cache-ttl-deployment-20261111.json](native-cache-ttl-deployment-20261111.json). Private phase receipts and the offline release remain in `/opt/vm2api-releases/native-cache-ttl-1a2ea1a-8126700`. The reproducible qualification archive has SHA-256 `e6131b41e68025cccda842b4f3cb9982fd26cad6eded8918367bee77a5807098`.
