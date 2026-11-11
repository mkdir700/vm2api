# Native Claude Code (server environment)

Status: implemented and validated with isolated synthetic providers; not deployed.

## Ownership

The `native_server` selection is a request-processing policy, not a template. Its UI label is `原生 Claude Code（服务端环境）`. Initially support only the Hermit HTTP dataplane. Reject unsupported dataplanes before sending. Slot selection overrides global selection. Existing presets, including the retired `official_303` alias, retain their semantics.

vm2api extracts caller instructions and conversation from recognized automatic client context. Hermit selects the pinned CLI default core prompt and retains actual runtime environment attachments. Retained caller instructions use the pinned native append mechanism. Bind policy to the native owner and its recovery checkpoint. Reject silent policy changes on an existing owner.

External tools still execute in the caller environment. Preserve schemas, IDs, arguments, results, and caller ownership. Explain that server runtime facts do not describe the external tool workstation.

## Extraction

Recognize generated environment sections by the exact native invocation introduction and metadata schema. Remove only known generated metadata. Recognize dedicated automatic cwd and date reminders separately from task text. Remove exact known official core blocks and the known 2.1.303 guidance template with its generated memory directory. Preserve unknown envelope variants and mixed custom prose. Preserve arbitrary system reminders, paths, code literals, tool data, and intentional task mentions. Preserve retained block order and bytes, including images and whitespace. Unknown variants can contain metadata; do not claim complete removal from those variants.

This policy does not guarantee removal of metadata embedded in arbitrary task content. It does not map external paths into server paths.

The private envelope field is `hermit_environment_policy`. Hermit consumes it before provider serialization. Health must advertise `native_server_environment: true`; older runtimes fail before dispatch. The policy participates in admission and original-session checkpoint compatibility. See Hermit ADR 0061.

## Failure inventory

1. Settings normalize the identifier to an existing preset.
2. Slot override loses to global selection.
3. A non-Hermit route receives an unsupported policy.
4. Official passthrough or auxiliary requests bypass extraction.
5. Template rendering parks original caller context in a user message.
6. Recognized automatic cwd, hostname, platform, OS, shell, memory directory, or date survives.
7. Extraction removes application rules, custom prose, images, intentional paths, or whitespace.
8. CLI core prompt is replaced instead of extended.
9. Dispatch suppresses server environment or leaks old client context on follow-up.
10. Tool schemas, IDs, opaque arguments, results, or execution ownership change.
11. Changed catalogs or stopped owners lose policy on recovery.
12. Malformed, missing, or duplicate results launch an unowned query.
13. Failure leaves listeners, CLI, tmux, or process-family children alive.
14. Existing presets or non-Hermit paths change behavior.

## Acceptance

Write failing E2E coverage before implementation. Exercise settings and inference over HTTP. Feed actual envelopes into the real pinned CLI through Hermit with an isolated synthetic provider. Compare final provider captures with a direct native baseline. Cover initial, follow-up, tool continuation, auxiliary, and owner recovery. Retain summary.json, captures, source and executable hashes, reproduction commands, tool receipts, and cleanup receipts. Real-provider and production acceptance remain NOT RUN.
