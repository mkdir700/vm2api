# Claude Code compaction cache policy

vm2api disables prompt caching for a recognized Claude Code compaction request. The policy applies to that request only. The first request after compaction keeps its normal cache policy and can write the shorter history to cache.

The gateway uses the official compaction headers when available. Without those headers, it recognizes the verified Claude Code 2.1.318 and 2.1.319 request shapes. It checks the complete summary instruction and the position of the cache breakpoint. A normal turn that pastes the same text keeps its cache policy. Unknown versions and unrecognized shapes keep their existing policy.

The gateway removes prompt cache controls after rewriting the request. The native Hermit runtime also removes them after Claude Code serializes the actual provider request. The policy travels on the private slot interface and is scoped to one exchange. Removing the controls also disables cache reads for that request.

Install the compatible Hermit runtime before enabling this vm2api build on that slot. Verify that the slot health reports `no_prompt_cache: true`. A recognized compaction request cannot use an older Hermit runtime that cannot enforce the policy.

Run the gateway regression with:

```sh
node --test test/e2e/compaction-cache.e2e.test.mjs
```

In the Hermit repository, build the current binary and run the native slot regression against the loopback provider:

```sh
go build -o /private/tmp/hermit-compaction ./cmd/hermit
python3 experiment/owned_admission_e2e.py --slot --no-prompt-cache \
  --hermit-proxy-bin /private/tmp/hermit-compaction \
  --out /private/tmp/hermit-compaction-evidence
```
