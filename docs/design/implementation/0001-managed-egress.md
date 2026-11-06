# Managed egress implementation record

## Current delivery state

The requirement-by-requirement audit is
[`0001-managed-egress-acceptance.md`](0001-managed-egress-acceptance.md).
It records incomplete behavior and evidence limits; it does not mark the ADR achieved.

Local managed-node creation, edit, verified removal, request admission, health
reconciliation, and joint host/helper drain are implemented. The shared host
lifecycle also supports the tested remote SFTP file store. The temporary
bound-slot apply refusal has been removed. Runtime apply requires compatible
private helper controls and fails closed when helper evidence is missing or
ambiguous. Bound-node removal remains forbidden.
Health reconciliation can rebuild a missing local helper after verifying the
applied runtime, matching desired row, and selected exit. It does not restart the
shared service or replace a live helper.
Explicit local recovery can now handle simultaneous loss of the shared service
and a previously recorded bound helper. It requires a dead persisted PID, an
absent control listener, and exclusive data-port reservations. Unknown processes
or occupied ports still block recovery. Native and Linux ARM64 container recovery
now pass. Host-restart acceptance remains incomplete.

Remote helper control now has a private SSH streamlocal transport. Managed remote
helper specifications use a separate writable control directory outside guest
mounts. Administrators can import nodes on connected Linux hosts. Remote slot
binding now requires a verified applied host and a current SSH bridge. The binding
operation serializes helper initialization and publishes readiness only after
checking the selected host and helper. Failed initialization retains the binding
and reports failure.

The pool lifecycle now selects a host explicitly. Inspection groups persisted
rows by host. Apply and recovery default to `control-plane` and accept a selected
host through the existing admin endpoints. A missing remote manager fails without
using the local manager.

The server now creates remote host managers lazily through the existing cluster
manager. Each remote manager combines SFTP storage, the pinned Docker runtime,
SSH endpoint bridges, and discovered per-slot helper controls. Lookup and health
inspection do not provision services. Remote apply provisions only an absent
service. Remote import and UI host selection are implemented. The remote helper
now resolves its node-local listener from stable placement metadata. Real SSH,
SFTP, Compose provisioning, remote helper containers, and drain now pass against
the controlled Linux daemon and the independent primaryserver host. Full remote
provider-specific caller admission remains incomplete. The public bind and allocate routes now
call the managed binding operation. Initial local HTTP binding and explicit retry
now pass with real helper traffic. A separate public independent-host check now
passes actual ClusterManager enrollment, remote image construction, seeded Ubuntu
VM binding/start/stop/rebind, actual kernel health, and gateway restart. It verifies
the two selected routes through the real remote VM. The latest Linux-controlled check also performs actual public remote factory
creation and stopped-VM archive restoration; see the current acceptance audit.

The latest Linux ARM64 acceptance uses two real Docker traffic containers,
production bridge/iptables code, real compiled helpers, two Hysteria upstreams,
and the pinned sing-box Docker image. Both observed source addresses match their
assigned exits. Drain, timeout, isolated failure, stopped-service recovery, and
simultaneous SIGKILL helper/service loss pass. The control mount-identity container
is a fixture. One real local Ubuntu gateway slot now starts, restarts, and recovers
its helper through HTTP. Factory creation and keep/traits rebuild also pass.
Native ARM64 production-image replacement now also passes from the pinned source
baseline. It obtains deployment files from the target image and preserves actual
legacy/managed VM traffic. A separate full CLI installation and same-version
alignment now pass on native AMD64 in an isolated daemon on primaryserver.
Actual remote factory creation and same-installation archive/package restoration
now pass. The current native AMD64 CLI and ARM64 image checks are refreshed.
Published-release upgrades, global ARM64 host preparation, concurrent/disaster
restoration, host restart, real Claude inference and user visual acceptance
remain separate unverified scopes.
The sections below preserve earlier implementation checkpoints; the latest
checkpoint and this current-state section supersede earlier temporary restrictions.

## Scope and evidence

Implementation is in progress. The ADR remains the full delivery scope.
The first executable seam is the protocol converter and a real sing-box process.
The user started Docker Desktop. Its Linux ARM64 daemon is now available.
Acceptance ran in a temporary privileged host-network/host-PID Linux container
inside that existing Docker environment. No additional VM or graphical application
was started by the agent.

## Failure scenarios recorded before implementation

- Malformed links, missing passwords, invalid ports, unsupported query fields, and disabled TLS must fail validation.
- Duplicate exit IDs, duplicate listener ports, and missing listener credentials must fail generation.
- A listener must route only to its named outbound. Unmatched traffic must be rejected.
- Wrong upstream credentials and stopped upstream processes must fail requests without direct fallback.
- An occupied listener port must prevent readiness.
- Concurrent edits must serialize by host and preserve stable port ownership.
- Failed candidate validation must preserve the active file and applied version.
- Restart must wait for affected requests. Drain timeout must preserve the active configuration.
- Failed apply must restore the last verified configuration. Failed restore must block scheduling.
- Remote bindings must fail until remote deployment and control-plane routing are implemented.
- Existing proxy IDs, ownership rules, binding limits, and credential redaction must survive migration.
- Empty configuration must start without opening a proxy listener.
- Configuration files and test artifacts must not disclose credentials.

## Remaining delivery

Container startup and architecture runtime validation; bound-slot admission and draining;
bound-node edit/drain and interrupted-apply recovery for bound slots;
all caller resolution; remote deployment; two-slot network acceptance; real Claude
acceptance; user visual acceptance.

## Verified protocol seam

`src/lib/vm/managed-egress-config.mjs` converts typed Hysteria 2 settings or
`hy2://` / `hysteria2://` links into authenticated loopback SOCKS listeners.
Each listener has an explicit outbound route. The terminal rule rejects traffic.
The converter does not allocate ports, persist records, or apply configuration.

Run the process-level end-to-end check with:

```sh
SING_BOX_BIN=/absolute/path/to/sing-box node --test test/e2e/managed-egress.e2e.test.mjs
```

Verified locally with the official sing-box 1.12.0 Darwin ARM64 release:
empty startup, two real Hysteria 2 upstreams, authenticated SOCKS forwarding,
wrong listener credentials, isolated upstream shutdown, and client shutdown
without direct fallback. The test emits `.tmp/managed-egress-e2e/receipt.json`.
The receipt contains source/test/binary hashes and no credentials.
Temporary certificates and process configuration are removed after the run.
No binary path means the test is skipped; a skip is not acceptance evidence.

## Deployment foundation

The main Compose file now contains a one-shot `sing-box-init` service and a
shared `sing-box` service. Both use the official v1.12.0 multi-architecture index:
`sha256:3c1ee82d450df9b336b6f63b1d272cf86e3835392d99596ef8c35f206a457999`.
The registry manifest confirms Linux AMD64 and ARM64. This proves image
availability, not container startup on either architecture.

The initializer creates a mode-0600 empty configuration, checks it with the
same image binary, and publishes it without overwriting an existing file.
Invalid existing files fail initialization and remain unchanged. The real-process
E2E also covers initialization, repeat initialization, and invalid-file preservation.
The running service mounts the configuration directory read-only and uses host
networking. Neither service has Docker socket access or added capabilities.
The control plane has no readiness dependency on these services.

The build overlay inherits both services. The ARM64 overlay uses its own data
directory for both services, matching the control plane. Image installation
fetches the bootstrap script only when the selected release requires it.
Source upgrades acquire it through the checkout. Panel upgrades start a missing
runtime with `--no-recreate`, preserving an existing shared process.
Shared-runtime replacement still requires the unimplemented drain/apply manager.

Reproduce manifest inspection with `docker buildx imagetools inspect
ghcr.io/sagernet/sing-box:v1.12.0`. Docker daemon availability remains open.
Compose rendering is an auxiliary check. Container startup is not yet verified.
No slot, production deployment, real Claude request, or visual acceptance was run.

Compose rendering passed for the base, build, and ARM64 overlays. The local
checkout has no `.env`; the render check used a temporary final overlay that
resets only `vm2api.env_file`, plus `.env.example` for interpolation. It verified
that both sing-box services use the control plane's data directory and that the
runtime mount is read-only. This does not validate operator environment values.
Shell syntax checks and JavaScript formatting checks passed. The process E2E
passed again after these deployment changes.

## Persistence failure cases before implementation

- Adding protocol settings must not replace existing proxy IDs or bindings.
- Restart must preserve host identity, assigned port, and generated listener credentials.
- Database encryption must cover upstream settings and managed listener credentials.
- Pool snapshot must not reveal settings, listener address, listener port, or credentials.
- Persisted settings must not imply runtime readiness after restart.
- Duplicate managed ports on the same host must fail the transaction.
- Managed ports on different hosts may have the same numeric value.

## Persisted managed settings

Migration `049_managed_egress.sql` adds protocol settings and explicit host identity
to existing proxy rows. A partial unique index prevents duplicate managed ports on
the same host. Existing IDs and bindings stay in place. Assigned ports persist;
port allocation and operating-system conflict detection remain unimplemented.
The repository encrypts managed settings and listener credentials with the existing
optional database encryption helper. It does not persist raw imported links.
An incorrect encryption key fails loading instead of converting the pool to an
empty working set that a later save could overwrite.

Runtime readiness remains process-local and defaults to false. Pending managed
records cannot bind or resolve for a slot. Public pool records hide the internal
listener host and port. Existing SOCKS endpoint editing cannot modify a managed
listener. Managed edit API and automatic readiness recovery remain open.

The real-process E2E now starts from the schema through migration 048, creates an
existing binding, applies migration 049, persists two managed routes, closes and
reopens the database, then forwards through both real Hysteria 2 routes. It also
checks encrypted values, duplicate-port transaction rollback, wrong-key data
preservation, redaction, and pending-runtime binding rejection. This check passed.

Additional command: `node --test test/e2e/persistence.e2e.test.mjs`.
Result: one passed, two failed. Both failures returned HTTP 503 with
`rust kernel is not available` during inference. This run does not prove the
full gateway persistence scenarios. No baseline comparison was performed.

## Host apply failure cases before implementation

- Candidate check failure must not stop the running process or replace its file.
- A drain lease must block new requests before it waits for active requests.
- Drain failure must preserve the active file and applied version.
- Failed restart or route verification must restore the previous file and verify it.
- Failed rollback must retain a recovery file and mark the host unavailable.
- Concurrent apply calls must execute in submission order on the same host.
- A process crash during apply must leave a recovery file for explicit reconciliation.
- Runtime adapter errors must not appear in public state because they may contain secrets.

## Host configuration lifecycle

`ManagedEgressHost` serializes updates for one host. It records desired and applied
configuration hashes separately in the existing settings repository. It validates
a private candidate file, acquires a required request-drain lease, and waits before
replacing the active file. File publication uses rename and file/directory sync.
The previous configuration remains on disk until restart and route verification
succeed. A verified rollback records the old applied hash while preserving the
new desired hash. Failed rollback marks the host unavailable and retains the
recovery file. Explicit recovery reloads state and verifies the recovered process.
Only fixed error codes enter the host status record.

The real-process E2E passed candidate corruption rejection, a held HTTP request
that finishes before restart, drain timeout without restart, wrong-upstream-password
rollback, concurrent apply serialization, failed rollback with blocked admission,
and recovery through a new manager and reopened database. The receipt hashes the
lifecycle implementation and its persistence/deployment dependencies.

The test supplies the drain lease and real-process runtime adapter. Production
bound-slot scheduler admission, credential-operation admission, and interrupted-apply
recovery wiring for bound slots remains unimplemented. The Docker service adapter
and explicit apply readiness publication are described below.
This evidence does not prove production slot draining or container restart behavior.

## Managed import failure cases before implementation

- Invalid links must return fixed errors without echoing input secrets.
- Concurrent imports must not allocate the same port.
- Occupied local TCP ports must be skipped within a bounded range.
- Unsupported host identities must be rejected before persistence.
- User imports must retain the authenticated owner's identity.
- A saved pending node must remain unavailable for slot binding.
- Save failure must remove the uncommitted in-memory row.

## Existing pool import and panel integration

The existing `/api/panel/proxies/import` endpoint now accepts a single Hysteria 2
link or typed `protocol: hysteria2` settings. It retains the existing authenticated
owner. Only `control-plane` placement is accepted. Imports serialize port selection
within 24000–24999, skip occupied TCP listeners, and persist generated credentials.
OS availability checks do not reserve ports until apply; runtime startup and
verification must still detect a competing process that binds later.

The existing import panel now has protocol selection and Hysteria 2 link guidance.
It reports that saved nodes await configuration application. Pending nodes stay
blocked for slot use. Internal generated SOCKS credentials cannot be copied through
the existing reveal endpoint. Bound managed records cannot be deleted. Applied
records require runtime removal before their ports can be released.

`node --test test/e2e/managed-egress-api.e2e.test.mjs` passed against a real gateway.
It covers invalid-link redaction, unsupported remote placement, concurrent port
allocation, occupied-port skipping, pending bind rejection, internal reveal denial,
ID retention across gateway restart, authenticated ownership, cross-owner deletion
rejection, and deleting an owned pending node. Its artifact is
`.tmp/managed-egress-e2e/api-receipt.json` and contains source hashes without secrets.
The real-process lifecycle E2E also passed again after the pool changes.

The web dependency installation used the frozen existing lockfile. Frontend type
checking and formatting passed. No browser or application was launched. Visual
acceptance remains user-owned. Automatic runtime apply, upstream edit/reveal,
complete status display, slot runtime integration, and remote support remain open.

## Docker runtime failure cases before implementation

- Resolve the service through the control plane's Compose project label, never a global service name.
- Reject missing, duplicate, stopped, or unexpected-image runtime containers.
- Check the candidate through the same pinned image used by the running service.
- Never place configuration contents or credentials in Docker arguments or returned errors.
- Require an observed IP through every authenticated listener before publishing readiness.
- Until all request sources join draining, refuse shared-runtime replacement when any managed slot is bound.


## Explicit production apply entry point

The server now constructs the host manager with `ManagedEgressDocker`. Runtime
access is lazy and does not block API startup. The adapter resolves sing-box via
the current control plane's Compose project label. It verifies the fixed image,
host networking, and a read-only configuration directory mapped from the control
plane's actual data mount. It validates the candidate inside that container,
restarts that exact container, and verifies an observed IP through each listener.
Docker output and configuration contents never enter public errors.

Administrators can call `POST /api/panel/proxies/apply` or use the existing import
panel's apply action. The pool serializes this with imports and prevents binding
during apply. Verified application publishes process-local readiness. VM proxy
snapshots preserve managed identity, but cannot persist runtime proof. Reloading
pool state revokes readiness, including for stale snapshots. Remote control-plane
credential resolution explicitly rejects a managed exit on an unsupported node.

This entry point currently rejects shared-runtime changes while any managed slot
is bound. It does not implement the ADR's complete bound-slot drain flow. The
remaining work is to admit every inference and credential operation through a
shared drain gate, then remove that restriction. Interrupted-apply recovery for bound slots and complete managed CRUD remain open.
Read-only startup reconciliation and health monitoring are described below.

The real gateway API E2E passed missing-runtime failure with no credential leakage
and non-admin apply denial. It sets a unique nonexistent control-container name,
so it cannot operate an existing deployment. The real-process network E2E passed
the production listener verifier, pool-to-host apply, binding only after verified
apply, refusal to replace a bound runtime, and stale-snapshot readiness revocation.
Frontend type checking passed. No Docker restart acceptance was run because the
local Docker daemon is unavailable; the production Docker adapter remains unverified
against a live Engine. No production host or user application was started.

## Read-only recovery and monitor failure cases before implementation

- Startup must not restart an instance that may still serve bound slots.
- Readiness requires a previously applied file hash, a live process, and a verified listener route.
- An interrupted apply or retained rollback file must block read-only reconciliation.
- A failed node must revoke only that node when the shared process remains healthy.
- A stopped or replaced shared process must revoke all of its managed exits.
- Imported but unapplied records must not inherit readiness from an older active file.
- Monitoring and configuration updates must serialize to avoid stale readiness publication.


## Read-only startup reconciliation and ongoing health

The server starts a managed-exit monitor without delaying API startup. It serializes
read-only inspections with pool imports/apply operations. It verifies the applied
file hash, rejects a retained rollback file, checks the exact runtime, and verifies
each listener independently. It does not restart an instance during this path.
Polling runs again 15 seconds after the previous inspection completes. Readiness
revocation therefore follows observation; it is not instantaneous failure detection.
Stopping or replacing the monitor invalidates its pending timer generation.

A failed node revokes only its own readiness when the shared process still checks
successfully. An unavailable shared process revokes every managed exit. An applied
row retains its configuration state even when its runtime or route becomes
unavailable. An unapplied row must match both the active inbound and outbound before
it can become ready. Public details report configuration, process, and exit status
separately, plus the observed IP when available. The internal active configuration
is never returned by the pool monitor.

The process E2E passed startup-style readiness reconciliation without restart,
new-unapplied-row isolation, the actual monitor callback after node shutdown,
continued availability of the other node, shared-process shutdown, and restoration
after supervisor-style process restart. It also confirms that a node outage does
not change an applied configuration to pending. The API E2E and frontend type check
passed after these changes. Browser acceptance remains unexecuted.

This does not implement request draining for bound-slot reconfiguration or recover
an interrupted apply while slots are bound. Those operations remain blocked until
all inference and credential callers join the drain gate. Docker Engine acceptance,
remote execution, actual slot traffic, real Claude traffic, and user visual
acceptance remain outstanding.

## Edit and removal failure cases before implementation

- Editing must keep proxy identity, assigned port, and listener credentials.
- Invalid edits must preserve persisted configuration and runtime readiness.
- A desired upstream edit must revoke readiness until it is verified as applied.
- Removal must reject bound nodes and reserve the port until verified deapplication.
- A restart or failed apply must preserve a pending removal and its reserved port.
- Edits, removals, imports, monitoring, and apply must share the same host queue.


## Managed edit and verified removal

The existing proxy edit API now accepts an upstream link or a partial typed
Hysteria 2 configuration. It validates before writing and keeps the proxy ID,
listener port, username, and password. A desired upstream change revokes readiness
until verification. Label-only edits do not restart workers. Bound-node upstream
edits remain blocked until the production request-drain flow is complete.

Migration 050 persists pending removal on the existing proxy row. The delete API
rejects bound nodes and otherwise marks a managed node for removal. The row and its
port remain reserved across failed apply and gateway restart. Apply excludes pending
removals from the candidate. Only successful runtime verification permits deletion
of those rows. A database-save failure retains the pending records in memory.
Internal direct pool removal cannot bypass this sequence.

The existing edit dialog supports replacing a managed node link without exposing
listener credentials. The delete response and UI distinguish pending removal from
completed deletion. The details view shows a pending-removal marker.

API E2E passed invalid-edit redaction, partial typed edit, stable listener credentials,
pending removal, failed apply, and persistence of removal state across restart.
Process E2E passed pending-port retention across reload and verified removal of an
active listener while the other route continues forwarding. It proves port release
by binding a new TCP listener to the removed port after successful apply. The
upstream-edit rollback/restoration check uses the production pool/host path.
Frontend type checking and formatting passed. No visual acceptance was run.

## Request admission failure cases before implementation

- Pausing admission must reject a new transport call before it reaches a worker.
- A live transport call must retain its lease until response/stream processing ends.
- Nested credential operations inside an admitted request must finish during drain.
- Timeout and transport errors must release their leases exactly once.
- Drain timeout must preserve the current runtime and permit admission to resume.
- Host-side URL fetches and autonomous guest activity still require separate coverage before bound-slot apply is enabled.

## Transport request admission

`managed-egress-admission.mjs` now tracks admitted managed-exit operations. It
pauses new admission by exit ID and waits for live leases. A lease covers the
complete transport promise, including response body and stream processing.
An async context lets awaited nested credential operations share the admitted
parent lease, so pausing does not interrupt those operations. Release is idempotent;
an unavailable runtime revokes readiness before paused admission is released.
The shared proxy policy also prevents scheduling a paused exit.

The worker transport entry points now use admission for inference, streams,
control POST/GET, credential ensure/import, and token counting. The slot OAuth
helper entry point also uses admission. Rust and Codex inference already use
these worker transports. Health inspection remains available while paused.

`node --test test/e2e/managed-egress-admission.e2e.test.mjs` passed against a real
Unix HTTP server. It keeps a partial response body open and proves drain timeout,
new transport rejection before the worker, nested credential completion, resumed
admission, transport-error release, external-proxy compatibility, and readiness
revocation on failed-runtime release. The reproducible artifact is
`.tmp/managed-egress-e2e/admission-receipt.json`, with source hashes and no credentials.
The existing managed API and real Hysteria 2 process checks also passed.

This transport evidence uses a controlled worker, not a real Claude kernel.
Host-side URL fetches, geo/probe calls, autonomous guest activity, and every
credential-operation entry still require coverage and audit. Bound-slot apply
remains restricted. No Docker runtime or real Claude acceptance is claimed.

## Host fetch admission failure cases before implementation

- A managed SOCKS URL must resolve to the same exit ID as its slot transport.
- Fetch must retain admission after headers until body end, close, or error.
- Aborting or destroying a response body must release admission once.
- A paused URL must fail before opening a proxy connection.
- Runtime verification must use a private bypass while ordinary geo checks remain gated.
- Endpoint registration must not retain credentials or release a pending-removal port early.

## Host URL fetch admission

Managed endpoint registration now maps the listener host and port to the exit ID.
The registry stores no URL credentials. Pool reload revokes previous registrations;
verified removal forgets the endpoint only after the active listener is removed.
Pending removals retain their endpoint registration and port reservation.

The shared host-side proxy fetch factory now joins admission. OAuth refresh and
exchange, identity enrichment, OpenAI quota/model calls, and Codex host fetches
already use this factory. A response keeps a lease after headers until its body
ends, closes, or errors. Destroying a body also releases the lease. Nested response
leases stay tracked independently until their bodies complete. Callers must consume
or destroy response bodies; an abandoned body can cause drain timeout.

Normal IPv4/IPv6 geo fetches use the same admission path. The host runtime verifier
uses a separate internal geo entry so it can prove a candidate before readiness
publication. Public geo options cannot enable that bypass. Failed HTTP geo responses
destroy their bodies before returning an error.

The real Hysteria 2 E2E passed a host fetch with a held response body, drain timeout,
new URL-call denial, normal geo denial while paused, internal runtime verification
while paused, body completion, body destruction, and resumed normal geo lookup.
The result remains controlled network evidence, not a real OAuth provider or Claude
request. Raw connection probes, autonomous guest activity, complete request-source
audit, and production bound-slot drain integration remain open. The existing
bound-slot apply restriction remains in force.

## Raw probe admission failure cases before implementation

- A pending SOCKS greeting must count as an active operation until its socket closes.
- Paused probes must not open another TCP connection or change node health history.
- Probe timeout must close the socket and release admission.
- An entire probe/repair sequence must retain its outer lease between retry targets.

## Raw SOCKS probe admission

Both the complete pool probe/repair sequence and the raw SOCKS probe now join
managed request admission. Nested retry probes share the outer lease. A paused
probe reports a pending result; it does not increment health failures or disable
bound slots. Raw calls cannot bypass admission. Normal external SOCKS and local
exit behavior stays on the existing path.

`node --test test/e2e/managed-egress-probe.e2e.test.mjs` passed with a real controlled
TCP SOCKS greeting server. A delayed greeting retains admission; paused probes open
no new socket; timeout closes the socket and releases admission. Its artifact is
`.tmp/managed-egress-e2e/probe-receipt.json` with source hashes and no credentials.
This proves probe admission, not forwarding through an upstream node.

## Bound-slot drain audit

Before the helper drain implementation below, `kin-egress` had TCP/DNS listeners
but no runtime admission, active-flow reporting, or drain-control endpoint. Slot telemetry and guest-side
credential work can use transparent forwarding without a new control-plane
transport lease. Consequently, observing zero control-plane leases does not prove
that the shared sing-box instance is idle. Freezing or stopping a guest before
its live request finishes would violate the ADR's in-flight request requirement.
The bound-slot apply restriction remains necessary while this seam is incomplete.

The helper implementation below adds admission and flow evidence. The next
integration must coordinate that evidence with the control-plane gate,
and wait for both. It must preserve the current instance on timeout and keep
faulted exits blocked. Production runtime replacement must not rely solely on
scheduler counters or the absence of active panel requests.

## Outstanding acceptance audit

| Requirement | Current evidence | Remaining evidence |
| --- | --- | --- |
| New install and empty startup | Real binary bootstrap and Compose rendering | Linux container startup on AMD64 and ARM64 |
| Upgrade binding retention | Database migrations through 050 preserve IDs and bindings | Installed deployment upgrade with real slots |
| Two nodes and two slots | Two real Hysteria 2 processes and logical pool bindings | Actual transparent slot traffic with distinct expected exits |
| Bound-node edit and shared restart | Host lifecycle drain with controlled leases | Transparent helper drain plus all guest background traffic |
| Crash recovery | Persisted recovery file and process recovery E2E | Bound-slot production startup reconciliation |
| CRUD, ownership, secrets | Real panel API and verified listener removal E2E | Complete user visual acceptance and bound-node edit |
| All proxy callers | Worker transports, host fetch, geo, raw probes gated | Guest autonomous traffic and final complete caller audit |
| Remote managed deployment | Unsupported placement rejected | Remote configuration delivery, runtime, and credential routing |
| No direct fallback | Controlled process and failed-path evidence | Actual slot and real Claude request evidence |
| Repeatable artifacts | Five scoped sanitized receipts | Linux/remote and real Claude acceptance receipts |

## Transparent helper drain failure cases before implementation

- Pause must serialize with accepting a new TCP/DNS flow; no goroutine may start uncounted.
- Paused ingress must reject new flows while existing flows finish without forced closure.
- UDP DNS and TCP DNS must participate alongside transparent TCP.
- The control endpoint must use a private Unix socket and expose no proxy credentials.
- A status read must identify protocol version, pause state, and active flow count.
- Resume must reopen admission. Process shutdown must close the control listener.
- Existing deployments without a configured control socket must keep their current behavior.


## Compiled transparent-helper drain interface

The Go helper now supports an optional `control_socket` configuration field.
A private Unix HTTP listener with mode 0600 exposes `GET /status`, `POST /pause`,
and `POST /resume`. Status contains protocol version 1, proxy ID, paused state,
and the active flow count. It contains no proxy URL or credentials. HTTP request
header/read/write timeouts are bounded. The helper closes its control listener
when it shuts down. Without `control_socket`, it retains the prior deployment path.

A mutex serializes pause with admission. Transparent TCP and TCP DNS connections
acquire their count before launching a handler. UDP DNS queries acquire a count
before launching lookup. Paused TCP connections are closed and paused UDP queries
are dropped. Existing admitted work finishes normally. TCP DNS counts the whole
connection, including a partial frame or an idle keep-alive connection. This is
conservative: such a connection can make drain time out while the old runtime
continues serving it. No handler is forcibly closed by pause.

A native race-enabled helper build passed process E2E with a real sing-box SOCKS
listener and controlled DoH server. The test proves an active UDP query finishes,
a new query is refused while paused, a TCP DNS partial frame is counted, another
TCP DNS connection is refused, and closing the original connection releases its
count. It checks Unix permissions and rejects the wrong HTTP method. The receipt
is `.tmp/managed-egress-e2e/helper-receipt.json`, with the binary and source hashes.

Linux AMD64 and ARM64 static helper cross-builds passed. They are compilation
evidence only. Native macOS cannot validate `SO_ORIGINAL_DST`; transparent TCP
acceptance still requires Linux. No new unit tests were added.

The main Dockerfile now builds `kin-egress` from this checkout instead of shipping
only the pinned older helper. The AMD64 release workflow also rebuilds that helper
after staging pinned VM assets. ARM64 already builds its helper from source.
`actionlint` passed for the edited release workflow. Container image builds and
workflow dispatch were not run.

Production control-socket configuration, the control-plane drain client, helper
replacement detection, joint drain/timeout/resume wiring, and Linux transparent
traffic acceptance remain to be implemented and verified. Bound-slot shared
runtime replacement remains restricted until that work is complete.

## Joint drain failure cases before implementation

- Pause control-plane admission before pausing transparent helpers.
- A helper replacement must invalidate an acquired lease, even if its proxy ID matches.
- Resume must target the paused process instance, not a replacement at the same path.
- Waiting must use one timeout budget for both control-plane and helper activity.
- Partial pause failure must resume already-paused helpers or revoke readiness if cleanup fails.
- Failed runtime rollback must leave helper admission paused and control-plane readiness revoked.
- Missing or incompatible helper control endpoints must fail closed.

## Joint drain client and helper identity

`EgressDrainClient` uses fresh Unix HTTP connections, bounded response size, fixed
errors, and request deadlines. It validates protocol version, proxy ID, active
count, pause state, and a random per-boot helper identity. Mutating requests include
`If-Match`; the helper rejects a stale identity before changing admission. An old
client therefore cannot resume a replacement process at the same socket path.

`acquireManagedDrain` first pauses control-plane admission. Its wait phase waits
for admitted control-plane operations to finish before pausing helper ingress.
This order lets a live inference operation finish opening its own connections.
It then waits for every paused helper's live flows. Both phases use the same wait
deadline. Normal release resumes pinned helpers and control-plane admission. A
failed-runtime release leaves helpers paused and revokes control-plane readiness.
Partial pause failures are cleaned up through lease release; a cleanup failure
revokes readiness and reports a fixed error.

Managed helper configuration now includes the private control socket path. Existing
helpers are reused only when that path matches the requested configuration. External
SOCKS helpers retain their previous configuration. This code does not itself prove
that a deployed helper binary supports the protocol; the client fails closed for
missing or incompatible endpoints.

The race-enabled compiled-helper E2E passed joint waiting with both a held control
operation and a live DNS request, timeout with current work preserved, conditional
resume after real helper replacement, and failed-runtime release that leaves the
replacement helper paused. Linux AMD64 and ARM64 cross-builds passed again after
the helper protocol change. All five scoped managed-egress E2E checks passed.

The production server still uses its conservative bound-slot restriction. Connecting
this lease to production host apply, restoring readiness correctly after an aborted
update, startup reconciliation of paused helpers, and Linux transparent TCP traffic
acceptance remain required before lifting that restriction. Remote managed runtime
support and actual slot/Claude acceptance remain outstanding.

## Production drain wiring failure cases before implementation

- Collect every live helper for managed exits, including unbound but still-running helpers.
- Refuse ambiguous helper processes and missing bound-helper evidence.
- Do not revoke an existing request's runtime proof before its admitted operation finishes.
- On timeout or candidate failure, reverify the unchanged active file before restoring readiness.
- On helper-resume failure, persist an unavailable host state so monitoring cannot republish readiness.

## Production apply wiring and aborted-update readiness

The production host manager now acquires the joint drain lease. Helper discovery
runs only after existing control-plane operations finish, while new admission is
paused. It enumerates live helper processes for every managed exit, including
unbound exits. Ambiguous processes are rejected. A bound exit without a live helper
is rejected. Each selected helper must support the pinned control protocol.

The pool no longer revokes the current runtime proof before its existing admitted
operations finish. If candidate validation, draining, or application fails, it
re-inspects the unchanged or rolled-back active configuration before restoring any
row's readiness. A failed update is never reported successful merely because its
desired hash equals its old applied hash. Pending edits stay pending; unchanged,
verified rows can resume after a timeout. Observed-IP fields are cleared when a
new apply invalidates the previous observation.

A drain-release failure now persists an unavailable host state during both apply
and explicit recovery. Inspection refuses that state, so the monitor cannot
republish readiness after helper resume fails. The pool revokes readiness and
publishes unavailable exit state on unexpected apply failure.

The real-process E2E verifies that a rejected pool apply restores a previously
verified unchanged route after drain timeout, returns a failure code, and preserves
the active configuration. It also injects a drain-release failure, verifies the
persisted unavailable state, rejects inspection, and performs explicit recovery.
The compiled helper test exercises deferred discovery after host operations finish.
All five scoped E2E checks passed after this wiring.

The pool's bound-slot apply guard is still present. Full combined acceptance with
real slot/helper traffic and Linux transparent TCP remains necessary before removing
it. The joint drain is wired into allowed apply/recovery operations, but that wiring
is not evidence of Docker restart or bound-slot end-to-end acceptance.


## Combined real helper and Hysteria 2 apply acceptance

The real-process E2E now optionally includes the compiled `kin-egress` helper when
`KIN_EGRESS_TEST_BIN` is set. A held helper DNS query passes through the first
managed SOCKS listener and its Hysteria 2 server. A simultaneous host response body
also holds admission. The host manager waits for the host body before pausing
helper ingress, waits for the DNS response before restarting sing-box, then verifies
both managed routes and resumes helper admission. A DNS query after restart also
succeeds. A separate short drain timeout preserves the original process and lets
the held host response finish. Missing helper binary is recorded as NOT RUN for
this combined section rather than claimed as acceptance.

This combined check passed with both binary environment variables set. The pool's
bound-slot apply guard is now removed. Bound upstream edits preserve the stable
listener and use the same apply flow. Bound removal remains rejected. Admitted
nested operations may finish after an edit revokes readiness for new operations.
Helper startup/repair now joins admission, preventing helper creation from racing
shared-runtime restart. Unbind and enable/disable mutations are rejected during
managed apply. Helper discovery remains deferred until admitted work finishes.

Readiness inspection now also checks helper availability. A paused, missing bound,
or ambiguous helper prevents readiness publication even if sing-box itself is
healthy. This covers a controller crash after recording a successful apply but
before resuming helper admission. Automatic resume/recovery policy still needs
complete production validation; the system keeps such exits blocked.

All five scoped E2E checks and frontend type checking passed after these changes.
This remains controlled native-process evidence with a logical binding. Real Linux
transparent slot traffic, live Docker apply, remote managed-node deployment,
interrupted-apply operational recovery, actual Claude requests, and user visual
acceptance remain required for the full ADR.

## Operational recovery failure cases before implementation

- Only an administrator may restart the shared runtime for recovery.
- Recovery must serialize with imports, edits, apply, removal, and monitoring.
- Recovery failure must revoke readiness without returning configuration contents.
- Successful recovery may restore an older applied version while desired edits remain pending.
- Readiness publication must verify helper admission after recovery, not just sing-box health.

## Administrator recovery entry point

`POST /api/panel/proxies/recover` now exposes the existing host recovery operation
through the same administrator-only boundary as apply. The existing import panel
has a recovery action. The pool serializes recovery with other managed mutations,
blocks binding changes during recovery, reinspects the restored file and helpers,
and publishes readiness only for matching desired rows. A pending desired edit or
removal is retained and reported separately from the recovered runtime version.
Recovery does not claim success when helper verification still fails.

API E2E passed non-admin recovery denial and missing-runtime recovery failure
without credential leakage. The real-process E2E passed pool recovery, helper
unavailability rejection, and recovery of an older active file while a newer edit
remains pending. All five scoped E2E checks and frontend type checking passed.
The operational guide is `docs/operations/managed-egress.md`. Container, Linux
transparent-slot, remote-host, actual Claude, and user visual acceptance remain open.

## Remote endpoint failure cases before implementation

- Host-side callers must reach the selected remote loopback SOCKS listener through SSH.
- The bridge must not dial the control plane's destination or fall back to a local route.
- SSH channel failure and link closure must close accepted clients and revoke readiness.
- A closed bridge must not leave sockets or endpoint registrations behind.
- A stale bridge must not unregister a newer bridge with the same exit ID.
- Bound connection counts and channel-open deadlines must prevent unbounded local resource use.

## Remote managed listener access seam

`startRemoteManagedEgressEndpoint` now bridges a control-plane loopback TCP listener
to one selected node's loopback SOCKS port through the existing SSH `direct-tcpip`
channel helper. It forwards bytes without terminating SOCKS authentication. It does
not dial a target destination on the control plane or select a fallback route.
The endpoint registers its actual local address for managed URL admission. Runtime
verification must still publish readiness separately.

The bridge bounds accepted or pending connections to 256 and bounds channel opening
to 15 seconds. SSH/channel failures close clients and revoke readiness. Closing a
bridge removes its registrations and listeners. An older bridge checks registration
ownership before revocation, so replacing an endpoint cannot let stale cleanup revoke
the new route. Endpoint metadata contains no credentials.

The new process E2E uses the maintained ssh2 library for a real pinned-host-key SSH
connection, a real authenticated sing-box SOCKS listener, and a controlled HTTP
origin. It passed selected-node forwarding, wrong SOCKS authentication rejection,
1 MiB byte preservation, stale-endpoint cleanup, interruption during a live response,
and readiness revocation after SSH closes. The receipt is
`.tmp/managed-egress-e2e/remote-endpoint-receipt.json`. Six scoped checks passed;
the remote check also passed again after its final source changes.

The SSH server and SOCKS listener run on loopback for this controlled acceptance.
This does not prove deployment to a separate machine. The module is not yet wired
to managed remote creation, configuration delivery, runtime apply, or remote slot
binding. The existing unsupported-remote guard remains active until those paths
are implemented. The local Docker daemon was rechecked and remains unavailable;
no application or VM was launched to change that state.

## Remote configuration storage failure cases before implementation

- Configuration contents must travel over SFTP payloads, never SSH command arguments.
- Remote writes must use the existing exclusive temporary-file and atomic-rename implementation.
- Reads must refuse final-component symlinks and enforce a bounded configuration size.
- Only the managed candidate, active, and previous file names are accepted.
- A missing remote file must remain distinguishable from transport or permission failure.
- Remote root permissions and file permissions must keep guests out of host configuration.

## Remote managed configuration storage seam

`RemoteManagedEgressFiles` now reuses the existing SSH/SFTP file operations. It
accepts only `candidate.json`, `config.json`, and `previous.json` under an explicit
host-only root. It creates the root with mode 0700 and writes mode-0600 files with
exclusive temporary files plus the existing OpenSSH atomic rename operation.
Reads use the existing no-follow reader and reject content over 8 MiB. Missing
files carry ENOENT; transport and permission failures remain distinct fixed errors.
No configuration contents enter an SSH command argument.

The remote E2E now runs the system OpenSSH `sftp-server` behind a real SSH subsystem
channel. It also executes the existing remote read scripts through that SSH session.
The test passed atomic replacement, root/file permission checks, final-symlink read
refusal, replacement without following a symlink target, missing-file detection,
restricted file names, idempotent removal, and absence of node secrets from captured
exec commands. It tests a root path containing spaces and an apostrophe.

Six scoped E2E checks passed. The remote receipt additionally records the test
platform, source revision, dependency source hashes, sing-box binary hash, and
system SFTP server hash. Test fixture session cleanup was corrected to wait for
subprocess exit status before closing an exec channel. The failed controlled
fixture was inspected and removed with explicit file deletion and empty-directory
removal; no production state was used.

This file transport remains a seam, not deployed remote runtime support. The host
configuration lifecycle still uses local file operations. Remote host-manager file
integration, remote Compose provisioning, container check/restart, helper drain,
and remote node creation/binding remain to be connected and verified. The remote
creation guard remains active until those paths are ready.

## Remote lifecycle integration failure cases before implementation

- Local and remote stores must execute the same desired/applied-version transitions.
- A remote candidate failure must preserve the active remote file and applied version.
- Failed remote verification must restore and verify the previous remote file.
- Failed remote rollback must retain recovery material and mark the host unavailable.
- Reopened control-plane state must recover through the same remote file store.
- Store roots must match the lifecycle's explicit host configuration directory.


## Shared lifecycle with remote storage

`ManagedEgressHost` now accepts the concrete remote managed-file store while
retaining its existing local file operations by default. The store root must match
the host's explicit configuration directory. Candidate generation, desired/applied
hashes, serialized updates, drain, rollback, inspection, and explicit recovery
remain the same code for both locations. The remote branch uses only the fixed
managed file names; local file/directory sync behavior remains unchanged.

The remote E2E runs the shared lifecycle through actual SSH and OpenSSH SFTP.
It checks candidates with a real sing-box CLI over SSH and starts a real empty
sing-box process through an SSH exec channel. It passed empty apply, invalid remote
candidate rejection without active-file replacement, drain timeout, and rollback
after a real listener-port conflict. It then writes an interrupted active file and
previous file over SFTP, reopens the control-plane database, and recovers the prior
configuration through the same remote store. Remote commands contain paths only,
not upstream settings or credentials.

The runtime adapter in this controlled test manages a native empty process. It
proves file/lifecycle integration, not remote Docker or nonempty remote-node exit
verification. Full remote managed creation still remains guarded. Remote Compose
provisioning, pinned-image checking, container restart, per-host pool orchestration,
remote helper drain, and remote slot binding remain to be implemented and verified.
The failed test fixture's SSH channel-close observation was corrected; cleanup now
tracks actual channel closure and uses exec for the long-running test process.

## Remote Docker runtime failure cases before implementation

- Resolve the service only within the selected node and expected Compose project.
- Reject missing, duplicate, stopped, unexpected-image, privileged, or writable-config instances.
- Run checks in the pinned running image and restart only the checked container ID.
- Verify remote listeners through the SSH endpoint bridge, never the control plane's same-numbered ports.
- Keep Docker command output and node configuration out of public errors.
- Provisioning must preserve an existing active configuration and avoid recreating an existing service before drain.

## Remote Compose and Docker runtime adapter

`RemoteManagedEgressDocker` now uses the selected node's existing pinned SSH
connection for Docker commands. Arguments contain paths, image references, labels,
and container IDs only. Command output and malformed inspection output become
fixed errors. The adapter resolves a single service by Compose project, service,
and managed-node labels. It rejects unexpected images, stopped instances for
verification, writable configuration mounts, privileged containers, added
capabilities, writable root filesystems, and Docker socket mounts.

Provisioning writes a fixed `compose.json` through SFTP, preserving an existing
`config.json` and generating the checked empty configuration only when absent.
The service uses the pinned official image, host networking, dropped capabilities,
a read-only root filesystem, and a read-only directory bind. Provisioning checks
configuration before `up -d --no-recreate`; it does not intentionally replace an
existing running shared service before drain.

Candidate checking uses a short-lived offline container of the same pinned image.
This permits checking configuration before restarting an existing stopped service.
Restart revalidates the service identity and targets only the checked container ID.
Verification maps node-local listeners through the SSH endpoint bridge before
observing an exit IP, rather than using the control plane's same-numbered ports.
The remote store now allows the fourth fixed deployment file, `compose.json`.

The SSH E2E added an explicitly scoped Docker-command fixture. It runs real sing-box
configuration checks and validates generated Compose through the real Compose CLI.
It passed active-file preservation, command delivery, malformed-inspection redaction,
image/mount/privilege/socket rejection, duplicate-service rejection, stopped-service
handling, replacement detection, and SSH-bridged listener verification. The fixture
records restart delivery but does not perform a Docker restart or provide container
isolation. This is transport/manifest evidence, not live Docker acceptance.

Six scoped checks passed, and the remote check passed again after final adapter
changes. The local Docker daemon was rechecked and is still unavailable. Remote
creation/binding remains guarded: per-host orchestration, remote helper drain,
remote-node API/UI integration, and live Linux/Docker acceptance remain required.

## Remote helper drain transport failure cases before implementation

- Remote drain HTTP must travel over SSH direct-streamlocal, not a public TCP listener.
- The local relay socket must use the existing private socket relay and mode 0600.
- The same helper instance pin and conditional resume rules must apply across SSH.
- Missing SSH links and replaced helper processes must fail without local fallback.
- Relay shutdown must close active local clients and remove its socket.

## Per-host pool lifecycle failure cases before implementation

- Applying or recovering one host must not submit another host's exits.
- Deletion confirmation on one host must not remove another host's tombstones.
- An unavailable host must not prevent inspection of a healthy host.
- Missing host managers must fail without using the control-plane manager.
- Remote persisted listener ports must not be registered as local endpoints at startup.

## Remote host coordination failure cases before implementation

- Read-only host lookup must not deploy or restart services.
- Configuration, endpoint bridges, and helper discovery must use the same selected SSH client.
- A changed SSH client must invalidate old endpoints and leases before accepting new work.
- Every bound slot must have exactly one running helper with the expected private control mount.
- Unbound but running helpers for an affected exit must also drain.
- Host request bodies must finish before discovering and pausing helper controls.
- Helper discovery, pause, resume, or SSH failure must not leave local relay sockets behind.
- Provisioning must remain explicit and must not run during read-only monitoring.

## Remote control-plane resolution failure cases before implementation

- Remote listener ports must never become control-plane dial targets.
- Authentication must remain attached to the selected SSH-bridged listener.
- A missing bridge, changed remote port, or changed SSH client must reject lookup.
- Geo lookup must not interpret an unavailable managed endpoint as local egress.
- SOCKS probes must use the same bridge resolver and fail before opening a socket when it is unavailable.

## Remote import and deployment failure cases before implementation

- Remote imports must target a connected Linux node and retain their selected host ID.
- Port allocation must combine that host's persisted reservations and live TCP listeners.
- Repeated remote imports must not register remote loopback ports as local endpoints.
- Only administrators may select a remote host in the import API.
- Apply may provision an absent service, but must not restart an existing stopped service before drain.
- Ambiguous or invalid runtime identity must not be treated as an absent service.
- Failed deployment must preserve persisted desired configuration for a later retry.

## Local stopped-runtime recovery failure cases before implementation

- Configuration checks must work while the selected shared service is stopped.
- Checking must use the pinned image and exact host-side configuration directory.
- The offline check must not start or replace the shared service.
- Restart must revalidate the checked container and configuration mount after drain.
- Replaced containers, changed Compose identity, writable configuration, privilege escalation, and Docker socket mounts must fail.
- Malformed Docker inspection output must return fixed errors without echoing output.

## Remote slot endpoint resolution failure cases before implementation

- Remote helpers must use the selected node's listener rather than a control-plane bridge URL.
- A managed exit on another host, or a snapshot without stable placement metadata, must fail before network creation.
- A supplied URL must not override the managed host and listener reservation.
- Internal placement metadata must survive binding persistence without appearing in public VM summaries.
- External SOCKS behavior must remain unchanged.

## Linux transparent-network acceptance failure cases before implementation

- Refuse execution without an explicitly selected Linux Docker environment and local slot image.
- Create only uniquely named test containers, networks, helper directories, and firewall chains.
- Require two controlled upstream source addresses; a container's direct source address must fail the assertion.
- A live transparent request must prevent the shared service from restarting.
- Stopping an upstream or shared service must fail affected slot traffic without direct fallback.
- Missing prerequisites must produce NOT RUN evidence rather than a success receipt.
- Cleanup must target only resources created by this test and retain no credentials in its receipt.

## Missing-helper bootstrap failure cases before implementation

- A missing local helper may be rebuilt only after the applied runtime and selected exit pass verification.
- Desired edits that differ from the applied file must not authorize rebuilding against unverified settings.
- Repair must keep ordinary request admission blocked until helper status passes again.
- Paused, ambiguous, or incompatible live helpers must not be replaced by this repair path.
- A failed repair must retain bindings and leave readiness revoked.
- Helper repair must not restart the shared sing-box instance.

## Simultaneous runtime/helper recovery failure cases before implementation

- Only explicit recovery may accept a proven absent bound helper.
- A persisted live PID, missing provenance, invalid listener configuration, live control socket, or occupied TCP/UDP port must reject absence proof.
- Reserve the absent helper's data ports until shared-runtime recovery releases its lease.
- Failed proof must close every reservation and must not signal unknown processes.
- Runtime recovery must not publish ordinary readiness before helper reconstruction and verification.

## Crashed-helper control socket failure cases before implementation

- SIGKILL leaves a Unix socket pathname that must not permanently prevent recovery.
- An active control listener must never be removed or replaced by another helper.
- Refuse regular files, symlinks, uncertain dial errors, and changed socket identity.
- Reclaim only an unchanged socket whose connection is explicitly refused.

## Real SSH/Docker host lifecycle failure cases before implementation

- Remote config storage, checks, provisioning, verification, and recovery must use the selected SSH host and its real Docker daemon.
- A failed remote shared instance must revoke its exits without breaking the separate local instance.
- Remote verification must traverse SSH and preserve generated SOCKS authentication.
- Cleanup must remove only the test node's validated Compose service.
- Same-daemon SSH acceptance must not be described as independent multi-host or full VM startup acceptance.

## Managed remote binding admission failure cases before implementation

- Binding, allocation, and restored bindings must match the VM host and a current verified Linux manager/SSH bridge.
- Force must not bypass host placement, runtime readiness, or bridge identity.
- Binding initialization must serialize with host inspection and apply, and block ordinary admission until the helper verifies.
- Failed helper setup must report failure and preserve the committed binding for repair.
- Rejected host/quota checks must preserve the previous binding.
- Credential lookup must use the current pool bridge and refuse managed snapshot or arbitrary URL fallback.

## Real Linux ARM64 container acceptance

After the user started Docker Desktop, the daemon reported Linux/aarch64 and
Docker 28.3.0. The Linux acceptance ran in a temporary privileged runner sharing
that daemon's network and PID namespaces. A task-owned volume used the same
absolute path in the runner and daemon so real configuration bind mounts matched.
The runner used a read-only Git metadata mount for source identity. The selected
traffic image contains only the tools needed by this test; it is not a full
gateway slot image. The receipt records its actual immutable image ID.

The first run exposed an acceptance-path error: long Docker volume paths exceeded
the Unix socket limit. The test now puts native helper directories under a short
`/tmp` path. The next expanded run exposed a production issue: SIGKILL left a
control socket pathname that prevented helper restart. The Go helper now probes
an existing socket, preserves any live or uncertain listener, and reclaims only
an unchanged socket inode whose connection is explicitly refused. Regular files
and symlinks are not reclaimed.

The final Linux run passes with two actual Docker traffic containers, real
iptables/bridges, native Linux helpers, real Hysteria upstreams, and the pinned
sing-box service image. Observed source addresses are `127.0.0.2` and `127.0.0.3`.
It verifies transparent TCP routing, held-flow drain, timeout preserving the
running instance, isolated upstream loss without fallback, stopped-service
recovery, and simultaneous service/SIGKILL helper loss with reserved-port recovery.
A duplicate helper preserves the live control socket. The rebuilt helper uses
the current Go source; the receipt includes source, binary, image, and config
hashes. Its source hashes match the current checkout.

All six native scoped E2Es also pass after the Go change. The Linux PASS receipt
is separate from those native receipts. Test containers and networks were cleaned
by the test. The stopped runner and its task-owned volume are cleaned after the
receipt is copied out. The task-owned acceptance image is retained for reruns.
No existing application container is restarted or removed.

The Docker availability blocker is resolved. The full gateway VM lifecycle,
remote placement/credential admission, fresh deployed install/upgrade, host reboot,
real Claude, and user visual acceptance remain separate incomplete requirements.

## Real SSH/Docker logical-host acceptance

The Linux check now starts a loopback-only SSH fixture using the existing `ssh2`
dependency, an ephemeral pinned host key, random authentication, native command
processes, and the actual OpenSSH SFTP server. It uses the real Docker CLI,
Compose plugin, daemon socket, and generated sing-box Compose service. No Docker
or `ss` command fixture participates in this Linux branch.

The actual proxy pool imports two exits through remote listener discovery and
persists their host/port identities. The remote coordinator provisions and
applies the selected host's shared service through SSH/SFTP/Compose. Authenticated
control-plane requests traverse SSH bridges and observe the expected two source
addresses. Stopping the selected shared service revokes its exits without breaking
the separate local traffic paths. Explicit recovery restores both remote routes.

The same check uploads the compiled helper through SFTP and invokes production
`ensureRemoteEgress` through the Docker Engine API over SSH direct-streamlocal.
Two real per-slot helper containers and traffic containers preserve the chosen
exit mapping. Their bindings are seeded directly in the test database; the public
binding API remains guarded. A live transparent remote-helper flow prevents
shared-service apply from finishing until the flow ends. Helper pause, flow
counting, restart, verification, and resume use the real Unix control sockets.
The strengthened check observes `draining`, a paused helper, and a nonzero live
flow count before releasing the held response. It does not infer drain from a
short delay while the candidate might still be checking.

Both logical hosts use the same controlled Docker daemon. Host facts are supplied
by the fixture, not by full cluster enrollment. This is not separate physical-host
acceptance, full gateway VM startup, or a real remote credential exchange. The
receipt includes both configuration versions, observed sources, and source hashes.
The new fixture Dockerfile supplies the Linux runner's real CLI/Compose/SFTP tools.
Native skipped checks now write `linux-not-run-receipt.json` so they cannot erase
the separate real Linux PASS receipt.

## Remote helper drain transport

`startRemoteEgressDrain` reuses `SocketRelay` and `EgressDrainClient`. Each helper
has a private local Unix socket with mode 0600. Requests travel over the selected
node's SSH direct-streamlocal channel. The existing helper boot-instance pin and
conditional resume validation remain active across the relay. Missing links and
replaced processes return fixed control failures.

Managed remote helper specifications now include a control socket under
`/run/kin-egress`. A separate mode-0700 host directory supplies this writable
mount. Configuration and executable mounts remain read-only. Guest containers
do not receive the control directory. Existing external SOCKS helper specifications
retain their previous digest and mount layout.

The remote E2E launches the real compiled helper through a real SSH exec channel.
It verifies pause/resume, instance replacement rejection, fresh-instance recovery,
SSH disconnect failure, mode 0600, and local relay cleanup. Its receipt records
the helper binary hash, sing-box binary hash, source hashes, and reproduction
command. The helper test does not instantiate the remote container specification.
Live Docker acceptance remains NOT RUN because the local Docker daemon is
unavailable. No application or VM was started to change that condition.

The remote host coordinator described below now owns helper discovery and connects
these controls to the shared host apply lease. Full remote import and caller
resolution remain required before removing the creation/binding guard.

## Per-host pool lifecycle routing

The proxy pool resolves remote host managers through `managedHostFor(hostId)`.
The control-plane manager retains its existing explicit property. Apply and
recovery submit only the selected host's rows. Successful removal confirms only
that host's tombstones. Read-only reconciliation checks every represented host
and continues after a manager fails. Startup registers only control-plane
listeners as local endpoints; remote listener ports must wait for SSH bridges.
The local server drain provider also selects only control-plane rows.

The existing admin apply/recover endpoints accept an optional `host_id`. An
omitted field preserves the local operation. Invalid fields return HTTP 400.
An absent selected manager returns HTTP 409 with `managed_runtime_unavailable`.
The remote creation and binding guards remain active.

The process E2E added two logical host identities backed by separate real
sing-box processes, configuration directories, and persisted version records.
It verifies selected-host configuration, isolated restart counts, missing-manager
failure, healthy-host reconciliation, selected-host recovery, and tombstone
preservation. Both processes run on the same development machine. This evidence
does not prove remote Docker deployment or node restart behavior. The main
receipt records this boundary in `per_host_lifecycle`.

## Remote host coordinator and server integration

`RemoteManagedEgressHosts` creates one shared lifecycle for a selected Linux node
and its current SSH connection. It uses the cluster manager's existing client and
host facts. Host lookup does not write files or deploy services. Provisioning is
an explicit serialized operation. The remote root is the node's existing vm2api
root plus `managed-egress`. A stable Compose project name derives from the node ID.

The coordinator connects the concrete SFTP store, Docker runtime, authenticated
SOCKS endpoint bridges, and private helper controls to `ManagedEgressHost`.
An apply lease first drains control-plane requests. It then inspects the selected
node's helper containers. Every bound slot must have exactly one matching helper.
Discovery checks container identity, proxy and slot labels, running state, host
network mode, and the exact writable private control-directory mount. Running
helpers without a current binding are also included. Partial discovery failure
closes every relay it created. Release always closes temporary control relays.
An unavailable runtime retains helper pauses while those relays close.

Each manager pins its SSH client. A reconnect invalidates the prior manager,
revokes readiness, and closes its endpoint bridges and helper relays. A stale
manager rejects new file and Docker operations. Read-only helper inspection uses
fresh controls and rejects paused helpers. The server supplies these managers to
the per-host pool resolver and routes remote helper health checks through them.
Node edits are refused during managed configuration application. Shutdown awaits
remote relay cleanup before stopping cluster links.

The extended remote E2E uses real SSH, OpenSSH SFTP, and a real compiled helper.
The Docker executable remains an explicit command fixture. A fixture restart
checks the real helper's paused state before reporting success. The check covers
explicit provisioning, response-body drain, drain timeout, mount and binding
rejection, duplicate helpers, missing helpers, partial-relay cleanup, failed
rollback retaining pause, verified recovery resuming the helper, SSH client
replacement, persisted versions, old-manager refusal, and endpoint verification
through the new client. Six scoped E2E checks passed after integration.

This test does not run a Docker service, Linux transparent TCP, or an independent
remote machine. Remote import/provisioning flow, slot-host caller resolution,
host selection in the UI, and live Linux/Docker acceptance remain incomplete.

## Remote control-plane endpoint resolution

The remote coordinator now exposes the cached address of an existing SSH bridge
only while its selected SSH client and persisted remote port still match.
The pool uses this resolver for internal credential lookup, geo lookup, and
connection probes. The server wires the resolver to its remote coordinator.
Credential lookup preserves the listener credentials but replaces the remote
loopback address with the control-plane bridge address. Missing or stale bridges
return `managed_remote_endpoint_unavailable` and revoke readiness. Geo lookup
returns before issuing a request when resolution fails. It cannot treat that
failure as a local-egress URL. Probes also resolve before opening a socket.

The remote E2E seeds an encrypted managed row in the actual pool, resolves its
credentials through the coordinator, and sends controlled HTTP and geo requests
through real SSH. It checks that the dial port differs from the remote listener
port. Missing bridges reject lookup, geo, and probe operations. A changed remote
port or SSH client invalidates resolution. Reconnection creates a new bridge and
controlled requests succeed through that bridge. All six scoped E2E checks passed.
The receipt records this scope in `control_plane_resolution`.

Pool reload revokes URL registrations and readiness. Reverification restores a
cached bridge's URL registration before publishing readiness again. The remote
E2E checks this transition so reloaded URLs retain request-admission accounting.

## Remote import, deployment preparation, and host selection

Administrators can now import managed exits on a connected Linux cluster host.
The pool asks that host for its TCP listening ports with `ss -H -ltn`, combines
them with persisted reservations for that same host, and assigns a stable port
from the existing bounded range. The operation retains the selected host ID and
existing encrypted credential rules. Import does not deploy a service or register
the node-local listener as a control-plane endpoint. Unknown hosts, malformed
listener output, and disconnected hosts fail without allocating a local port.
The real import API denies remote host selection to non-administrators.

Remote apply now prepares the selected host before applying its desired exits.
Preparation serializes with that host's lifecycle and locates existing services,
including stopped services. Only the specific missing-service result permits
provisioning. Ambiguity, identity errors, and inspection errors remain failures.
An existing stopped service waits for the normal drain and checked restart.
Interrupted or unavailable host state requires recovery before preparation.
Failed preparation retains desired rows and stable reservations for retry.

The import panel now offers administrators a host selector for Hysteria 2.
It lists connected Linux nodes and the control-plane host. The selected host is
included in import, apply, and recover requests. A missing or disconnected
selection blocks submission without switching to the control plane. Managed
proxy details show the host label only in administrator snapshots. Tenant
snapshots omit both the managed host ID and label. Remote-slot limitations appear
in the import instructions. No browser, application, or VM was launched.

The remote E2E verifies concurrent import, per-host reservations, encrypted
persistence, no local endpoint registration, malformed listener-output rejection,
absent/stopped/ambiguous deployment handling, and desired-state retention after
provisioning failure. SSH, SFTP, and the database are real. Both `ss` output and
Docker lifecycle commands are explicit fixtures in this Darwin test. It does not
prove Linux listener discovery or live container provisioning. The real gateway
E2E verifies administrator-only remote import and tenant host-field redaction.
TypeScript checking and formatting passed. Visual acceptance remains NOT RUN.

Remote slot binding, restored-binding resolution, and automatic allocation remain
guarded. Imported remote exits must not displace supported local candidates while
that guard remains active. Full slot-host routing and acceptance remain required.

## Local stopped-runtime check and restart

The local Docker adapter previously used `docker exec` for configuration checks.
That required the shared service to be running and prevented recovery of a stopped
service. It now validates a candidate in a short-lived container of the same
pinned image. The check container has no network, a read-only root filesystem,
dropped capabilities, and only the exact read-only host configuration directory.
The adapter derives that host directory from the control container's data mount.
It accepts only fixed candidate/active filenames inside its configured directory.

Checking can locate a stopped shared service but does not start it. After drain,
restart resolves the service again and compares both the container ID and host
configuration directory with the successful check. A failed check clears its
restart pin. Verification still requires a running instance and the same pin.
The adapter also validates Compose identity, rejects unsafe runtime isolation,
and converts malformed inspection output into a fixed error.

The existing command-integration E2E now covers local Docker invocation as well
as SSH invocation. It runs the real sing-box checker behind an explicitly scoped
Docker executable fixture. It verifies stopped-service checking without startup,
host/container path translation, offline check arguments, checked restart,
replacement rejection, failed-check pin invalidation, writable mounts, privilege,
Docker socket mounts, wrong service identity, invalid paths, and output redaction.
Six scoped E2E checks passed. The receipt records this boundary in
`local_stopped_runtime`. The local Docker daemon was checked again and remains
unavailable. Live container recovery is still NOT RUN.

## Remote helper endpoint placement

Internal pool credential snapshots now carry the managed host ID and stable
listener reservation separately from the control-plane bridge address. Binding
persistence retains these fields. Public VM summaries expose only the managed
exit ID and protocol. They do not expose the bridge URL, listener reservation,
host identity, username, or password.

`remoteEgressProxyUrl` resolves a managed helper's URL from that stable reservation
only when the exit host matches the selected slot host. It rejects missing host
metadata, missing reservations, and missing generated authentication. A supplied
URL cannot override the managed host or port. External SOCKS URLs retain their
existing behavior. `ensureRemoteEgress` calls this resolver before creating a
network or helper, so placement mismatch has no remote setup side effects.

The remote E2E builds a helper configuration from a control-plane bridge snapshot,
then launches the actual compiled helper through SSH. A controlled UDP DNS query
passes through the real node-local authenticated SOCKS listener to a controlled
HTTP DNS endpoint. The SSH TCP-forward counter remains unchanged during that
query, proving that the helper does not dial the control-plane bridge. Wrong-host
and missing-reservation requests fail before setup. A real binding file preserves
the host/reservation fields, while its public summary omits them. The receipt
records this scope in `slot_endpoint_resolution`. All six scoped E2E checks passed.

This is native helper and endpoint-placement evidence. It does not prove Linux
transparent TCP, a Docker slot, or the complete remote VM startup/inference path.
Remote binding and restored-binding admission remain guarded until those paths
are implemented and accepted.

## Executable Linux transparent-network acceptance entry point

`managed-egress-linux.e2e.test.mjs` now defines the controlled Linux network
acceptance path. Execution requires explicit opt-in, root on the Linux Docker
host, native sing-box/helper binaries, an existing local slot image, and a local
non-loopback origin address. It reuses production `ensureProxyEgress`, firewall
rules, the local Docker runtime adapter, joint helper drain, and host recovery.
It creates two controlled Hysteria upstreams and two Docker traffic containers.
Their observed source addresses must match separate upstream loopback addresses.
It also checks held-request drain, timeout preservation, isolated upstream
failure, stopped-service failure, and checked recovery. Cleanup targets only
test-owned container labels and prevalidated unique network identities.

This entry point has not executed its Linux path. Only its opt-in/skip path ran
on Darwin and produced an explicit NOT RUN receipt. Both configured local Docker
contexts were inspected; their daemon sockets are unavailable. A controlled Linux
Docker environment was requested from the user. The script remains unaccepted
until it passes there. The six native scoped E2Es retain their separate evidence.
The Docker mount-identity fixture is not a full API container. Even a future pass
will not establish full gateway slot startup, remote deployment, host reboot,
real Claude requests, or visual acceptance.

## Verified missing-helper bootstrap

The previous health gate could reject a bound exit after its helper disappeared
and then reject the helper startup itself. The pool now permits a narrow repair
context after `ManagedEgressHost.inspect` verifies the applied file and exit.
The desired row must match that applied configuration. Disabled exits and pending
removals cannot authorize repair. The context keeps ordinary readiness revoked,
counts as active work for drain, and expires when repair returns. Only work inside
that context can pass the managed admission check during bootstrap.

The server's repair callback handles only local exits with no live owned helper
process. Existing paused, incompatible, or ambiguous helpers remain unavailable.
After startup, helper status must pass before the pool publishes readiness. A
failed repair retains bindings and readiness stays revoked. Monitoring still
does not restart sing-box or apply desired configuration changes. Remote helper
bootstrap is not enabled by this local callback.

The native E2E stops the actual compiled helper while retaining a logical slot
binding. It checks that disabled state and unmatched desired edits deny repair,
a failed repair retains the binding, ordinary HTTP requests remain blocked during
repair, and the repair context holds a drain lease. A successful rebuild restores
helper control and existing DNS traffic without restarting the real shared
sing-box process. A live paused helper is preserved. Six native E2Es passed; the
Linux container check remains skipped and its receipt remains NOT RUN.

## Simultaneous local runtime and helper loss

`ManagedEgressHost.recover` now requests a recovery-specific drain lease. Normal
apply keeps its existing refusal when a bound helper is missing. During explicit
local recovery, the server can replace missing-helper drain evidence with a
concrete absence proof from `reserveAbsentManagedHelper`.

The proof requires the persisted helper config and PID record. The PID must no
longer exist in the current namespace. A responding private control socket denies
the proof. The controller must exclusively bind the configured TCP, DNS TCP, and
DNS UDP ports. These reservations remain held through shared-runtime recovery
and close when the lease releases. Any failed check closes partial reservations.
No lifecycle signal is sent to an unknown process. Missing provenance, PID reuse,
permission uncertainty, namespace command prefixes, and occupied ports fail closed.

The pool revokes ordinary readiness before explicit recovery. After the shared
runtime verifies, helper reconstruction can proceed. Recovery uses the verified
applied inbound and its matching stable listener credentials for bootstrap.
Pending outbound edits remain desired state and cannot become ready from this
repair. Normal health repair still requires a full desired/applied match. The
helper must pass its control check before the pool publishes matching readiness.

The native E2E stops both the real shared sing-box process and its bound compiled
helper. It retains a pending desired edit. Recovery reserves the absent helper's
ports, restores the applied routes, rebuilds the helper, retains the binding and
pending edit, and keeps that unverified desired version blocked. A live unrelated
PID and real unknown TCP/UDP listeners deny absence proof. After the desired row
matches again, both real routes work and ordinary admission resumes. Six native
E2Es passed. The Linux Docker E2E remains NOT RUN.

Remote slot binding and import remain guarded. Their host-side helper address
must remain the node-local listener rather than the control-plane bridge.
Slot caller resolution and the complete remote creation flow remain required.

## Verified initial remote binding and authoritative credential route

Managed placement now requires an exact slot-host match, an applied host version,
and a bridge owned by the current SSH connection. Forced binding cannot bypass
placement. Quota validation runs before detaching the previous binding.

The new managed binding operation serializes helper initialization with managed
configuration mutations. It commits the binding, initializes the helper under a
private maintenance context, and verifies runtime and helper state before reporting
success. Initialization failure retains the committed binding and revokes readiness.
The public bind and allocate routes call this operation. Legacy control-plane
helper entry points reject managed exits assigned to a remote host.

Credential resolution reads the authoritative pool binding. It does not trust a
saved bridge URL or an arbitrary override. Database reload and SSH reconnect revoke
readiness. Inspection must verify the new connection and bridge before admission
resumes. Admitted nested requests can still resolve the applied placement during
configuration checking and draining.

The real Linux ARM64 E2E passed in 118 seconds. It initializes two remote helpers
through the managed pool operation, verifies separate transparent exits, rejects
wrong-host and quota violations, retains a failed initialization binding, and sends
controlled credential POSTs through the selected bridges. Reload and SSH reconnect
must deny stale admission and restore the authoritative binding after inspection.
The receipt is `.tmp/managed-egress-e2e/linux-receipt.json`. Its recorded source
hashes match the current files. Six native E2Es and web TypeScript checking also
passed. The native Linux skip has its own NOT RUN receipt.

This is initial pool-binding and controlled credential-route evidence. It is not
successful full HTTP binding, complete gateway startup/rebind/restore, independent
physical-host enrollment, host reboot, real provider exchange, real Claude, or user
visual acceptance. Public managed rebind still requires full HTTP/runtime acceptance.
The ADR remains incomplete.

## Compose bootstrap failure scenarios

Before extending deployment acceptance, check these failures with the production
Compose files: a fresh empty data directory must initialize a valid private file;
repeated initialization must preserve existing bytes; invalid existing bytes must
remain unchanged and prevent service startup; a running service must use the
matching read-only directory; the ARM64 overlay must select its own data directory.
These checks must not start the gateway or any existing user service. They do not
prove the complete installer or deployed upgrade.

## Verified managed rebind and Compose bootstrap

The remote enable path no longer returns early merely because a managed helper
exists. It passes through configuration-digest verification and replaces a helper
whose listener or exit changed. The Linux E2E rebinds the first existing traffic
container to the second managed exit and back. Both observed routes match. The
second container keeps its assigned exit throughout. The complete Linux network
check passed in 130 seconds. This proves the pool operation and real helper path;
the public HTTP route and complete gateway VM lifecycle remain separate checks.

The new production Compose E2E starts only `sing-box-init` and `sing-box` in unique
fixture projects. Base and ARM64 overlay runs both create mode-0600 empty configs
inside mode-0700 directories, preserve existing bytes on repeat initialization,
and refuse invalid existing bytes without overwriting them. Docker inspection
checks host networking, the matching read-only directory mount, capability
removal, and absence of privilege. The receipt is
`.tmp/managed-egress-e2e/compose-receipt.json`. The test never starts the gateway,
an existing user container, the installer, or the upgrade program. Its scope does
not establish complete deployment or host-restart acceptance.

## HTTP binding acceptance failure scenarios

Before extending the network E2E, require a real gateway child process to import
and apply a controlled exit, reject a missing slot, initialize a previously absent
helper through the authenticated bind route, and report readiness only after
verification. The returned summary must omit listener credentials. A traffic
container attached to that helper's bridge must observe the selected upstream.
The gateway's inference mock does not prove VM startup or Claude forwarding.

A retained binding must also support an explicit initialization retry. Verify the
running applied exit and its complete desired configuration before authorizing
that retry. Pending edits, disabled exits, and pending removal must not authorize
helper setup. A failed retry must keep the binding and readiness revoked.

## Verified HTTP binding and retained-binding retry

The real Linux E2E now starts an authenticated gateway child process against its
own database and Docker runtime. HTTP import/apply/bind creates the actual local
helper, and transparent traffic observes the selected upstream. A missing slot is
rejected and public responses omit listener credentials. Inference remains mocked.
This does not start a complete gateway VM or prove real Claude forwarding.

The check first reproduced a retained-binding retry failure against the previous
pool implementation. `bindManaged` now verifies the running applied exit and the
complete desired row before admitting an explicit retry of the same saved binding.
The binding must still exist after asynchronous verification. Disabled rows,
pending removal, mismatched edits, and failed runtime verification remain blocked.
Both returned failures and thrown setup errors clear readiness and observed IP.

The HTTP check removes the test helper executable after stopping its owned helper.
Initialization fails with the binding retained and the exit unavailable. Restoring
the executable and retrying the same HTTP bind restores both readiness and the
selected transparent route. The remote pool check separately stages an outbound
edit and proves that setup never starts; restoring the applied configuration
permits the retained binding to retry. The complete Linux check passed in 150
seconds. Its receipt is `.tmp/managed-egress-e2e/linux-receipt.json`.

For the next full-slot acceptance step, the existing payload-fetch script obtained
all 15 files from the immutable manifest release
`payload-2026.11.01-codex-image-kernel`. Its existing check verified sizes and SHA-256
hashes under `.tmp/managed-egress-fullslot-payload`. These are verified inputs, not
slot-startup evidence. Future checks must use the current built helper for managed
egress rather than treating the released helper as the candidate implementation.

## Full local slot startup failure scenarios

Extend the authenticated HTTP check with the production Ubuntu slot image and
manifest-verified payload. Generate computer identity with the real pinned
`kin-computer` executable. Verify the started container's labels, mounts, image,
non-host network, actual kernel health socket, and controlled outbound source.
Stop and restart it through HTTP without changing its binding. A previously
failed retained binding must permit verified helper initialization during start.
Kernel process health must remain distinct from credential and real inference
readiness. Do not infer separate-host, host-reboot, or real Claude acceptance.

## Verified local gateway slot startup and helper recovery

`bindManagedVmExit` now owns the shared pool-to-VM snapshot and host-helper setup
flow. Both the public binding route and `powerOnSlot` use it. Startup looks for the
authoritative retained managed binding even when readiness is revoked. It uses
the existing verified retry mechanism before starting the runtime. Failed setup
returns a conflict and does not allocate an alternate exit. The operator recovery
flow also uses `powerOnSlot`.

The complete Linux E2E passed in 176 seconds. HTTP starts and restarts one real
Ubuntu slot using image
`sha256:5b22b8179ee7b88e85c4e331e37bb883ab9fd6602697a909f28088dbfc109d7a`
and manifest-verified payload. The actual private kernel health endpoint returns
200, and curl inside that slot observes the selected Hysteria source. Another
helper setup failure revokes readiness; the HTTP start request verifies the applied
row, rebuilds the helper, starts the real slot, and restores kernel health and the
same exit mapping. The receipt records image identity, AMD64 emulation on the
ARM64 host, source hashes, and the precise evidence scope.

The fixture pre-creates identity with the real pinned `kin-computer` program in
the production guest image. It uses the production 30-second
startup budget. An earlier four-second health observation ended while the process
was still running; no dead process or source-level kernel failure was established.
The longer observation passes. No credential is
used, so process health does not establish provider or real inference readiness.
Factory creation/reset/restore, two full gateway slots, and remote VM lifecycle
remain required. The user selected `ssh primaryserver` for independent-host work;
read-only identification confirmed Linux x86_64, root access, and Docker 29.9.2.
Existing `vm2api`, `kin-01`, and other containers are running there. Remote tests
must use an isolated directory and project and preserve those services. Host
reboot is a separate operation because it affects those running services.

## Independent remote-host failure scenarios

Run the control plane on this checkout and use the user-selected OpenSSH alias
for a different Linux Docker host. Pin its key from the existing known-hosts file.
Before implementation, require these failures to remain closed: an unknown SSH
key, unavailable configured identity, an existing test directory/name, occupied
listeners, wrong slot placement, stale SSH bridges after reconnect, stopped shared
runtime, and unavailable upstream. Keep every pre-existing container's ID, start
time, running state, and restart count unchanged. Cleanup may remove only matching
test labels or the test's uniquely labelled per-slot network/helper. Never restart
or redeploy the existing gateway. Do not infer host-reboot or full remote gateway
VM acceptance from two controlled helper traffic containers.

## Verified independent-host routes and recovery

The new `managed-egress-independent-host.e2e.test.mjs` passed in 284 seconds from
this macOS checkout to the user-selected `primaryserver` Linux AMD64 host. The
test uses the existing OpenSSH alias identity and a trusted Ed25519 host key.
It does not perform probe-mode trust enrollment or store private key contents in
artifacts. Its first run found a fixture ownership mismatch: the Ubuntu image's
default user could not read the root-owned origin directory. The controlled
origin now explicitly runs as the SSH user. The failed run cleaned its resources.

Two controlled Hysteria servers, an origin on the private Docker bridge, and one
separate managed sing-box project run on the actual remote host. The production
coordinator, SFTP file store, Compose runtime, SSH endpoint bridges, private helper
controls, pool binding, and real per-slot helpers all execute. Two traffic
containers observe `127.0.0.2` and `127.0.0.3` through their assigned exits.
Controlled credential POSTs from the macOS control process observe the same two
sources. Stopping the shared service revokes admission; checked recovery restores
it. A new SSH connection revokes the stale bridge, and inspection restores both
routes. Stopping one upstream fails that exit without an alternate response;
the other exit remains usable.

The receipt is `.tmp/managed-egress-e2e/independent-host-receipt.json`. It records
the selected alias, host-key verification, Docker/image/helper identity, source
hashes, observed exits, and scope. Cleanup validates resource labels, network/helper
placement, and the directory's owner marker. Every pre-existing running container
retains its ID, start time, running state, and restart count. This is container
instance-state evidence, not end-to-end acceptance for those other applications.
Temporary containers, networks, and directories are removed. Dependency image
caches remain available for repeat execution.

The test supplies an isolated host-facts adapter to the real coordinator. It does
not enroll a node through ClusterManager or exercise public remote HTTP binding.
Its traffic containers are actual helper clients, not complete remote gateway VMs.
Production deployment, complete remote VM startup/rebind/restore, host reboot,
provider credential exchange, real Claude, and user visual acceptance remain
separate required work. The ADR remains incomplete.

## Factory creation and rebuild failure scenarios

Before extending implementation, require the real HTTP factory to generate its
own computer identity and initialize a selected managed exit before startup.
Two complete local slots must observe separate controlled exits. Keep-mode and
traits-mode rebuilds must retain the selected exit and leave the other slot's
route usable. If helper setup fails during creation, keep the new VM and binding,
report the proxy error, and permit explicit retry after verification. A stopped
Codex slot still requires the actual transparent helper; a policy enable no-op
must not count as helper initialization. Reuse the existing ARM64 deployment's
AMD64 loader/library layout to execute the real pinned identity generator.

## Verified factory creation, rebuild, and automatic allocation

Managed factory binding now uses the same serialized helper initialization as the
explicit bind route. Automatic managed allocation verifies its selected helper
before publishing the binding. Managed creation and keep/traits rebuild enter
`powerOnSlot`, which verifies or repairs the retained managed binding and saves
the complete runtime record. Unmanaged creation/rebuild retain their existing path.
Local managed initialization calls the actual helper initializer for both Claude
and stopped Codex slots; policy enable alone cannot establish helper readiness.

The first factory check found that direct `startSlotReady` creation started the
kernel without saving explicit local socket paths. The initial fixture also
omitted `homeDir` from its execution context, so that failed health request did
not prove the normal business path was broken: `slotExec` supplies the directory
used by the existing local fallback. The final check uses the production
`slotExec` entry point and asserts explicit runtime metadata. Reusing
`powerOnSlot` saves that metadata consistently. The test preserves the
production identity program and uses the existing ARM64 deployment's AMD64 loader
layout in the acceptance image. It does not substitute generated identity fixtures
for the real factory.

The expanded Linux E2E passed in 224 seconds. Two complete local Ubuntu slots
retain separate observed exits and actual private kernel health. Both keep-mode
and traits-mode factory rebuild retain the selected exit; the other slot keeps
its route. A stopped Codex factory failure retains the VM and binding, reports
`proxy_error`, and permits verified helper initialization after executable
restoration. Automatic allocation selects a fresh managed exit that has no helper,
starts that helper, and verifies its actual transparent route. Six native E2Es
also pass; their Linux/Compose/independent-host skips retain separate NOT RUN
receipts and do not replace real passing results.

UI source now keeps role-redacted managed choices available for API validation,
filters visible managed placement in the creation selector, and uses exit labels
or IDs instead of hidden listener coordinates. TypeScript checking passes.
Visual acceptance remains user-owned and NOT RUN. The API still enforces the
authoritative host match; absence of public metadata never authorizes placement.

Full restore and actual public remote node/VM admission remain required. Actual
host discovery uses `$HOME/.vm2api`; a read-only check found that directory absent
on primaryserver. Revalidate that state before the next isolated enrollment test.
Host reboot, installed upgrade, real provider/Claude acceptance, and visual
acceptance remain incomplete. No production deployment or publication is implied.

## Restore edge to verify next

Source review identifies an unverified restore edge. `powerOnSlot` calls
`ensureBoundToVm` before deciding which managed initialization to run. If a saved
managed VM snapshot has no corresponding pool row or retained binding, the generic
preferred-exit lookup can reach automatic allocation. The full restore acceptance
must prove that this state cannot select a different exit. Use a real HTTP start
request with the saved managed snapshot, a missing or unavailable pool entry, and
another healthy exit available. Preserve the snapshot and reject startup. Also
prove that restoring the original valid exit permits verified recovery. This is
a source-review finding at this checkpoint; the targeted result follows below.

## Verified refusal of alternate allocation after partial restore

The real HTTP E2E reproduced the missing-row failure before the fix: startup
returned HTTP 200 instead of HTTP 409 and entered automatic allocation.
`powerOnSlot` now resolves the authoritative retained binding first. If no retained
binding exists, a saved managed snapshot pins its original exit ID. Missing or
disabled managed entries cannot enter generic allocation.

The expanded Linux E2E passed in 237 seconds. It stops the gateway, deletes only
the selected encrypted pool row, and restarts the gateway with its VM snapshot
intact. Startup returns HTTP 409 even with another usable exit available. The
saved proxy snapshot hash remains unchanged. Restoring the original encrypted row
as disabled, without its binding ledger, also refuses startup and preserves that
hash. Enabling the original exit permits startup, actual private kernel health,
and the original observed route. The receipt records hashes for the candidate
startup code and the test. Six native E2Es pass again; three environment-gated
checks skip without replacing their real passing receipts.

This verifies a partial database-restore boundary. It does not verify complete
backup/package restoration, remote public VM lifecycle, or host reboot. The ADR
remains incomplete.

## Public independent-host lifecycle failure scenarios

Before extending the independent-host check, verify these boundaries:

- Refuse execution if the actual discovered `$HOME/.vm2api` already exists.
- Pin the selected alias to the existing trusted SSH host key; never trust a probe alone.
- Enroll through the real gateway HTTP route and wait for actual Linux host discovery.
- Import and apply only on that enrolled node; never substitute control-plane placement.
- Build the real remote slot image through the existing public build route.
- Bind and start a real remote slot through HTTP; verify its container and private kernel health.
- Rebind through HTTP and verify the new transparent exit rather than only the saved mapping.
- Reconnect the enrolled node and verify the retained mapping and actual route after inspection.
- Keep production container identities, start times, running states, and restart counts unchanged.
- Clean only marked test directories and containers/networks with verified test placement.
- Preserve the distinction between controlled kernel/network evidence and provider or visual acceptance.

## Independent public startup transfer failure

The first public lifecycle check passed real pinned enrollment, host discovery,
remote import/apply, image construction, and initial binding. The first public
start request then failed at the HTTP client's response deadline. Runtime
observations showed repeated slot-binary publication using serial 32 KiB SFTP
writes. No successful remote startup is inferred from that run. Marker-checked
cleanup removed the test tree and containers; existing instances were preserved.

Before changing transfer scheduling, preserve these failure boundaries: writes
must use distinct offsets on the exclusive temporary handle; retain 32 KiB
requests; bound concurrent requests; settle every submitted write before closing
or deleting the temporary file after failure; never rename an incomplete file;
apply mode and ownership before rename. Existing destination bytes must survive
a failed write. A real SSH/SFTP E2E must verify exact bytes and failure cleanup.

Bounded concurrent SFTP writes preserve the exclusive temporary handle and atomic
rename. The real SSH/SFTP check passes multi-batch byte identity, rejected rename
preservation, temporary cleanup, modes, and symlink checks. The public lifecycle
rerun reaches a concrete Docker mount error instead of the client deadline.
That error identifies a fixture defect: the generic mock VM has no valid guest
machine ID, so its machine-ID source file is absent. The real remote mount then
fails. Use the existing workstation-fingerprint generator for the seeded VM.
This does not establish a defect in normal factory-created identity records.

## Verified public independent-host VM lifecycle

The final public lifecycle E2E passes in 351 seconds on `ssh primaryserver`.
The real gateway enrolls the node with the existing trusted SSH pin and discovers
its actual Linux host facts. Public HTTP imports and applies two controlled
Hysteria exits on that node. The public image-build route transfers the verified
Linux AMD64 payload and builds its real slot image. The seeded VM uses the
existing workstation-fingerprint generator. This verifies a supported persisted
VM record, not remote factory identity creation on the macOS control process.

Public HTTP binds, starts, stops, and rebinds that real Ubuntu VM. A separate
parent-process request waits within the normal 30-second budget for actual kernel
HTTP 200 over the production SSH relay; it refuses a mock response. Transparent
requests from the actual VM observe `127.0.0.2`, then `127.0.0.3` after rebind.
Restarting the test gateway preserves the selected exit and restores its route.
The applied and desired configuration versions match. The remotely published
helper's SHA256 matches the current cross-built executable.

The test validates marker/placement/labels before cleanup. The claimed
`/root/.vm2api` tree, upstream/origin fixtures, slot, helper, network, and shared
test service are removed. Every pre-existing running container retains its ID,
start time, running state, and restart count. The slot payload image is retained
as a cache. The passing sanitized artifact is
`.tmp/managed-egress-e2e/public-remote-receipt.json`.

The SFTP change keeps 32 KiB writes and bounds each batch to 16 requests. All
submitted writes settle before failure cleanup closes their handle. Mode and
ownership still precede atomic rename. The separate real SSH/SFTP E2E verifies
multi-batch byte identity, failed replacement preservation, and temporary cleanup.
The public startup check now completes under the client's unchanged deadline.

Complete backup/package restoration, installer/deployed upgrades, remote factory
creation, host reboot, real provider/Claude, and user visual acceptance remain
separate work. The ADR is not complete.

## SFTP change regression checkpoint

The affected Linux network/gateway E2E passes again in 189 seconds. The separate
independent-host pool/helper E2E passes again in 158 seconds. The real native
SSH/SFTP endpoint E2E also passes its expanded byte/preservation checks. Ten
current receipts contain 133 recorded source-file hashes; all match the current
worktree. Environment-gated NOT RUN receipts remain separate. The temporary
Linux runner and its marked volume were removed after receipt copy and label checks.
No production service replacement, host reboot, release, or visual acceptance
is implied.

## Installation and image-upgrade failure scenarios

Source review finds an image-upgrade gap: `panel-upgrade.sh` pulls the new gateway
image but retains the old Compose manifest. An older image installation therefore
does not acquire a newly introduced shared egress service through that path.
The command-line installer already downloads the tagged deployment files.

Before implementation and runtime acceptance, require these boundaries:

- Build and run the real production image, not the Linux acceptance-tool image.
- Obtain deployment assets from the exact selected target image; do not mix a mutable source branch with that image.
- Preserve `.env`, routing configuration, VM records, database secrets, proxy IDs, and bindings.
- Validate a staged manifest with existing overlays before replacing deployed files.
- Refuse an incomplete bundle without replacing the live manifest or gateway.
- Publish the initializer before the manifest that references it.
- Preserve compatibility with older target images that do not contain a deployment bundle.
- Do not restart an existing shared sing-box service merely to upgrade the gateway.
- A fresh empty installation must serve its authenticated API and run checked empty egress configuration.
- An actual container replacement must retain persisted IDs and bindings and verify real routed traffic afterward.
- Keep controlled release/registry transport evidence separate from published-release or real production upgrade evidence.
- The old release's already embedded upgrade helper cannot acquire new behavior retroactively; document the supported CLI transition for those releases.

## Verified production-image deployment transition

Both production Dockerfiles now package the release-owned Compose manifest and
managed initializer. `vm2api.deployment-bundle=1` declares that image contract.
The image-install branch of the panel helper extracts that bundle from the
selected pulled image, validates it with the existing overlays, and publishes
the initializer before the manifest. A target without the contract retains the
existing manifest. A declared but incomplete bundle fails before gateway
replacement. Existing shared sing-box instances use `--no-recreate`.

The final image-upgrade E2E passes in 58 seconds. Its baseline is the actual
production source at `568d1a01e12eb1cb7a18cf8a58775b29e8c358d1`; its candidate is
the current uncommitted implementation. Both images are built through the native
ARM64 production Dockerfile. The pinned AMD64 Ubuntu guest runs under the
existing emulation path. A private loopback registry supplies the real images
and a mirror of the exact cached guest. No API or inference mock is enabled.

The baseline creates an external SOCKS binding for a real running Ubuntu VM.
The actual panel shell helper then replaces the gateway container, adds the new
shared service from the image bundle, preserves the proxy ID/VM binding,
credentials, routing bytes, and operator overlay, and retains the observed
`127.0.0.2` route. Repeating gateway replacement leaves the shared container ID,
start time, and restart count unchanged. Anonymous API access stays HTTP 401;
authenticated requests succeed and the console HTML is available.

Selecting an older target without a bundle preserves the manifest, shared
instance, and supported legacy route. Restoring the candidate succeeds. Import,
apply, bind, and startup then route that actual VM through managed Hysteria to
`127.0.0.3`. A derived candidate with its required initializer removed fails the
upgrade before gateway replacement. The current manifest/initializer, shared
instance, and real managed route remain intact; staging directories are removed.
The receipt is `.tmp/managed-egress-e2e/image-upgrade-receipt.json`.

Earlier fixture failures are not production acceptance: an AMD64 control image
under local ARM64 emulation failed its nftables operation, so the final test uses
the existing native ARM64 control path. A loopback-only test origin addressed the
VM itself; the corrected origin uses the host's private Docker bridge address.
The rejected-bundle assertion compares shared-instance state immediately before
rejection, because the preceding intentional managed configuration apply restarts
that service. No production routing code was changed for those fixture issues.

The baseline and candidate currently share VERSION `1.4.042`. This proves real
source-baseline image replacement, migration/ledger preservation, and deployment
bootstrap, not a released-version upgrade. The complete CLI installer/download
path, fresh fleet installation, native AMD64 control runtime, full restoration,
host reboot, real provider/Claude, and visual acceptance remain separate work.
An older running release still embeds its old upgrade helper; use the documented
current-installer transition for the first release that introduces managed egress.

The final native suite passes six checks and skips five environment-gated checks.
Eleven current receipts contain 145 source-file hashes; every hash matches the
current worktree. Label-checked runner/volume cleanup and empty fixture-network
cleanup are complete. The unrelated local `napcat` container remains running.
Production images and dependency caches remain available for repeat execution.

## Verified full CLI installation and native AMD64 runtime

The full installer E2E passes in 112 seconds on native Linux AMD64. The authorized
`primaryserver` host runs a marked Docker-in-Docker container with a private Unix
socket, private data directory, bridge network, no published ports or TCP daemon
listener, and bounded CPU/memory. The inner daemon is Docker 27.5.1. Its host
network is the outer test container's network namespace. This isolates the
production host's existing container names, firewall rules, and deployment data.

The test executes the unmodified `deploy/install.sh install` dispatch with its
normal Compose pull/start, health probe, fleet-service refresh, and wrap sync.
Only tagged raw-release/API URLs are redirected by a curl executable wrapper to
an exact controlled source-file server. It still invokes the real curl binary.
Real production and guest images travel through an isolated loopback registry.
The preconfigured `.env` contains only non-secret image/guest mirror and fixture
inputs; the installer generates the API key and database secret itself. The file
mode is 0600. Preservation assertions compare hashes rather than credential bytes.

The installed fleet starts empty. The authenticated API and console HTML work;
anonymous proxy access returns HTTP 401. The checked shared sing-box configuration
has no listeners. Public HTTP then imports/applies a controlled Hysteria exit and
uses the actual factory to generate computer identity and start a real Ubuntu VM.
The actual kernel responds with HTTP 200 and VM traffic observes `127.0.0.3`.
No inference or API mock is enabled. Native AMD64 satisfies the pinned computer
executable's GLIBC requirements without changing production runtime code.

The real `upgrade` dispatch at the same version preserves generated credentials,
routing/configuration digests, the exit ID, the VM binding, and the running shared
instance. Actual kernel health and the selected route remain valid. Stopping the
shared service leaves the API available and makes routed traffic fail. Checked
recovery restores the same selected route. This is same-version CLI alignment,
not a published-version upgrade.

The sanitized runtime receipt is `.tmp/managed-egress-e2e/installer-receipt.json`.
`installer-host-receipt.json` links that receipt's hash and reproduction command
to the isolated daemon identity, cleanup, and outer-host before/after snapshots.
All nine pre-existing outer containers retain exactly the same ID, start time,
running state, and restart count. This proves instance-state preservation, not
functional acceptance of those unrelated applications. The empty inner runtime,
outer owner label, and mounts were checked before teardown. The daemon and its
marker-checked directory are removed. Official outer image caches remain.

Twelve runtime receipts contain 158 source-file hashes; all match the current
worktree. The new macOS environment gate skips without overwriting the runtime
PASS. No production implementation change was required for this phase. Global
ARM64 binfmt preparation, whole-host reboot, complete restoration, remote factory
creation, real provider/Claude, and user visual acceptance remain separate work.

## Managed backup-restore failure scenarios

Before implementation, exercise the real HTTP archive/restore path with all
fixture VMs stopped. Preserve the encrypted managed row, selected exit ID, listener
reservation, and VM binding. Change and apply the upstream after backup, then
restore the archive. A restored snapshot must not authorize startup against that
newer runtime. Explicit application of the restored desired configuration must
use the new SQLite connection, restore actual kernel health and its original
observed route, and leave the cluster read API usable. Do not infer complete
concurrent/remote/disaster restoration from this stopped local-fleet scenario.


## SQLite-holder restoration checkpoint

The real archive E2E reproduced a stale managed database holder: restoration
returned HTTP 200, but the next managed apply returned HTTP 409. The backup
service now awaits preparation and all rebind callbacks. Preparation pauses the
managed monitor and settles the existing managed mutation queue. The callback
replaces local managed settings, the cluster repository and SSH links, and remote
managed-host objects before resuming the monitor. New mutating panel requests
receive HTTP 503 during restoration. Older direct-link and host-discovery probes
cannot publish across the restored repository or connection identity.

The full Linux E2E passes in 243 seconds after this change. It creates a real
archive through HTTP, changes and applies an exit, restores the archive, refuses
startup against the newer runtime, explicitly applies the restored configuration,
and verifies the actual kernel and original transparent route. Existing local
factory, rebuild, helper, SSH, SFTP, Compose, drain, and recovery checks also pass.
The fresh Linux receipt contains 40 source-file hashes matching this checkout.
A shorter dedicated fixture volume satisfies the Linux Unix socket path limit.
The owned runner and volumes were removed after preserving the evidence.

This checkpoint covers a stopped local fleet on the same installation. The
extended primaryserver archive E2E also passes in 471 seconds. It verifies
rebuilt SSH connections, refusal of the newer runtime, explicit restored apply,
actual kernel health, the original route, gateway restart, and preservation of
all nine existing container instances. Its 22 source hashes match this checkout. Concurrent restoration,
disaster restoration, and VM package import/export remain unverified. Previous
image and installer receipts predate these server changes and cannot establish
current-source image acceptance.

## Managed VM package identity

A managed VM package now stores a typed reference to the existing exit:

```json
{
  "kind": "managed",
  "id": "px-example",
  "host_id": "control-plane",
  "label": "Example exit"
}
```

The package does not contain the internal SOCKS listener, listener credentials,
or the managed node's protocol credentials. The proxy pool provides stable
reference metadata without resolving a transient SSH bridge. Import requires the
existing exit ID and matching host. It checks ownership, enabled state, readiness,
and binding quota before generating identity files or replacing credentials.
Unknown proxy kinds and malformed references are rejected. The canonical managed
binding operation initializes and verifies the helper. Managed automatic startup
uses `powerOnSlot`, so successful startup persists the actual runtime paths.

A VM package does not provision or clone a host service. Restore the exit ledger
before importing its reference into another installation. The existing restriction
on writing packages back to remote VMs remains in force. A remote-host exit cannot
be silently rebound to a local VM.

Real Linux package write-back exposed a second identity boundary: a named VM's
numeric display name changed its derived Unix UID. The container changed from
UID 10001 to UID 10008 while its private telemetry directory remained owned by
10001 with mode 0700. An unchanged-UID network switch passed; the changed-UID
case failed actual kernel health. The runtime now reuses the UID in the existing
`runtime.user` field. Docker/SOCKS and runtime-file ownership use the same owner
resolver. Home-directory ownership lookup reads the VM ledger. Fresh imports do
not copy the original runtime record. No new identity field or recursive chown is
needed. The minimal real-container regression now passes with the changed name,
stable UID, actual kernel health, and the selected route.

The native HTTP/SQLite package E2E covers refused replacement, exact preservation
of VM and credential bytes, missing/disabled/unready exits, ownership, host
mismatch, malformed references, and existing external SOCKS/local write-back.
Web TypeScript checking passes. The final full Linux gate passes in 240 seconds.
It verifies new package creation through automatic startup, quota refusal before
a VM directory exists, actual imported kernel health and original route, package
write-back, deployed UID preservation, and the target kernel/route. It also
retains the complete local archive/SSH/helper coverage. Its 42 source-file hashes
match this checkout. This does not establish remote package write-back, disaster
restoration, real provider operations, or host reboot acceptance.


## Real remote factory and watchdog boundary

The public independent-host E2E now creates its VM through the real create API.
It executes the manifest-verified kin-computer payload on a Linux ARM64 controller
under the existing AMD64 emulation. The actual Linux AMD64 node container must
use the minted hostname and machine ID. The factory initializes the remote helper,
reuses the one shared service, and automatically starts the actual kernel through
the selected exit. No VM identity is seeded for this check.

The first two runs reproduced a concurrent-start failure. The create route saved
`running` before the container existed. The watchdog then entered powerOnSlot for
the same VM while the factory was still preparing the remote runtime. Repeated
managed binding revoked admission, and the original startup failed with
`managed_egress_not_ready`, despite a running helper and a ready SSH link. The
create route now saves `stopped` while preparation is pending. Its existing
successful-boot branch commits `running`. This keeps watchdog recovery available
for deployed VMs without authorizing recovery of an unfinished creation.

The full corrected E2E passes in 484 seconds with the actual watchdog enabled at
five-second intervals. It observes the pending record, verifies real computer
identity, kernel and routes, then exercises rebind, archive restoration and gateway
restart. All 27 recorded source hashes match. All nine original primaryserver
container instances are preserved. The controller is unprivileged and mounts only
the selected SSH key read-only; its host receipt records that boundary. The key is
not copied to primaryserver. Temporary production tracing is removed.

Current-source native checks, full Linux slot/package/archive/SSH acceptance,
ARM64 image replacement and full native AMD64 CLI installation/alignment all
pass after this lifecycle change. Thirteen receipts contain 190 matching
source-hash entries, with no stale recorded inputs. The CLI passes in 110 seconds
using the official pinned DinD initializer and a private cgroup namespace. All
nine original primaryserver instances are preserved; owned daemons, controllers,
volumes and marked data are removed. Whole-host reboot, real provider requests,
and user visual acceptance remain distinct unverified gates.

## Host reboot forwarding-rule recovery

Actual primaryserver reboot exposed a readiness defect. Docker restarted the
remote helper and slot kernel, but the host's custom iptables rules were absent.
Private helper/socket and kernel health alone incorrectly admitted traffic.
The real independent-host E2E now flushes only one owned slot NAT chain. It fails
before the correction and passes after verified routing repair, preserving both
selected exits. Remote readiness checks canonical labeled bridge rules. Existing
applied-config maintenance restores only the bound slot's existing rule plan.
Pending desired edits cannot authorize repair. No new dependencies or unit tests
were introduced.

The complete remote factory/archive/reboot E2E now passes in 672 seconds: changed Linux
boot ID, unchanged mapping/config hash, two actual kernel HTTP 200 responses and
both selected transparent routes without explicit fixture start/apply. Marked
persistent upstream files survive boot. Six original containers with no restart
policy are resumed in namespace dependency order; all nine retain IDs/policies.

Current-source checks pass: full Linux slot/package/archive/SSH: 238 seconds, native ARM64
image transition: 65 seconds, full native AMD64 CLI: 110 seconds with seven loaded-image source
hashes, and seven native cases with six explicit environment skips. Fourteen
runtime receipts contain 217 matching source entries and three valid host links.
Owned local/remote fixtures are removed. Earlier failed receipts retain failures.
Real provider/Claude and user visual acceptance remain missing; ADR not achieved.
