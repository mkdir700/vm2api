# Managed egress operations

## Deployment identity

Run these operations on the intended Linux slot host and Compose project.
The control plane and sing-box must use host networking. The control plane must
mount its data directory read-write. Sing-box must mount the matching
`managed-egress` directory read-only.

The Compose file pins the official sing-box 1.12.0 image by multi-architecture
digest. The initializer creates an empty checked configuration without replacing
an existing configuration. The API does not depend on sing-box readiness.
The image and release must include the current `kin-egress` source build.
Older helpers without the private drain protocol cannot support managed updates.

Controlled local Linux slot startup, independent remote factory/lifecycle,
archive/package restoration, native ARM64 image replacement, and native AMD64
CLI installation pass within their recorded scopes. Actual independent-host OS
reboot retains both selected slot routes after verified forwarding-rule repair.
Real provider/Claude requests and user visual acceptance remain unproven. Use the
[current acceptance audit](../design/implementation/0001-managed-egress-acceptance.md)
for the authoritative requirement table.

## Create and apply

1. Open the existing proxy import panel.
2. Select Hysteria 2.
3. As an administrator, select the intended host. Remote selection requires a connected Linux node.
4. Enter one `hy2://` or `hysteria2://` link and save it.
5. As an administrator, apply the managed egress configuration for the selected host.
6. Check configuration, runtime, and exit status separately.
7. Bind a slot on the selected exit host after the exit becomes ready.
8. Check that helper initialization and binding verification succeed.

Saving persists the desired configuration. Saving does not prove that sing-box
uses it. Listener ports and generated listener credentials are internal fields.
Remote import and configuration management are implemented. First apply can
provision an absent remote service. It does not start an existing stopped service
before draining. Managed binding initializes the helper on the selected slot host.
An initialization failure retains the binding and reports failure. Ordinary
requests remain blocked until runtime and helper verification succeed. Actual
local and remote factory startup, rebind, and stopped-VM archive restore pass in
the controlled Linux and independent-host E2Es.
If a binding response reports `binding_committed: true`, the mapping remains saved
even when helper initialization fails. Restore the required helper/runtime and
retry binding the same slot to the same exit. The retry checks the running applied
exit and complete configuration before initializing the helper. It does not apply
pending edits. Disabled exits, pending removal, and unmatched desired edits cannot
authorize this retry. Requests remain unavailable until verification succeeds.
Unsupported placement fails instead of using the control plane's loopback address.
Internal bindings preserve both the exit host and its listener reservation.
Control-plane operations use the SSH bridge. Remote helpers resolve the node-local
listener from the reservation. Do not copy a control-plane bridge URL into a remote
helper configuration.

## Update and remove

Edit the existing proxy record. A replacement link or partial protocol configuration
keeps its ID, assigned port, and listener credentials. Apply the desired changes.
The apply flow pauses new control-plane admission, waits for admitted work,
pauses transparent helper admission, and waits for live helper flows. It then
checks the shared runtime and its exits before restoring admission.

A long-lived TCP connection can exhaust the drain timeout. The update then fails
and preserves the current runtime. Complete or close the long-lived client work
before retrying. Do not stop the shared process to bypass draining.

Unbind a node before deleting it. Deletion first creates a pending-removal record.
Apply the configuration to remove its listener. Only verified application removes
the record and releases its port. Restart and failed apply retain the reservation.

## Recover an interrupted or failed apply

Recovery restarts the shared runtime. Use the administrator recovery action after
checking the host, Compose project, and intended active configuration.
The configuration check can run while an existing shared service is stopped.
It uses the same pinned image in a separate offline check container. The stopped
service starts only through the checked restart after request draining.

1. Check that the sing-box service and every bound helper exist on the intended host.
2. Open the existing Hysteria 2 import panel and select **Recover runtime configuration**.
3. Wait for the request and transparent-flow drain to finish.
4. Check that the runtime and required exits become available.
5. Review pending changes. Recovery can restore an earlier configuration without
   applying newer desired edits or pending removals.
6. Apply pending changes when their configuration is ready for verification.

The equivalent administrator endpoint is `POST /api/panel/proxies/recover`.
The regular apply endpoint is `POST /api/panel/proxies/apply`. Reuse the existing
panel authentication mechanism. Both endpoints accept `host_id`; omission selects
`control-plane`. Remote import also accepts `host_id` and requires administrator
authorization. The host selector applies the same field to all three operations.
Do not change the selected host to work around an unavailable node.

Do not put session cookies, API keys, or node
links into command-line arguments, logs, or acceptance receipts.

A failed rollback keeps affected helpers paused. A missing, ambiguous, paused,
replaced, or incompatible helper blocks readiness. Recovery does not silently
select another node or a direct route. A failed recovery remains unavailable.

For a missing local helper, health reconciliation can rebuild it after verifying
the running shared service, the applied file, the selected exit, and the desired
row match. Ordinary requests remain blocked until the rebuilt helper passes its
control check. This repair preserves the slot binding and does not restart
sing-box. It does not replace live paused helpers, repair disabled exits, or
authorize unverified desired changes. It does not bootstrap a remote helper.

If the local shared service and a previously recorded bound helper are both gone,
explicit recovery can first prove helper absence. It checks the persisted PID,
private control listener, and all configured TCP/UDP data ports. It reserves the
data ports while restoring the shared runtime, then rebuilds and verifies the
helper. Readiness stays revoked until verification. Pending edits remain pending.
A live or reused PID, missing record, uncertain namespace, or occupied port stops
recovery. Do not kill an unknown process or remove an unknown listener to force
the proof to pass.

## Evidence

The implementation record is `docs/design/implementation/0001-managed-egress.md`.
The scoped native checks write sanitized receipts under `.tmp/managed-egress-e2e`.
Run the controlled suite with paths to the verified sing-box and compiled helper:

```sh
SING_BOX_BIN=/path/to/sing-box \
KIN_EGRESS_TEST_BIN=/path/to/kin-egress \
node --test test/e2e/managed-egress*.e2e.test.mjs
```

Use a helper built with the Go race detector for native acceptance. A missing binary
can skip a scoped check. A skip is not acceptance. Do not report this suite as proof
of Linux transparent slot traffic, real Claude forwarding, or user visual acceptance.

## Controlled Linux transparent-network acceptance

This acceptance entry point passed on Linux ARM64 in the user's existing Docker
Desktop environment. Its `linux-receipt.json` records actual observed sources
`127.0.0.2` and `127.0.0.3`, image/binary hashes, and applied versions. A skipped
run still writes NOT RUN evidence; it must not replace a passing run's meaning.

Use a disposable, authorized Linux Docker host. This test creates temporary
containers, bridge networks, helper processes, and firewall chains. Do not use
production credentials or an unrelated Docker context. Run the test as root on
the Docker host itself. Both the native helper and the daemon must share that host.

1. Build the current Linux `kin-egress` binary and obtain sing-box 1.12.0 for that host.
2. Provide the Docker CLI, Compose plugin, OpenSSH client, OpenSSH SFTP server, and Node dependencies. The fixture Dockerfile at `test/fixtures/managed-egress-linux.Dockerfile` supplies the runner tools.
3. Select an existing local slot image with `/bin/sh`, `sleep`, and `curl`.
4. Fetch and verify the manifest payload with `node scripts/fetch-payload.mjs --dest <payload-root>`. Cache the production `ghcr.io/dofastted/kin-os-ubuntu:24.04` AMD64 image. The test uses the real identity generator and kernel from this payload.
5. Select the host's non-loopback IPv4 address outside the temporary proxy subnets.
6. Run from the repository root:

```sh
MANAGED_EGRESS_LINUX_E2E=1 \
MANAGED_EGRESS_FULL_SLOT_PAYLOAD=<absolute-payload-root> \
MANAGED_EGRESS_SLOT_IMAGE=<existing-local-slot-image> \
MANAGED_EGRESS_ORIGIN_HOST=<host-IPv4> \
SING_BOX_BIN=/absolute/path/to/sing-box \
KIN_EGRESS_TEST_BIN=/absolute/path/to/kin-egress \
node --test test/e2e/managed-egress-linux.e2e.test.mjs
```

The test uses the pinned sing-box image and an existing slot image. It records
the slot image ID, binary hashes, configuration versions, actual observed source
addresses, and source hashes. The Docker mount-identity container is a fixture;
it does not run the gateway API. The two slot containers exercise production
network creation, iptables rules, real helpers, and controlled Hysteria upstreams.
The test covers in-flight drain, timeout preservation, isolated upstream failure,
shared-service failure, and checked recovery. It does not cover a complete remote
gateway slot lifecycle, host reboot, real Claude, or visual acceptance.
It also starts and restarts one actual local Ubuntu slot from an existing VM record,
checks its private kernel health socket, and verifies its transparent exit. The
start request can initialize a retained managed binding after helper setup failure.
The pinned identity generator creates its identity before startup. An ARM64 host
executes the AMD64 slot under emulation; the receipt records this distinction.
Kernel process health is not account or inference readiness. Local factory creation
and keep/traits rebuild also pass. Complete restore and full remote gateway VM
acceptance remain separate from the independent-host helper check.

## Create and rebuild a managed slot

The candidate's factory initializes an explicitly selected managed exit before
starting the slot. Automatic managed allocation uses the same initialization.
Managed creation and rebuild use the verified startup entry point, which saves
the local worker/kernel socket paths as well as runtime status. Keep-mode and
traits-mode rebuild retain the selected exit ID. A stopped Codex slot also needs
the actual transparent helper when its managed binding is verified.

If creation returns a VM together with `proxy_error`, the VM and committed binding
remain saved. Repair the helper/runtime, then retry binding or starting that same
VM. The retry must verify the applied exit and complete saved configuration. A
pending unmatched edit does not authorize initialization. A failed initialization
does not allocate another exit.

After partial database restoration, a saved managed VM snapshot still pins its
original exit ID. Startup refuses a missing or disabled original exit. Restore
and enable that original exit before retrying startup. Do not clear the saved
snapshot to trigger automatic allocation. The Linux E2E verifies this refusal
across gateway restarts and verifies kernel health and the original route after
recovery. Complete backup/package restoration remains unverified.

For a Docker Desktop host-network runner, keep the Docker-visible configuration
directory on a volume mounted at the same absolute path inside the runner. Keep
native helper data under a short local path: Unix socket paths must fit the kernel
limit. The test now creates its helper directory directly under `/tmp`.
For a long volume path, set `MANAGED_EGRESS_NODE_ROOT` to a short, nonexistent,
task-owned path visible at the same absolute location to the runner and Docker
daemon. The test creates that node root and removes it on completion.

The Linux check also kills its own helpers with SIGKILL and recovers them after
shared-service loss. A refused stale control socket can be reclaimed only when
its inode still matches. A duplicate helper must preserve a live control listener.

The check additionally exercises real SSH/SFTP/Compose provisioning, stopped-service
recovery, authenticated control-plane bridge requests, per-slot helper containers,
and helper drain over SSH Unix channels. The selected logical remote node shares
the same Docker daemon as the local fixture. Bindings use the production managed
pool operation and real remote helper initialization. The check rejects wrong-host
and quota violations, retains failed bindings, and resolves a controlled credential
POST through the authoritative SSH bridge. Database reload and SSH reconnect must
revoke stale readiness before verification restores admission. It does not establish
cluster enrollment, a separate physical host, the public HTTP binding workflow,
or full remote gateway VM credential execution.
The same traffic container also switches to the second managed exit and back.
The other slot retains its route. This covers the pool/helper rebind operation;
the public HTTP rebind workflow remains separately unverified.
Skipped native runs write `linux-not-run-receipt.json` and preserve the separate
real Linux `linux-receipt.json` result.

For shared-service bootstrap acceptance, run
`MANAGED_EGRESS_LINUX_E2E=1 node --test test/e2e/managed-egress-compose.e2e.test.mjs`
inside the controlled Linux runner whose fixture directory has the same absolute
path on the Docker daemon. The pinned image must already exist. This check uses
the production base and ARM64 Compose files in isolated projects. It starts only
the shared service and initializer. It checks empty startup, private permissions,
repeat initialization, and invalid-file preservation with startup refusal. The
result is `.tmp/managed-egress-e2e/compose-receipt.json`. Native skips write
`compose-not-run-receipt.json`. This is not full installer or upgrade acceptance.

### Linux runner path admission

Mount the selected named volume at its actual Docker `Mountpoint` in the runner.
Copy the verified payload and native binaries into that volume before running.
Use the same absolute paths for child Docker bind sources and the runner:
`<mount>/payload`, `<mount>/bin/kin-egress`, and `<mount>/bin/sing-box`.
The helper basename must start with `kin-egress` for process identity verification.
Set `TMPDIR` to the mounted volume. Set `MANAGED_EGRESS_NODE_ROOT` to a new child
such as `<short-mount>/node`; the test exclusively creates that directory.
Use a short separate owner-labeled volume for the SSH fixture so its private Unix
socket paths fit the kernel limit. Provide an isolated writable `src/config`
overlay for generated gateway configuration.

Before the Linux test, inspect the fixed `kin-eg-px-local` network. Remove it only
when both its attachment map and running/stopped-container reference query are
empty and its bridge matches the known controlled fixture. Keep unrelated Docker
containers and networks. Public remote and local Linux gateway tests must run
sequentially because they share this fixed local fixture name.

## Independent SSH host acceptance

Use only an explicitly selected Linux AMD64 test host. This entry requires root
Docker access, Compose, Python 3, `ss`, SFTP, and SSH Unix-socket forwarding. The
local OpenSSH alias must select a readable supported key and an existing trusted
Ed25519 host key. The test does not enroll an unknown host or ask for credentials.

Build the current Linux AMD64 helper from `worker/cmd/kin-egress`. Then run:

```sh
MANAGED_EGRESS_REMOTE_ALIAS=<authorized-test-alias> \
KIN_EGRESS_REMOTE_TEST_BIN=/absolute/path/to/current-linux-amd64-kin-egress \
node --test test/e2e/managed-egress-independent-host.e2e.test.mjs
```

The control process stays on the local checkout. The selected remote host runs
two controlled Hysteria upstreams, one separate sing-box project, and two actual
helper/traffic paths. The origin binds the host's private Docker bridge address.
The receipt is `.tmp/managed-egress-e2e/independent-host-receipt.json`. An absent
alias writes only `independent-host-not-run-receipt.json`.

The test checks the selected exits, control-plane credential POSTs through SSH,
shared-service recovery, SSH reconnection, and isolated upstream failure. Cleanup
requires matching labels or the test's unique helper/network identities. A marker
guards removal of the test directory. Every pre-existing container must retain
its ID, start time, running state, and restart count. This is an instance-state
preservation check, not functional acceptance for unrelated applications.

This check does not restart the existing gateway, deploy the candidate to
production, restart the host, or prove complete remote gateway VM startup. Keep
those operations and real Claude/visual acceptance separate.

## Public remote lifecycle acceptance

The separate public lifecycle check uses a temporary local gateway database and
the real ClusterManager HTTP routes. It requires an explicitly selected root SSH
alias whose home is `/root`. It refuses to run if `/root/.vm2api` already exists.
It marks that directory before using the production host discovery path. Never
delete an existing deployment to satisfy this prerequisite.

Provide the manifest-verified Linux AMD64 payload and the current helper:

```sh
MANAGED_EGRESS_PUBLIC_REMOTE_ALIAS=<authorized-test-alias> \
KIN_EGRESS_REMOTE_TEST_BIN=/absolute/path/to/current-linux-amd64-kin-egress \
MANAGED_EGRESS_FULL_SLOT_PAYLOAD=/absolute/path/to/verified-payload \
node --test test/e2e/managed-egress-public-remote.e2e.test.mjs
```

The check enrolls the host using its existing trusted SSH pin. It imports and
applies remote managed exits, builds the real remote slot payload image, and
checks public binding, startup, stop, rebind, and gateway restart. A real remote
kernel and transparent traffic provide the runtime evidence. The inference mock
does not supply the kernel response or the observed route. The receipt is
`.tmp/managed-egress-e2e/public-remote-receipt.json`. An absent explicit alias
writes `public-remote-not-run-receipt.json`. Read the actual receipt before
claiming acceptance. A documented command is not a passing result.

Run this check separately from the Linux gateway E2E, even when their remote
targets differ. A fresh gateway can bootstrap local fixed-name egress networks
on the control host; those names collide with the Linux fixture. Wait for the
gateway to terminate, then audit any empty fixture networks before removing them.
Never remove a network that contains another container.

Run this check separately from other tests on the same host. Cleanup verifies
the directory marker, container placement, helper/network labels, and unchanged
pre-existing container state. Image caches remain. The check does not reboot the
host. It verifies stopped-VM archive restore on the same installation; it does
not prove disaster restoration, provider requests, or visual acceptance.

## Image deployment bundle and upgrade acceptance

New control-plane images carry `image-deploy/docker-compose.yml` and the managed
initializer. The image label `vm2api.deployment-bundle=1` declares that contract.
The panel upgrade helper reads these files from the selected target image. It
validates the staged Compose manifest with the existing overlays before publishing
the initializer and manifest. Operator credentials, routing files, VM data, and
database state stay in place. The selected image tag still changes as requested.

A target without the bundle contract retains the existing deployment manifest.
A declared bundle with a missing required file fails before gateway replacement.
The helper adds a missing shared sing-box service, but does not recreate an
existing shared service during a gateway-only replacement.

An already running older release embeds its own older upgrade helper. Updating
this checkout cannot change that old helper retroactively. Use the current
`deploy/install.sh upgrade` transition to download the tagged deployment files
when moving those installations to the first managed-egress release. Verify the
published tag before using that command. This worktree is not a published release.

The image-upgrade E2E requires a Linux runner and Docker daemon that see the same
absolute fixture paths. Build the baseline production image from commit
`568d1a01e12eb1cb7a18cf8a58775b29e8c358d1`. Build the candidate from the reviewed
current source. Use the native control-plane Dockerfile for the test host's
architecture. Cache `registry:2.8.3`, `docker:27-cli`, the pinned sing-box image,
the production Ubuntu guest, and the manifest-verified Linux AMD64 payload.

```sh
MANAGED_EGRESS_IMAGE_UPGRADE_E2E=1 \
MANAGED_EGRESS_BASELINE_IMAGE=<baseline-production-image> \
MANAGED_EGRESS_CANDIDATE_IMAGE=<candidate-production-image> \
MANAGED_EGRESS_FULL_SLOT_PAYLOAD=/absolute/path/to/verified-payload \
node --test test/e2e/managed-egress-image-upgrade.e2e.test.mjs
```

The test uses an isolated loopback registry, real Compose operations, and real
control-plane images. It preserves an external SOCKS exit ID and an actual Ubuntu
VM binding across gateway replacement. It then verifies managed Hysteria traffic
from that upgraded VM. The artifact is
`.tmp/managed-egress-e2e/image-upgrade-receipt.json`; skips use a separate NOT RUN
receipt. The baseline and candidate intentionally share the checkout's VERSION.
This proves an image and deployment-file transition, not a published release
upgrade or full installer execution. No production service or host is restarted.

## Full CLI and native AMD64 acceptance

Run this check only with an isolated native Linux AMD64 Docker daemon. It creates
the default `vm2api` container and uses the production host-network contract. Do
not point it at a shared production daemon. The test runner and daemon must see
the same absolute fixture paths. Provide Node 22, bash, real curl, git, OpenSSL,
Docker CLI/Compose, and the candidate's Node dependencies. The fixture Dockerfile
`test/fixtures/managed-egress-cli.Dockerfile` extends the real AMD64 production
image with those test tools.

```sh
MANAGED_EGRESS_INSTALLER_E2E=1 \
MANAGED_EGRESS_SOURCE_REVISION=<checkout-commit> \
MANAGED_EGRESS_CANDIDATE_IMAGE=<native-amd64-production-image> \
node --test test/e2e/managed-egress-installer.e2e.test.mjs
```

The test calls the actual installer with `install --version <tag> --yes`, then
the actual same-version `upgrade` dispatch. It does not use `--no-start` or skip
the installer fleet refresh/wrap sync. Only tagged release-file/API transport is
redirected to exact source bytes. A private registry serves the real candidate
and cached Ubuntu guest. Non-secret mirror inputs are preconfigured in `.env`;
the installer generates and protects its own API/database credentials. No real
account, SSH key, or provider credential is mounted into the test.

Required evidence includes an empty initial fleet, checked empty shared service,
authenticated API/anonymous refusal, actual native factory identity, actual kernel
HTTP 200, selected transparent exit, preserved state after CLI alignment, and
installed-service failure/recovery. `installer-receipt.json` records that result.
The absent environment gate writes only `installer-not-run-receipt.json`.

On primaryserver the check ran inside an owner-marked `docker:27.5.1-dind` instance
with no published ports and only its private Unix socket. Inner host networking
stayed inside that test container's network namespace. The linked
`installer-host-receipt.json` records the reproduction command, runtime receipt
hash, unchanged pre-existing outer container snapshots, and verified cleanup.
This does not prove whole-host reboot, global ARM64 binfmt preparation, a published
release upgrade, provider requests, real Claude, or visual acceptance.


## Restore a stopped fleet from a local archive

The verified scope is stopped local and remote VMs on the same installation.
The independent primaryserver check also verifies reconnected SSH links, restored
actual kernel health, and the original exit after explicit apply. Package
import/export and disaster restoration are separate gates.

1. Stop the affected VMs before restoring the archive.
2. Restore the selected archive through the panel backup endpoint.
3. Wait for restoration to finish. Mutating panel requests return HTTP 503 while
   restoration replaces database holders and cluster connections.
4. Inspect the restored exit IDs and VM bindings.
5. Apply the restored managed configuration explicitly if the existing runtime
   differs. A mismatched runtime must refuse startup with HTTP 409.
6. Start the original VM. Verify actual kernel health and the selected exit.

Do not replace a missing or disabled archived exit with automatic allocation.
Restore the original exit and apply it before retrying startup. The passing Linux
archive E2E records these same-installation checks in `linux-receipt.json`.


## Import a managed VM package

A managed package references an existing exit by ID and host ID. It does not
contain an internal SOCKS address or managed listener credentials.

1. Confirm that the original exit exists on the intended host.
2. Apply its configuration and verify readiness.
3. Check ownership and the remaining binding quota.
4. Import the package or write it back to a compatible local VM.
5. Verify kernel health and the selected exit after startup.

An absent, disabled, dead, unready, wrong-host, or forbidden exit is refused
before VM and credential files are replaced. Do not convert its reference into
an external SOCKS address to bypass refusal. A package does not create a host
service or choose another exit automatically. Existing remote VM package
write-back remains unsupported. Restore the matching exit ledger before using
a package on another installation.

The Linux E2E verifies automatic package creation and existing-VM write-back with
actual kernels and the original route. Display-name changes retain the deployed
runtime UID. The HTTP E2E also verifies that rejected replacements preserve VM
and credential bytes, and that external SOCKS/local package write-back still
works. UI source passes TypeScript checking; visual acceptance remains separate.


## Repeat the remote factory and native CLI checks

Run the public remote factory E2E from a Linux control runner with the
manifest-verified computer payload. An ARM64 runner can use the existing AMD64
emulation and pinned runtime libraries. Mount only the selected SSH identity
read-only, use its existing trusted host key, and supply an explicit alias
configuration. The E2E now creates the VM through the public API. It verifies
minted identity, automatic kernel startup, both routes, archive restoration and
gateway restart. Native macOS execution skips this factory gate explicitly.

A pending auto-starting creation remains stopped. Successful boot publishes
running. This prevents the watchdog from reviving the same VM during initial
remote preparation. The remote E2E keeps the real watchdog enabled with a
five-second interval.

For the native AMD64 installer test, start the official pinned DinD image in its
private cgroup namespace with bounded resources and the official entrypoint.
Pass `dockerd --host=unix:///var/run/docker.sock --tls=false` explicitly. The
official wrapper prepares nested cgroup v2 controllers. Keep the Docker API on
the private Unix socket and publish no ports. Use the inner daemon for the
installer runner, candidate images, Compose services and test guest. Bind the
marked task directory at the same `/me` path in that daemon and runner.

Run `test/e2e/managed-egress-installer.e2e.test.mjs` with its explicit native
acceptance environment. Preserve the sanitized receipt and log. Before teardown,
verify the task marker, daemon ID/labels/mounts, terminal successful runner and
zero running inner containers. Remove only that daemon and marked directory.
Compare the original outer instance ID/name/start/running/restart snapshot after
cleanup. The current test passes in 110 seconds; its host receipt records equal
canonical before/after hashes for all nine existing instances. This verifies an
isolated native installation, not whole-host reboot or production publication.

## Whole-host reboot acceptance

Warning: `primaryserver` currently runs nine original containers. A host reboot
interrupts all nine. An isolated Docker daemon restart does not prove an OS
reboot. Keep the explicit reboot opt-in separate from normal container checks.

The read-only preflight on 2026-11-06 found Linux x86_64, about 6.6 GiB available
memory, 106 GiB available root storage, no `/dev/kvm`, and no installed QEMU.
The previous marked CLI fixture directory is absent. Original running names:
`kin-01`, `vm2api`, `1Panel-openresty-FqZQ`, `uc-pr343-ts-engine-a`,
`uc-pr343-ts-engine-b`, `uc-pr343-ts-engine-c`, `uc-pr343-ts-a`,
`uc-pr343-ts-b`, and `uc-pr343-ts-c`. Revalidate this list before scheduling.

The reviewable procedure is:

1. Obtain explicit approval for the interruption window on this shared host.
   Record and verify the authorized SSH alias before issuing reboot.
2. Capture the Linux boot ID and original container identity/running/restart-policy
   snapshot. Refuse if workload or ownership differs from the approved scope.
3. Create a uniquely marked controlled fixture using the accepted native image
   and pinned shared service. Keep its ports, Compose project, networks and data
   separate from existing applications. Do not replace the production gateway.
4. Create two exits and two slots through production APIs. Verify actual kernel
   health and each selected route before reboot. Store only exit/host IDs, binding
   IDs, stable port allocations, version/configuration hashes, image identities
   and sanitized observed exits. Keep credentials only in the marked runtime.
5. Reboot the authorized host once. Observe SSH loss and reconnection using the
   existing trusted host key. A timeout is not proof of a reboot or permission to
   issue another reboot.
6. Require a different Linux boot ID. Inspect fixture service/container startup,
   saved bindings and reservations before running recovery. Record any failure.
7. Verify actual slot kernel health and both selected exit routes. If explicit
   checked recovery is required, report that fact separately from automatic boot
   recovery. Never substitute another exit or a direct route.
8. Inspect every original application's container state. Report a failed original
   application before any fixture cleanup. Do not modify that application's
   restart policy or data to make the fixture pass.
9. Copy a sanitized pre/post receipt. Stop only owned fixture resources after
   checking markers, container IDs, mounts and labels. Preserve shared caches.

The user approved interruption. Three single-reboot acceptance attempts ran:
the first lost temporary fixture files, the second exposed missing forwarding
rules, and the final corrected run passes in 672 seconds. The final Linux boot
ID changes from `da291763-6ec9-498f-acb4-5680499c06ce` to
`632fabaf-a01a-4c0e-b3a5-8fb485e5c9da`. Both actual slot kernels, saved mapping
intent, shared config hash and the two selected routes pass without explicit
fixture start or managed apply after boot.

Nine original containers retain IDs/names/policies and run after boot. Six with
policy `no` require manual startup, with namespace containers before engines.
Keep this original-application recovery separate from automatic managed recovery.
The E2E stores fixtures in a marked persistent
`/root/.vm2api-reboot-fixture-<nonce>` directory and preserves the primary failure
when cleanup also fails. `host-reboot-receipt.json` is the passing managed-route
proof; earlier OS-only and failed-attempt receipts retain their limited verdicts.
All remote fixtures and local controllers/volumes/alias scratch are removed.

To repeat the corrected controlled reboot check, use the Linux controller setup
from the public remote section and add the explicit authorized alias:

```sh
MANAGED_EGRESS_PUBLIC_REMOTE_ALIAS=primaryserver \
MANAGED_EGRESS_HOST_REBOOT_ALIAS=primaryserver \
KIN_EGRESS_REMOTE_TEST_BIN=/absolute/path/to/current-linux-amd64-kin-egress \
MANAGED_EGRESS_FULL_SLOT_PAYLOAD=/absolute/path/to/verified-payload \
node --test test/e2e/managed-egress-public-remote.e2e.test.mjs
```

Warning: this opt-in command reboots the named physical host once after both real
slots pass their pre-reboot routes. Run it only within the authorized interruption
scope. A missing/mismatched reboot alias cannot authorize a different host. The
controller, its selected read-only key and its gateway database must remain on a
different host throughout the reboot. Use an isolated writable `src/config`
overlay because gateway startup writes its generated public configuration.
For image-upgrade acceptance, run from a source path shared at the same absolute
location in the Docker backend; child containers bind the real upgrade script.
Persist upstream origin/config/certificate fixtures under their marked `/root`
directory. Resume only originally running containers, with namespace dependencies
first, and report manual resumes separately from automatic managed recovery.

## Lost remote forwarding rules

A Docker-restarted helper and a healthy slot kernel do not prove transparent
forwarding after an OS reboot. Host firewall rules are ephemeral. Managed remote
inspection now checks the bound slot's canonical labeled bridge, redirects,
INPUT allowances and fail-closed FORWARD rule as well as the private helper
control socket. Missing rules make the exit unavailable.

The existing maintenance path may restore those rules only after the running
applied configuration matches the selected exit. It uses the existing per-slot
iptables plan and refuses unknown/mismatched bridge ownership. It does not change
the selected exit, apply pending node edits, or restart the shared service/helper.
Verify actual slot traffic after repair; a successful listener probe is insufficient.
The independent-host E2E covers loss of one owned NAT chain and preservation of
both routes without rebooting unrelated applications.

## Dedicated real request acceptance

Use a dedicated test account and user-selected secure credential source. Do not
scan unrelated account stores or put tokens in chat, commands, logs or receipts.
Record real exchange, refresh and Claude inference separately. For each request,
correlate a non-secret request identifier with the selected host/exit and an
upstream-side route observation. A successful response alone is insufficient.
Preserve only timestamp, source/image identity, selected exit, observed exit,
status, and a hash of sanitized evidence. No real-provider result exists yet.

## User visual acceptance

Use the current candidate identified in the acceptance audit. Record the actual
image identity before starting. The user owns visual execution; the agent must
not launch a browser, application or VM for this checklist without separate
visual authorization.

1. Open the existing proxy list. Add a dedicated Hysteria 2 link and select its
   intended host. Verify that the public row hides listener ports and credentials.
2. Save without applying. Verify that desired, runtime and exit states remain
   distinct. Apply and inspect the observed exit address.
3. Create a slot using that exit. Confirm that the exit name identifies the
   selection and the successful runtime retains the same host/exit.
4. Edit and rebind using existing views. Verify pending/failed application states
   and refusal to delete a bound exit. Repeat with a restricted user to verify
   ownership and redacted choices.
5. Record source/image identity, user-observed result and non-secret discrepancies.
   Keep this record separate from controlled and real-Claude receipts.

No user visual result has been recorded.
