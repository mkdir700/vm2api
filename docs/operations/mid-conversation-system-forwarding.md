# Uniform mid-conversation system forwarding

## Contract

All Anthropic Messages models use the same forwarding policy. Preserve nonempty mid-conversation `system` messages in the message history. Do not infer this forwarding policy from a model-name allowlist or the presence of a client beta header. Add `mid-conversation-system-2026-04-07` when forwarding system-message history.

Preserve the text of historical messages, including token-budget reminders. A later request appends context instead of editing earlier context or the fixed system prefix. Existing developer-to-system protocol normalization and initial system instructions before any user message retain their existing behavior. Persona rendering and native CLI serialization may use their existing block representations and reminder wrappers; they must retain the original instruction text and dialogue boundary.

The HTTP beta sanitizer, CLI-hop preparation, zero/official persona rendering, and final worker envelope follow this policy. Hermit admission retains initial context after the first user as well as later updates. The pinned native CLI enables system-message serialization for every model independently of eager tool streaming. Final native dispatch supplies a missing system-message beta without changing the serialized body for that header-only adaptation. Cache diagnostics observe the effective outbound beta header.

This is a forwarding contract, not a claim that every upstream model supports every request. Invalid placements and upstream capability errors must remain errors. Do not silently lift instructions into the top-level system, delete reminders, downgrade them to user messages, or switch models to hide errors.

## Validation

`test/e2e/native-system-cache.e2e.test.mjs` exercises real gateway HTTP with synthetic transport. It covers ten catalog models, Hermit/wrap transports, three persona presets, two TTLs, streamed/non-streamed responses, and growing system/developer context. The receipt records source hashes and checks instruction text, order, stable system/tools, and beta propagation.

`test/e2e/repeated-request-native.e2e.py --growing-context` runs the real gateway, API kernel, Hermit, and pinned Claude Code against a synthetic provider. Provider captures must retain the first system instruction, subsequent budget instructions and the prior message prefix. The native owner must remain reusable and cleanup must remove its process groups. Synthetic usage establishes propagation only.

The earlier direct-provider probes are in `../artifacts/mid-system-live-20261113`. They establish bounded acceptance and instruction-following observations separately. Sonnet 5 differs from the published capability list; Sonnet 5.5 and Fable have prompt-sensitive semantic failures. Those observations do not authorize changing or filtering client instructions.

## Implementation acceptance

The local receipt is `../artifacts/uniform-mid-system-20261113/receipt.json`. Production deployment and real-provider cache-hit acceptance are NOT RUN. No production configuration was changed.
