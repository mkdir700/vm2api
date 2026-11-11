# Native cache TTL contract

## Decision

Keep `cache_ttl` in the private worker envelope. Accept only `5m` and `1h`. Native Hermit maps this value to `CLAUDE_CODE_PROMPT_CACHE_TTL` and `CLAUDE_CODE_SUBAGENT_PROMPT_CACHE_TTL` before launching the pinned CLI. Do not rewrite native model request bodies. Do not expand the managed environment allowlist.

The first admitted request fixes the TTL for its native session. Continuations ignore later TTL changes. The native resume checkpoint preserves the TTL across owner replacement. An omitted TTL leaves the CLI defaults in effect. A new conversation uses its own requested TTL. Native classifier owners receive the same launch policy. No-prompt-cache remains an independent per-request control.

Forward the envelope TTL for both streamed and assembled responses. Invalid values fail before session creation. Unsupported native operations remain platform-owned, preserve HTTP 501, stop failover, and do not penalize provider accounts.

## Failure inventory and acceptance

- Streaming rejects a valid explicit TTL before inference.
- Assembled responses silently lose the TTL.
- Continuation or native resume changes the original TTL.
- A new conversation incorrectly inherits another conversation's TTL.
- Private cache controls leak into model inputs or modify opaque tools.
- Invalid TTL launches a native process.
- Error mapping blames providers or retries another account.

Extend the existing synthetic-provider E2E before implementation. Run the real HTTP gateway, API kernel, Hermit, and the pinned Claude Code executable in an isolated network. Exercise `5m` and `1h`, both response modes, tool continuation, native owner recovery, and auxiliary conversations. Assert actual provider cache markers and launched process environment. Retain command, source/executable hashes, captures, tool receipts, checks, and process cleanup. No real-provider request or production change is part of local acceptance.
