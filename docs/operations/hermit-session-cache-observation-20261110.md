# Hermit session/cache observation — 2026-11-10

## Operator path

Reload the panel. Open Logs → Request details → Session cache.

The view groups retained requests under the external client session. It shows the routing session, logical branch, explicit agent, native owner/generation, owner-selection reason, prefix change and actual cache reads/writes. The selected request expands automatically when it is among the displayed recent details. Manual refresh sends no model request.

Use the administrator endpoint for machine-readable observations:

```text
GET /api/panel/vms/vm-01/session-cache?session=<external-or-routing-session>
```

Tenants cannot read the endpoint. Unknown VMs return an explicit error. Unsupported older kernels return an explicit compatibility error. Ordinary inference remains compatible with older kernels.

## Interpretation

One external Claude Code session can generate a main conversation and classifier or agent requests. Keep independent native owners for those branches. A main continuation reuses its existing owner when its routing key and history remain compatible. Separate native owners can still read upstream cache when their actual prompt prefixes match.

The existing native fetch hook observes hashes of the actual serialized prefix. No external Claude Code hook installation is required. The diagnostic does not change provider requests or owner routing. Prefix hashes compare whole messages, not the provider token-level cache key. Cache counters come from observed response usage. Missing usage remains unknown. A changed message hash alone does not prove a full cache miss.

The kernel retains 128 recent request records across the pool and 64 branch-prefix checkpoints. Restart clears this window. Branch totals cover retained records only. The panel displays the most recent 20 request details for the selected session. No database migration or historical backfill is included. No prompt, image or authentication contents are retained for this diagnostic.

## Runtime identity and acceptance

The active control source is `da0f2d7056aa77409e13f9892890c42abf3396cb`. Its image is `sha256:8cc23698705147338b1b9eb85badf31f88b13684bf46cbdbd8e1d1136ce44428`. The image overlays only three server files and built frontend assets on the previous immutable production image. The existing Compose service persists the image pins. The 286 deployed file hashes and served index hash were verified.

The panel HTTP E2E passed nine assertions. The built frontend passed six ego-browser assertions. Reproduce with:

```sh
pnpm -C web build
node --test test/e2e/session-cache.e2e.test.mjs
node --test test/e2e/session-cache-page.e2e.test.mjs
```

The browser E2E produces a JSON receipt, screenshot and DOM snapshots. It uses an isolated gateway with synthetic usage rows and a kernel socket fixture. It closes its browser task after success. No unit tests were added.

The native acceptance record is in the sibling Hermit repository at `docs/session-cache-observation-acceptance-20261110.md`. The final machine receipt is [evidence/hermit-session-cache-20261110.json](evidence/hermit-session-cache-20261110.json). Runtime identities remain pinned independently of later documentation commits.

## Preservation boundary

The existing account required an explicit management-API token refresh during the validation window. The account record stayed the same. No token contents appear in evidence. Final kernel preservation compares credentials against the post-refresh stage baseline. Control activation separately verified existing mounts, non-image environment values, unrelated containers and source/file identity. Finalizing a target kernel transition removes only its owned rollback guest. That cleanup is separate from preservation of unrelated containers.

## Final production result

Native source `3a1786b1394dd491be67bf819d2b32e057022d09`, package `0.0.0-production.sessioncache4`, is applied and finalized on vm-01. All 425 frozen-package native assertions passed. The real external session `96e8b558-d125-406a-964b-fcf2ef714054` generated four main requests and three classifier requests. All seven returned HTTP 200 on the first attempt. The main requests retained one owner. Classifiers retained independent temporary owners and recorded actual cache reads. Every request/routing identity, cache counter and branch sum matched gateway usage rows. Concurrent quota read passed while a tool result was pending. Final guest executable/hook pins, health, restored scheduling and post-refresh credential/configuration preservation passed.
