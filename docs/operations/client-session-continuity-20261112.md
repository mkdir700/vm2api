# Client session continuity repair — 2026-11-12

## Scope

Repair routing and serialization for external Claude session `b488e459-f76b-49af-9783-ba5e1ccf675e`, whose gateway routing session was `f7d39a4f-a7c6-40e6-a6c2-a1ccf37dc8e0`. This is an implementation and isolated qualification record. It is not a deployment record.

## Behavior

- Preserve supported `messages[].role=system` on native Hermit hops, even when external HTTP headers omit the system-message beta. Direct HTTP routes keep their existing beta gate.
- Let Hermit select native incremental system serialization independently of tool argument streaming. Preserve existing effort behavior and per-tool streaming policy.
- Reuse admitted historical assistant equivalences without weakening tool-result ownership. Compatible main continuations retain their native owner and actual provider prefix.
- Allocate official away-recap queries to temporary independent owners. Give each a `recap` purpose and parent branch reference. The panel labels these as away recaps.
- A new gateway attempt ID permits another generation over the same history. Repeated attempt IDs fail explicitly during the ten-minute in-memory retry window. No body-hash answer caching is introduced.

The exact observed recap instruction is the compatibility discriminator because this client does not provide a separate reliable purpose field. Quoted text and embedded tool-result contents do not match. Unknown future recap formats retain existing behavior. Durable cross-restart idempotency is outside this contract.

## Evidence boundaries

Gateway beta sanitization inserted a U+200B cache-only user block in the first production request, then omitted it from later history. That changed the native branch anchor. Later cwd updates also caused system-prefix changes. This explains observed routing and prefix changes. It does not prove why a probabilistic model produced the sentence about an empty message. The repair removes the demonstrated request transformation; live model behavior is not claimed.

## Validation

The baseline failed the native continuity and recap branch E2E scenarios. The gateway HTTP baseline failed `native_system_turn_preserved`. An intermediate full-eager serializer candidate failed effort propagation and was rejected. Final acceptance must use the frozen final candidate and its machine receipt.

Local gateway checks use:

```sh
NATIVE_SERVER_E2E_OUT=/absolute/new/evidence node --test test/e2e/native-server-environment.e2e.test.mjs
node --test test/e2e/session-cache.e2e.test.mjs
pnpm -C web build
```

Native scenarios use the sibling Hermit repository's `experiment/client_compatibility_e2e.py`, `experiment/tool_streaming_profile_e2e.py` and `experiment/effort_profile_e2e.py`. The complete gateway scenario uses the existing `test/fixtures/native-server-gateway.mjs`, an API kernel, Node, the actual pinned native CLI, and a loopback synthetic provider inside `network=none`.

No unit tests or real-provider calls are part of this qualification. No production container, credential, scheduling setting, user conversation or kernel package was changed. These native E2E scenarios remain manually runnable; this change does not add a hosted CI execution gate.

## Final isolated acceptance

All ten native suites passed on the final binary, with 257 assertions. The gateway HTTP check passed 21 assertions. Session-cache panel HTTP, Hermit static checks, changed-JavaScript formatting, diff checks and frontend build passed. Every native run confirmed owned process-group cleanup. The complete HTTP chain retained one owner and an append-only serialized prefix across directory updates with eager argument streaming disabled.

The qualified native binary SHA-256 is `1032ba4e93227a32b48a752714753abde7dda7ff146255d2af5c7132e4f49a67`. Build: Go 1.26.10, Linux AMD64, CGO disabled, trimmed paths, VCS stamping disabled. All 313 frozen Hermit files and 383 gateway source files matched the current implementation. The gateway's generated public snapshot is recorded separately because startup regenerates it. The machine receipt also pins 2424 dependency files, Node, the API kernel, CLI, fixture image and command vectors.

See [the machine receipt](evidence/client-session-continuity-20261112.json). Full synthetic captures and frozen inputs remain under `primaryserver:/tmp/hermit-continuity-20261112/`. The existing seven Hermit commits were preserved. No deployment, publication or real-model/cache-hit acceptance is claimed.
