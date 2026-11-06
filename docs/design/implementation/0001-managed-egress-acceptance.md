# Managed egress acceptance audit

## Verdict

ADR 0001 is **not achieved**. Controlled local and independent remote network
acceptance passes. Real provider/Claude traffic and user visual acceptance are not proven. Actual
independent-host OS reboot and managed mapping recovery now pass. Do not substitute process health, container
restart, or controlled HTTP for those evidence classes.

This audit supersedes the historical checkpoint statements in the implementation
journal. Audit date: 2026-11-06. Checkout: `main` at
`568d1a01e12eb1cb7a18cf8a58775b29e8c358d1`, with uncommitted implementation.
No commit, production deployment, published release, or visual session is implied.

`Verified` refers to the precise evidence scope in each row. `Partial` requires
additional evidence. `NOT RUN` is not success. Native real-process lifecycle
checks and real Docker checks have separate boundaries.

## Whole-host reboot and remote routing checkpoint

The complete public remote factory/archive/reboot E2E passes in 672 seconds.
Linux boot ID changed from `da291763-6ec9-498f-acb4-5680499c06ce` to
`632fabaf-a01a-4c0e-b3a5-8fb485e5c9da`. Both real private kernels return HTTP 200;
saved exit/host/listener intent and the shared configuration hash are unchanged;
the two real slots retain observed exits `127.0.0.3` and `127.0.0.2` respectively.
No explicit fixture start or managed apply is issued after boot.

The preceding persistent-fixture attempt proved a real defect: Docker restarted
healthy helpers and kernels, but host iptables rules disappeared. Socket-only
helper readiness incorrectly admitted those slots. A minimized real-host E2E
flushes just one owned KEG chain. It failed before the correction and passes in
186 seconds after it. Remote inspection now verifies owned-network forwarding
rules. The existing applied-config maintenance gate restores missing rules with
the existing per-slot plan. It does not apply pending edits or restart the shared
service/helper. The complete OS reboot rerun proves the original symptom fixed.

Three single-reboot attempts ran under the user's interruption authorization.
The first was inconclusive because temporary upstream files disappeared. The
second preserved fixtures and exposed the forwarding defect. The third passes
with marked persistent fixtures and the production correction. Failed receipts
remain failures and cannot replace the final passing result.

All nine original container IDs, names and restart policies are preserved and all
nine run after reboot. Three resume automatically. Six policy=`no` containers are
started explicitly in network-namespace dependency order. Container-running state
is not unrelated application health. The controller and all remote fixture
services/slots/helpers/root are removed. All local controllers, four owner-labeled regression volumes and public SSH alias
scratch files are removed. The isolated CLI daemon and marked host directory are
also removed. The original host system reports `running`.

`host-reboot-receipt.json` records actual reboot/mapping/route acceptance.
`host-reboot-recovery-receipt.json` records the earlier OS/container-only recovery.
`host-reboot-attempt-receipt.json` and `host-reboot-routing-red-receipt.json` retain
the failed boundaries. The corrected SSH command-contract case passes in 7.6
seconds. It supplies canonical bridge/UID facts but does not simulate real Linux
firewall proof; the independent-host and reboot E2Es supply that proof.

All affected checks are refreshed: local Linux PASS in 238 seconds, native ARM64
image transition PASS in 65 seconds, native AMD64 full CLI PASS in 110 seconds, and
the complete native suite has seven passes, zero failures/cancellations and six
explicit environment skips. Fourteen runtime receipts contain 217 matching
source-hash entries; all three host-receipt links match.

## Current evidence and provenance

Fourteen runtime receipts under `.tmp/managed-egress-e2e/` contain 217 recorded
source-file hash entries. Every recorded input matches the current worktree.
This inventory verifies recorded inputs, not every
transitive dependency or complete ADR coverage. Two additional host receipts link
runtime results to isolation and cleanup. The audit checks the installer link and
both public-remote and host-reboot links.

| ID | Receipt | Runtime boundary |
| --- | --- | --- |
| N | `receipt.json` | Native Darwin ARM64, actual sing-box 1.12.0 Hysteria servers/client, SQLite, production pool/lifecycle modules; no Docker slot |
| A | `api-receipt.json` | Actual authenticated gateway HTTP/SQLite, no upstream or slot traffic |
| D | `admission-receipt.json` | Actual Unix HTTP transport and controlled worker; no provider |
| P | `probe-receipt.json` | Actual TCP SOCKS handshake and controlled probe |
| H | `helper-receipt.json` | Compiled race-enabled helper, actual SOCKS/DoH/DNS and private drain protocol |
| R | `remote-endpoint-receipt.json` | Actual SSH/SFTP/helper/SOCKS over loopback; Docker command fixtures are explicitly limited |
| K | `package-receipt.json` | Actual gateway HTTP/SQLite package preflight and rejected-write preservation |
| L | `linux-receipt.json` | Linux ARM64 Docker, actual Ubuntu AMD64 slots under existing emulation, real kernel/transparent routes, SSH logical host, package/archive restore; 42 source entries |
| C | `compose-receipt.json` | Actual base and ARM64 Compose empty shared-service bootstrap |
| I | `independent-host-receipt.json` | Actual primaryserver Linux AMD64 SSH/SFTP/Compose/helper and control-plane credential POST; 18 source entries |
| F | `public-remote-receipt.json` | Linux ARM64 controller to primaryserver; actual public enrollment, factory identity, remote Ubuntu kernel/routes, archive restore, gateway restart; 27 source entries |
| B | `host-reboot-receipt.json` | Actual independent Linux AMD64 OS reboot; two actual kernels/routes, stable mapping/config and automatic verified rule recovery; 27 source entries |
| U | `image-upgrade-receipt.json` | Native ARM64 production-image replacement from pinned source baseline, actual retained binding/traffic; 16 source entries |
| T | `installer-receipt.json` | Full CLI install/alignment in private native AMD64 Docker daemon, actual factory/kernel/route; 21 source entries |

The latest complete native suite has seven passing checks, zero failures and six explicit
environment skips. L passes in 238 seconds, F/B in 672 seconds, U in 65 seconds,
and T in 110 seconds. The extended native lifecycle E2E now also passes in 20
seconds: a distinct edit submitted during held-request drain waits, stays pending
after the first apply, fails safely with rollback, and applies after correction
without changing listener identity. Production files did not change for this
coverage addition. Environment skips use separate `*-not-run-receipt.json`
paths and do not replace real Docker PASS receipts.

The ARM64 candidate image ID is
`sha256:b93f88524f815539e4ca5e8155c7ae2e0cc58d7c46b26ce0bf37413842589cf3`.
The AMD64 source manifest is
`sha256:17cb6f207bc523388ac3a8b41d470ba62d60762dea75e5b33969f69eb36b592a`.
The native daemon loaded its classic image configuration as
`sha256:edd5f3a24024347725a53c206c87fe0c79c3b6e591ebe21b6a1f522bd582798e`.
Manifest digests and configuration IDs identify different image-store objects.
The installed image's seven checked critical source files match the worktree.

The official shared-service image is
`ghcr.io/sagernet/sing-box:v1.12.0@sha256:3c1ee82d450df9b336b6f63b1d272cf86e3835392d99596ef8c35f206a457999`.

`remote-factory-host-receipt.json` records an unprivileged controller, a read-only
selected SSH key mount, trusted host key, preserved original host instances and
controller/alias/volume cleanup. No private key was copied to primaryserver.
`installer-host-receipt.json` records official DinD initialization, private cgroup
namespace, Unix-only Docker API, bridge isolation, bounded resources, no published
ports, six actual-image file hashes, preserved original instance snapshots, and
marked-directory/daemon cleanup. During the isolated CLI run, all nine original instances retain their ID,
name, start time, running state and restart count. Actual OS reboot changes start
times as described in the reboot checkpoint.

## Requirement-by-requirement audit

The rows follow the ADR decisions and numbered execution plan. Source locations
identify implementations; the receipt column identifies runtime proof. A source
location alone is not functional acceptance.

| Requirement | Current evidence | Result and boundary |
| --- | --- | --- |
| Record failure modes before isolated implementation | Implementation journal and planning findings contain configuration, drain, rollback, identity, deployment and factory failure scenarios | Verified documentary sequence; no unit tests added |
| Extend existing proxy pool and binding model | `proxy-pool.mjs`, `proxy-resolve.mjs`, typed managed configuration; A/L/F | Verified: ID/host references, existing pool and binding APIs |
| Separate protocol conversion, host lifecycle, resolution and helper | Dedicated `managed-egress-*` modules and unchanged transparent-helper role | Verified source structure; no general plugin/config framework |
| Support existing external SOCKS, local, and managed Hysteria 2 | N/K/L/U/T | Verified within controlled package, retained external-slot traffic and managed-slot scopes; not every historical regression suite |
| One shared service per supported host; never one per slot | C/I/F/U/T; F compares shared container ID before and after factory creation | Verified on local and independent remote hosts |
| Official pinned image supports target architectures | C/U on ARM64; I/F/T on AMD64 | Verified actual native shared/control runtimes; AMD64 guests on local ARM64 remain emulated |
| Linux host networking and loopback authenticated listeners | C/I/L; production Compose and remote generated Compose | Verified real runtime and authenticated traffic |
| Writable controller directory; read-only directory mount for service | C/I/U/T and remote runtime inspection | Verified configuration replacement uses a directory mount |
| No sing-box TUN, privilege, or Docker socket | Compose declarations, I/L runtime inspection and R rejection fixtures | Verified shared-service scope; privileged DinD is isolated test infrastructure |
| Checked empty initial config and acyclic startup | C/T; `init-managed-egress.sh` | Verified empty installation, repeated initialization, invalid-file preservation/refusal |
| Management API survives absent/stopped shared service | A/T | Verified authenticated API survives while managed traffic fails |
| Install, upgrade, development overrides and ARM64 path updated | Base/ARM64 Compose, Dockerfiles, release bundle, `install.sh`, `panel-upgrade.sh`; C/U/T | Verified empty native AMD64 CLI install and same-version alignment, native ARM64 source-baseline image replacement, operator overlay retention; global ARM64 host preparation not run |
| Existing IDs and bindings survive migration/upgrade | N/U/T | Verified actual SQLite reopen/migration and retained image/CLI state |
| Encrypt protocol settings and credentials | N plus existing encryption rules | Verified encrypted database fields, reopening, wrong-key refusal without row loss |
| Stable per-host ports in bounded range; conflict checks | N/A/R/I/L; database uniqueness | Verified stable reservations, duplicate/occupied port refusal and concurrent import allocation |
| Host plus exit ID defines placement; no control loopback on remote node | R/I/L/F | Verified remote helper node-local endpoint and control-plane SSH bridge; stale/arbitrary overrides refused |
| Explicit inbound-to-outbound mapping; no direct or alternate fallback | N/I/L/T | Verified two routes and failures of upstream/shared service without alternate selection |
| Desired and applied versions are separate | N/L/F/T | Verified mismatch refusal, checked apply and persisted version hashes |
| Display application, runtime and observed exit states separately | A/N plus existing proxy UI source | API verified; UI source/type check only; visual NOT RUN |
| Generate candidate and check with matching sing-box version | N/C/I/L | Verified actual native and pinned-image check commands |
| Serialize host updates | N/R; host queues | Verified overlapping applies and drain exclusivity; the new held-request E2E also queues a distinct edit during apply |
| Identify affected slots, pause admission and drain before restart | D/H/N/L; control-plane body and helper flow leases | Verified real held response bodies, DNS/TCP flows and actual Docker transparent traffic |
| Drain timeout preserves current file/process and request | N/H/L | Verified no restart, unchanged active configuration and live request completion |
| Apply config with validated mechanism | N/I/L/U/T | Verified checked replacement plus explicit restart; no assumed arbitrary hot reload |
| Verify process/listeners/routes before applied-version commit | N/I/L/F/T | Verified actual selected route and kernel readiness where applicable |
| Failed apply restores prior config | N/R | Verified real Hysteria process and SSH lifecycle; container fault-injection rollback is not claimed |
| Failed rollback blocks new work until recovery | N/R/D | Verified native/SSH/helper failure state and admission; no claim of whole-host disaster recovery |
| Removal checks ownership/binding and delays port release | A/N/K | Verified bound/cross-owner refusal and verified listener removal before reservation release |
| Logs/API/receipts omit secrets | A/K plus field-by-field receipt inspection | Verified controlled fixtures and public summaries; no universal absence claim for unrelated logs |
| Existing UI protocol fields, links, status, edit, delete and binding | A/N/L/F, `web/src/features/proxies` and VM views; TypeScript check | APIs/runtime verified; user visual acceptance NOT RUN |
| Startup requires ready selected exit on actual target host | L/F/T | Verified wrong-host, missing, disabled, unready and failed-helper refusal with retained binding |
| Failed factory creation retains correct lifecycle state | F | Verified actual pinned computer identity, pending `stopped`, five-second watchdog, successful boot commits `running` |
| All proxy callers use host-aware resolution | R/I/L and caller source in OAuth/transport/geo/probe | Controlled credential POST, probe/geo, worker admission and transparent route verified; real exchange/refresh/Claude NOT RUN |
| Cluster deploys service via existing SSH/SFTP/Compose channel | I/F | Verified real public enrollment, discovery, image build, first apply and remote factory |
| Unsupported remote placement refuses instead of falling back | A/R/K/L | Verified unknown host, wrong host, missing bridge and stale SSH endpoint refusal |
| Two controlled nodes and two complete local slots use selected exits | L | Verified actual separate kernel health and observed routes `127.0.0.2` / `127.0.0.3` |
| Edit/rebind/service restart retain expected mappings | N/I/L/F/U/T | Verified local rebuild and remote rebind/gateway restart; another slot retains its route |
| Whole-host OS restart retains mappings | B/F: changed boot ID, unchanged mapping/config hash, actual kernel HTTP 200 and both selected routes after automatic verified rule restoration | Verified on the independent Linux AMD64 slot host; original policy=no applications resumed manually |
| Invalid config, wrong credentials, unavailable upstream preserve applied state | N/I/L | Verified real candidate rejection, wrong-upstream rollback and isolated node failure |
| Concurrent edits preserve applied state | N: held real Hysteria request, queued distinct bad edit, pending desired state, checked rollback, corrected apply | Verified native real-process scope; old route and stable listener preserved |
| Legacy ownership/quota/redaction/deletion restrictions remain | A/K/L | Verified real HTTP and retained files/mappings on rejection |
| Same-installation archive restore and managed package paths | K/L/F | Verified stopped local/remote archive restore, reconnect, explicit apply, real kernel/route; local managed package create/write-back |
| Minimal repeatable sanitized evidence | Fourteen runtime receipts, two linked host receipts with three links, commands below and operations guide | Verified recorded inputs and controlled results; aggregate audit does not create missing acceptance |
| Record controlled, real Claude and user visual separately | This audit and remaining gates below | Controlled PASS scoped above; real Claude NOT RUN; visual NOT RUN |
| Deployment/operations documentation | `docs/operations/managed-egress.md`, implementation journal, this audit | English follows the user's newer explicit document-language instruction |

## Remaining work and scope boundaries

1. Use a dedicated test account for real provider exchange/refresh and a real
   Claude request. Correlate each request with an upstream-side observation of its
   selected host/exit. Never use unrelated accounts or store credential bodies.
2. Ask the user to execute the UI checklist in the operations guide. Keep user
   observation separate from controlled network evidence. Start no browser,
   application or VM for visual acceptance without separate authorization.

The user selected `ssh primaryserver` for independent-host and reboot acceptance.
A fresh read-only check finds nine running original containers, no `/dev/kvm`,
and no installed QEMU. The prior isolated CLI root is absent. Rebooting this host
would interrupt those original services. Three authorized single-reboot acceptance attempts have now run, as recorded above. No hypervisor
installation was performed.

Published-release transport/publication, concurrent archive restoration, disaster
restoration, and remote package write-back are not explicit ADR completion gates.
Do not expand acceptance to require publication or change those unsupported paths
as a substitute for the remaining requirements. The controlled source-baseline
image upgrade and full CLI alignment prove their stated upgrade scopes. Global
ARM64 host preparation is unchanged legacy behavior and remains unverified;
managed-service changes are exercised on native ARM64. Record this limitation
without equating it to native AMD64 install or a full ARM64 host qualification.

Existing backup E2Es have three passes and two inference precondition failures.
A request before restore also returns HTTP 503 because that historical mock-only
harness lacks the mandatory Rust kernel. Do not call those assertions passing.
L/F provide actual-kernel managed archive evidence instead.

## Reproduce the controlled checks

Use the full setup and isolation steps in
[the operations guide](../../operations/managed-egress.md). Tests emit a separate
NOT RUN receipt when a required environment is absent.

```sh
KIN_EGRESS_TEST_BIN="$PWD/.tmp/managed-egress-helper/kin-egress" \
SING_BOX_BIN="$PWD/.tmp/sing-box/sing-box-1.12.0-darwin-arm64/sing-box" \
node --test test/e2e/managed-egress*.e2e.test.mjs
```

Run Linux checks only in their Linux fixture with manifest-verified payloads and
same-path Docker-visible mounts. Run remote factory acceptance with explicit
`MANAGED_EGRESS_PUBLIC_REMOTE_ALIAS=primaryserver`, the Linux AMD64 helper,
manifest-verified payload, trusted host key, and read-only selected identity.
Run full native installer acceptance with `MANAGED_EGRESS_INSTALLER_E2E=1` and
an explicitly identified current candidate image in the isolated native daemon.

Revalidate all recorded inputs before citing a receipt:

```sh
node scripts/verify-managed-egress-receipts.mjs
```

The generated
`completion-audit.json` records receipt hashes, source mismatches, linked receipt
checks, and remaining gates. It is an inventory artifact, not a functional test.
