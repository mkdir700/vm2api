# Unified Hermit installation verification

Date: 2026-11-09
Base revision: c36640c14f25d454af9313b2070383b304936ed4 (working-tree changes).

## Behavior

The available-kernel list contains cli-node, CRAG, and Hermit as peer rows.
The Hermit dialog manages packages only. It accepts a version archive and
release.json. The latest-download button remains disabled.

Each VM row offers cli-node, CRAG, and Hermit. Hermit requires an explicit
installed Linux amd64 version with production capabilities. The single-VM and
batch actions carry that version through the same confirmation and installation
endpoint: `POST /api/panel/kernels/install`.

The installer uses the existing transition journal when either kernel is Hermit.
It verifies the package, credentials, compatibility, proxy, and in-flight work
before replacement. Successful installation checks health, stops the container,
disables automatic restart, and removes the retained old container.
Failed installation uses the existing recovery workflow. Pending recovery controls
appear in the VM row. The VM detail page links to the unified kernel page.

## Repeat

Run from the vm2api repository. The browser check requires ego-browser.

```sh
pnpm -C web build
node --test test/e2e/hermit-packages.e2e.test.mjs
node --test test/e2e/hermit-kernel-page.e2e.test.mjs
```

Run the installer check on Linux with Node.js 22 and Python 3. The test simulates
the Docker, guest-kernel, and API-kernel health boundaries. The following command
uses the local immutable image that passed this check. It copies source into a
disposable container because the gateway writes a generated public configuration
into its source directory. It does not mount the host Docker socket.

```sh
mkdir -p .tmp/hermit-install-unified
docker run --rm --network none --entrypoint sh \
  -v "$PWD:/work:ro" \
  -v "$PWD/.tmp/hermit-install-unified:/evidence" \
  -e HERMIT_INSTALL_E2E_OUT=/evidence \
  sha256:b93f88524f815539e4ca5e8155c7ae2e0cc58d7c46b26ce0bf37413842589cf3 -c '
set -e
mkdir /tmp/repo
cp -R /work/src /work/scripts /work/test /tmp/repo/
ln -s /work/node_modules /tmp/repo/node_modules
cd /tmp/repo
node --test test/e2e/kernel-install-hermit.e2e.test.mjs
'
```

Set `HERMIT_E2E_OUT`, `HERMIT_PAGE_E2E_OUT`, or `HERMIT_INSTALL_E2E_OUT` to
select each test's evidence directory.

## Failure inventory

- Hermit is absent from the shared VM selector or install endpoint.
- A selected version is lost in single or batch installation.
- A mock-only or incompatible package reaches container replacement.
- Installation bypasses proxy, credentials, licensing, or lifecycle locks.
- Successful installation leaves a running container or automatic restart enabled.
- Candidate creation failure loses the prior binding, credentials, or stopped state.
- The package dialog still exposes an independent slot-switch action.

## Results

- Web build and scoped ESLint: PASS.
- Existing package API E2E: PASS.
- Browser E2E: PASS. The test uploaded synthetic packages, rejected selection of
  the mock-only version, checked the batch confirmation, and sent the selected
  Hermit version to the shared install endpoint. The local host preflight refused
  activation. The slot retained its active kernel, state, and credentials.
- Linux HTTP installer E2E: PASS, 25 checks. The test uses the existing passthrough compatibility profile. It replaced a running simulated
  native container, repeated installation into the stopped Hermit slot, confirmed
  stopped state and disabled restart, and preserved credentials. It also injected
  candidate creation failure and checked recovery. An invalid batch was rejected
  before any installation. A Hermit-to-native request reached package preflight
  through the shared endpoint.
- The upload dialog fit a 390-pixel viewport without horizontal overflow.
- Syntax checks and `git diff --check`: PASS. No unit tests were added or run.

Browser evidence: `.tmp/hermit-kernel-page-1794200531213/`.
Files include `checks.json`, `summary.json`, `install-requests.json`, `page.txt`,
`browser.log`, and desktop and mobile screenshots.

Installer evidence: `.tmp/hermit-install-unified/`.
Files include `checks.json`, `summary.json`, install responses,
`failed-install.json`, `docker-commands.jsonl`, and `source-sha256.json`.

## Boundaries

These checks used synthetic packages. Docker lifecycle operations, the guest
kernel, and API-kernel health were simulated in the Linux installer check.
The checks did not run a real Hermit binary, complete a real Hermit-to-native
replacement, or change a production slot. No deployment was performed.
