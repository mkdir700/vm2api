# Remote Hermit package installation

## User flow

Open the kernel page and click **Pull latest** in the Hermit row.
The server downloads and verifies the latest published package, then replaces the current installable package.
The row refreshes after success.
The action shows a loading state and disables concurrent upload or pull actions in that row.
Download or validation errors appear as notifications.

Use the existing VM kernel installation actions to install that package into selected VMs.
Pulling a package does not change VM configuration, credentials, or running processes.

## API

`POST /api/panel/kernel-packages/pull` requires an administrator session or master API key.
Send an empty JSON object or an empty body.
The endpoint rejects request-supplied URLs and other arguments.
It returns the existing package-installer result in the normal panel envelope.

The operation shares `serializeKernelChange` with uploads and VM kernel changes.
Repeated pulls use the existing installer's idempotency and shared CLI cache.
Referenced deployed package files retain the existing preservation behavior.

## Download and verification

The default release origin is `https://hermit-releases.truerouter.cc`.
Operators can override it with `KIN_HERMIT_RELEASES_URL`.
The configured origin must use HTTPS without credentials, a path, a query, or a fragment.
HTTP loopback is accepted only when the existing `KIN_KERNEL_TEST_ENDPOINTS=1` test switch is enabled.

The server performs these steps:

1. Fetch one `/v1/releases/latest` snapshot.
2. Validate the schema, version, Linux amd64 target, commit, digests, archive size, and exact version-specific URLs.
3. Fetch the fixed version's `release.json` and verify its SHA-256 against the discovery response.
4. Check that the receipt matches the selected version, platform, archive identity, and manifest digest.
5. Download the fixed version's archive. Enforce its declared size and verify its SHA-256.
6. Pass the verified bytes and receipt to `installKernelPackage`.
7. Let the existing Python installer verify the manifest, safe file set, payload hashes, executable format, and shared CLI dependency before publishing the current pointer.

The server does not use a mutable latest-download URL after discovery.
Redirects are rejected.
Panel credentials are not forwarded to the release origin.
Metadata is limited to 64 KiB per response.
Archive bytes are limited to the receipt's size and the existing 64 MiB package limit.
Metadata requests have a 15-second timeout. The archive request has a 120-second timeout, including body transfer.
Requests use `User-Agent: vm2api-hermit-installer/1.0`.

## Acceptance recorded on 2026-11-12

| Scope | Result |
| --- | --- |
| Real gateway, local HTTP origin, real Python installer and filesystem | PASS, 43 checks |
| Existing single-package replacement and deployed-file preservation regression | PASS |
| Built frontend through ego-browser | PASS, 18 checks |
| Published 0.1.0 package from the real HTTPS Worker into an isolated gateway | PASS |
| Production frontend build | PASS |
| Production deployment, real VM activation and model-provider requests | NOT RUN |

The live check reused the genuine Linux CLI cache after verifying its recorded size and SHA-256.
It did not execute that Linux CLI on the macOS test host.
The local HTTP check exercised fresh shared-CLI download and reuse with a synthetic executable.

The HTTP check rejects non-admin access, request URL overrides, unsafe URLs, redirects, wrong targets, oversized metadata, receipt mismatch, manifest mismatch, corrupt or truncated archives, excess streamed bytes, invalid packages, and unavailable releases.
It verifies that failures preserve the current package and VM record.
The browser check covers pull errors, loading state, upload exclusion, row refresh, existing manual uploads, narrow-screen layout, and the shared VM installer contract.

Evidence is under `.tmp/hermit-remote-install-20261112/`:

- `http/`: checks, remote request paths and current-package result.
- `browser-final/`: checks, browser log, screenshots and captured installation requests.
- `live/`: real selected release, installation result and current-package result.
- `verification.json`: source hashes, commands and validation boundaries.

## Reproduce

Use Node.js 22.23.4 and the existing project dependencies.

```sh
node --test test/e2e/hermit-remote-install.e2e.test.mjs \
  test/e2e/hermit-single-package.e2e.test.mjs
pnpm -C web build
node --test test/e2e/hermit-kernel-page.e2e.test.mjs
```

The browser experiment requires an available ego-browser connection.
The following opt-in check uses the public Worker and an existing genuine pinned Linux CLI cache:

```sh
HERMIT_REMOTE_LIVE_CLI=/ABSOLUTE/PATH/PINNED-LINUX-CLAUDE \
  node --test test/e2e/hermit-remote-live.e2e.test.mjs
```
