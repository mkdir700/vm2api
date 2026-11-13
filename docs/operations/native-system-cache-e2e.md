# Native system-context cache qualification

## Failure inventory (before implementation)

- The final gateway sanitizer lifts supported native system/developer turns into the fixed system prefix.
- A model policy change leaks into ordinary API/wrap transports or permits unsupported native models.
- Successive budget reminders change the fixed system or tool catalog, lose their history boundary, or add synthetic user anchors.
- Tool results or signed assistant history change during forwarding.
- The real native owner is replaced on an append-only continuation.
- Native serialization rewrites previously submitted messages or changes cache TTL.
- Streamed and assembled usage lose cache-read, cache-write or TTL-specific creation fields.
- A test reports a simulated cache hit as a verified provider cache hit.
- A negative control fails to detect a deliberately changed system prefix.
- Failed tests omit evidence or leave native processes running.

## Acceptance contract

The HTTP regression suite exercises the production gateway with its synthetic transport. It covers native model boundaries, ordinary transport compatibility, growing multi-turn system/developer history, both response modes and both cache TTLs. It must fail on the original Sonnet 4.6 gate. Each run writes a content-free summary and source hashes, including on failure.

The real-native suite extends the existing Hermit prewarm E2E. It runs the production HTTP gateway, API kernel, released Hermit and pinned CLI against a deterministic synthetic provider. It checks tool continuation with new system context, stable owner selection, stable provider system/tools, preserved provider history and cache usage propagation. It must distinguish an actual system change as a negative control. Synthetic counters establish propagation only; they do not establish provider billing or cache storage.

Real-provider acceptance requires a separate explicit live run with synthetic messages and isolated execution state. Never replay customer requests. Never clear production pending tool results. Record provider usage separately from simulated results.

## Live finding and decision boundary

Historical result: the first capability-gate candidate was rejected by live acceptance. Do not deploy that candidate.

The real provider returns HTTP 400 with `role 'system' is not supported on this model` for Sonnet 4.6. The pinned native runtime retries its initial request but times out on the appended-system continuation. Source comments asserting native Sonnet/Opus 4.6 support are not sufficient evidence of provider capability. The official capability list also excludes Sonnet 4.6: https://platform.claude.com/docs/en/build-with-claude/mid-conversation-system-messages

A model without mid-conversation system support cannot simultaneously preserve system-role authority, keep all changing system instructions before history, and reuse the historical prefix. Moving reminders into user context changes instruction priority. This behavior needs a user decision. Alternatives are preserving authority with historical cache rewrites, or rejecting unsupported system turns and requiring a supported model. No production change is authorized by this diagnostic decision.

## Adopted forwarding decision

The user subsequently selected uniform system-message forwarding. The new implementation preserves mid-conversation system instructions for every model and returns upstream failures without a merging fallback. It does not assert that every provider/model supports the feature. See `mid-conversation-system-forwarding.md` for the current contract and acceptance boundaries. Production deployment remains NOT RUN.
