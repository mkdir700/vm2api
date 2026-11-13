# Hermit client implementation declarations

## Contract

When `vm.dataplane` is `hermit`, the Messages worker envelope omits
`user-agent`, `x-app`, and all `x-stainless-*` headers. This applies to both
incoming declarations and the gateway's synthetic declarations, including
the fixed Claude Code `2.1.303` identity.

Hermit's bundled Claude Code owns the provider request identity. The gateway
does not replace the fixed version with another version or add a configuration
option. Other dataplanes retain their existing headers.

Protocol controls, session identity, and internal request correlation remain
outside this filter. A gateway envelope or debug dump is not an observation of
the final provider HTTP request.

## Verification

Use Node.js 22.15 or newer:

```sh
node --test test/e2e/hermit-client-declarations.e2e.test.mjs
```

The test runs 16 requests through the real HTTP gateway and scheduler with a
synthetic kernel transport. It covers Hermit and wrap, OAuth and API key,
official and harness clients, and JSON and SSE responses. It verifies omitted
implementation declarations, retained protocol controls and session metadata,
and unchanged wrap declarations.

Evidence is written on success and failure to
`.tmp/hermit-client-declarations/summary.json` and
`.tmp/hermit-client-declarations/gateway-envelopes.json`. Set
`HERMIT_DECLARATIONS_OUT` to retain a separate run. The summary includes checks
and source hashes. The envelopes contain synthetic identities only.

This test does not start real Hermit, call a paid provider, or validate the final
provider wire. No production deployment is part of this change.
