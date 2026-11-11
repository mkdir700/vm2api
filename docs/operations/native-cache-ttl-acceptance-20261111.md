# Native cache TTL acceptance — 2026-11-11

Status: Qualified and deployed. See [production deployment](native-cache-ttl-deployment-20261111.md). The JSON readiness receipt below records the state before deployment approval.

## Result

vm2api forwards the private cache TTL on streamed and assembled responses. Hermit sets both official Claude Code cache TTL environment variables before launch. Native continuations retain the initial TTL. Original-session resume restores the checkpoint TTL. Independent native queries can choose another TTL. Unsupported native operations retain HTTP 501 and platform ownership without account failover.

The original real-chain reproduction failed with `Cache override is not supported`. Both TTLs and both response modes subsequently passed the real gateway/API-kernel/Hermit/pinned-CLI chain with a synthetic provider. Direct native coverage proved that changing the requested TTL does not change an existing session or its resumed process.

## Qualified release

- vm2api source: `8126700761ea7ae0ebc18eb0a7cd2f82c4364495`
- Hermit source: `1a2ea1a87ffd47d4528cd7306696054b95698891`
- Controller image: `sha256:354270caa77793f5034cb43ccafe197edaf0a35b237bcc12d2a1ea8eb5f10a0d`
- Native package: `0.0.0-production.cache-ttl-1a2ea1a`
- Native binary SHA-256: `aa9dd171a58da03743e3b5e8cfc5866a58cda09adadb45eb5c75922c6d78756a`
- Native manifest SHA-256: `cb3516639f39f33157b0b221723c1de7613b4c24dc9dfabc6322e65b7977c5a2`
- Native archive SHA-256: `0cc8e915c309f15280e1631f9e696eeb52a3d69366cccc0c9a1d655f7af30e29`
- Clean source fingerprints verified. The fixed CLI is v2.1.318.

| Exact-release scenario | Result | Checks |
| --- | --- | --- |
| full | PASS | container cleanup |
| legacy | PASS | container cleanup |
| cache-1h-stream | PASS | container cleanup |
| cache-5m-assembled | PASS | container cleanup |
| direct-cache-pin | PASS | container cleanup |
| gateway | PASS | 17 |
| native-full-chain | PASS | 65 |
| native-legacy | PASS | 48 |
| cache-1h-stream-checks | PASS | 79 |
| cache-5m-assembled-checks | PASS | 79 |
| direct-cache-pin-checks | PASS | 78 |

The Node HTTP suite also passed native failure ownership, native policy, legacy policy, and compaction cache regression checks against the exported target image. Test containers used `--network none`, read-only inputs, synthetic authentication, and process cleanup receipts. No production credentials were used. Real-provider cache hits and billing were NOT RUN.

## Reproducible evidence

- Server release directory: `/opt/vm2api-releases/native-cache-ttl-1a2ea1a-8126700`
- Standard offline upgrade package: `/opt/vm2api-releases/native-cache-ttl-1a2ea1a-8126700/offline`
- Archive: `/opt/vm2api-releases/native-cache-ttl-1a2ea1a-8126700/qualification-evidence.tar.gz`
- Archive SHA-256: `e6131b41e68025cccda842b4f3cb9982fd26cad6eded8918367bee77a5807098`
- Archive bytes: `107902`
- Verified local copy: `/tmp/vm2api-native-cache-production-20261111/qualification-evidence.tar.gz`
- Machine receipt: [native-cache-ttl-acceptance-20261111.json](native-cache-ttl-acceptance-20261111.json).

The archive contains per-scenario commands, summaries, source/executable pins, provider captures, tool receipts, and cleanup receipts. Each `qualification/*-command.json` contains the complete Docker argument vector. To replay a case, choose a fresh results directory, replace its `/results` mount source, and run that vector with `subprocess.run(command, check=True)`. Do not reuse an existing scenario output directory.

## Production boundary at qualification time

Production still runs the previous controller and native package. The saved persona remains `native_server` and the selected cache TTL remains `1h`. No production scheduling hold, process restart, credential update, or kernel switch was performed.

The native health report has `active_requests=0`, `pending_tool_results=1`, and `switch_ready=false`. The outstanding state belongs to request `655c0f2e-f055-4437-be73-e2805fa8ac9e`, owner `s-1`. Its owner receipt reports `phase=stopped` and `groups_gone=true`; the pending external tool-result state remains retained. The standard kernel-transition guard rejects this state with `kernel_tools_pending`.

Do not bypass the guard. Obtain specific authorization before discarding that pending state. Revalidate its identity immediately before any action. After an authorized discard, capture a fresh credential and configuration baseline before deployment. Preserve current credentials; never restore an old token snapshot.

## Closure

The user subsequently authorized discarding the specific retained state. The supported slot recovery cleared it without changing credentials or protected configuration. The qualified controller and native package are now deployed, the transition is finalized, and scheduling is restored. See the separate production deployment receipt above.
