# Desktop connection probe handling

## Contract

An authenticated exact Claude Desktop gateway sign-in probe receives the existing local HTTP 200 response with text OK and zero usage. This behavior applies when compatibility.claude_code_only is absent, false or true. No inference account, native owner or provider request is needed. The response verifies gateway authentication and connectivity; it does not verify provider inference availability.

Keep the existing exact request classifier and the master-key pinned diagnostic exception. Similar prompts, streamed requests and requests with system or metadata retain the normal inference path. Invalid authentication still returns HTTP 401. Strict Claude Code admission still applies to ordinary requests. Conversation duplicate protection remains active.

## Implementation

Remove only the Claude Code-only switch condition from the existing local probe response branch in handle-protocol.mjs. Do not add configuration or widen the classifier. Remove the obsolete isolated test that expected switch-off probes to reach inference. Its replacement is a full HTTP E2E. No unit tests were added or run.

## Verification

The final E2E fails against original commit ac49f288 with HTTP 503 pool_unavailable instead of local HTTP 200. The modified source passes 24 probe calls over absent/off/on settings, master/managed credentials, max_tokens 1/16 and repeated submissions. These calls work without any eligible model account. Logs show zero attempts, zero tokens, zero cost, no VM and no outbound session. No mock upstream trace is created. Invalid authentication returns 401.

Seven ordinary or pinned diagnostic variants still reach the upstream, including a streamed request. The test also checks strict admission after updating configuration through the panel API. Existing completed-duplicate and native-failure-policy HTTP E2E tests pass.

Reproduce with Node 22.23.4:

```sh
node --test test/e2e/desktop-connection-probe.e2e.test.mjs test/e2e/completed-request-duplicate.e2e.test.mjs test/e2e/hermit-native-failure-policy.e2e.test.mjs
```

The Desktop probe E2E prints its artifact directory. It retains source hashes, request log observations, boundary responses and summary.json. Set DESKTOP_PROBE_E2E_OUT to choose a fresh output directory.

[Machine receipt](desktop-connection-probe-20261112.json). The isolated verification uses a clean detached checkout. Unrelated kernel timing changes in the shared checkout are preserved. No production deployment, real provider requests or UI acceptance were performed.
