# Retired kernel compatibility

## Contract

- Historical settings round trips can update unrelated settings. An unchanged retired selection remains blocked for inference. New retired selections and changed retired version metadata remain invalid.
- A global default change cannot relabel a slot that still inherits a retired kernel. Explicitly install a supported kernel on those slots first, then update the global default.
- The legacy dataplane endpoint rejects the entire selected batch before any mutation if any selected slot uses a retired kernel, including check-only requests.
- Rollback preserves a retired container and its selection in a stopped state with automatic restart disabled. It preserves credentials. The terminal rollback permits a later explicit supported installation.
- A retired kernel has the schedule cause `kernel_unsupported`. It does not imply an operator-disabled slot or invalid credentials.

## Failure inventory

Unrelated settings may fail validation. Stale clients may fail a second save. Global or per-slot APIs may bypass required installation. A mixed batch may partially mutate. Rollback may restart a retired container, enter a retry loop, destroy a foreign container, or lose credentials. The panel may blame the operator or credentials. Release fixtures may use an obsolete repository URL.

## Verification

Run HTTP regression coverage from the repository root:

```sh
node --test test/e2e/kernel-retirement-compat.e2e.test.mjs test/e2e/kernel-retirement.e2e.test.mjs
```

Run lifecycle coverage on Linux:

```sh
node --test test/e2e/kernel-install-hermit.e2e.test.mjs
```

The HTTP suites write JSON evidence to `.tmp/kernel-compat` and `.tmp/kernel-retirement`. Lifecycle coverage uses a simulated Docker boundary and real control-plane HTTP, package verification, and Unix health requests. It does not establish real guest or production acceptance.

## Verified result

The final local HTTP run passed 11 tests and skipped two Linux-only lifecycle cases. The isolated Linux runs passed all 17 tests across compatibility, retirement, Hermit installation, restart, and seats. Coverage includes a failed Crag-to-Hermit migration followed by a successful retry, recovery from an existing failed journal, and rejection of a foreign backup container.

TypeScript checking, the frontend production build, scoped formatting, and diff whitespace checks passed. Verification artifacts and source hashes are in `.tmp/kernel-compat-verification/summary.json`. No real guest, browser UI, or production acceptance was run. These results cover the local working tree; no commit or deployment is implied.
