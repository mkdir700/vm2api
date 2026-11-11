# Native Claude Code server environment production deployment

Status: PASS. Verified at 2026-11-11T03:32:26.943231+00:00.

The new `原生 Claude Code（服务端环境）` option is deployed on primaryserver. The selected global preset remains `official_full`. This release did not automatically activate `native_server`.

## Identity

| Component | Fixed identity |
| --- | --- |
| vm2api source | `9dc97a07b7874f69fe29bba97ce65b1b87b1a190` |
| Controller image | `sha256:c3740128cdf8dd2f053f679c27ea9f41581d2f775f584fd134e275ac14c1dbd2` |
| Controller upgrade task | `1eb09e5d6a3243d1b5f173f8714c4488`: PASS / active |
| Hermit source | `173c0ac72cf513004d62af43c6f52fe0e0830801` |
| Active Hermit package | `0.0.0-production.native-server-173c0ac` |
| Native binary SHA-256 | `1a50d0ab71194cb26d43b0f1feaf45c3e8a89934dfb04464435b68d5dad5723a` |
| Native manifest SHA-256 | `61f729128366cf695eabb79ad965664eb54bd55555b010c4b7e5f2cf085a75df` |
| Native archive SHA-256 | `1bc4037dc3b6380d63cf31b68d4612f1282f39e25d888e3f05677a616c90f06b` |
| Native transition | `kernel-c7bc1a8a-1485-42bc-be60-6752dc20b74e`: finalized |

Both application commits exclude unrelated dirty documents. The native candidate was cross-compiled from clean source using Go 1.26.10, `CGO_ENABLED=0`, `-trimpath`, `-mod=readonly`, and `-buildvcs=true`. Official manifest and archive validators verified the thin package and every recorded source fingerprint. The pinned Linux CLI remains 2.1.318.

## Qualification and rollout

The exact image-exported source, Node, dependencies, API kernel, native binary, and package hooks passed four HTTP E2E tests, 17 gateway checks, 62 full native-chain checks, and 48 legacy-policy checks. The HTTP suite includes the previously committed compaction-cache behavior that was absent from the previous controller image.

All qualification containers used `network=none`, fresh synthetic configuration, read-only artifact inputs, writable synthetic runtime copies, and no production credentials or Docker socket. All containers, API-kernel processes, native owner groups, and direct-baseline processes stopped. The native core matched the unhooked interactive baseline.

The supported offline executor upgraded the controller and installed the new package. A task-specific scheduling hold remained in place across both stages. A fresh baseline after the controller upgrade governed the native switch. Apply and finalize succeeded through the existing management API. No force, pending-tool bypass, or active-request interruption was used.

Read-back matched the actual running native executable, CLI, tmux, all four hooks, selected package, controller image, served web assets, and `native_server_environment=true`. Account/proxy identity, credential bytes, global routing, unrelated containers, and controller environment/mounts during the native switch passed preservation checks. Original scheduling was restored.

Final health: accepting, healthy, 20 ready slots, zero active requests, zero pending tool results, and switch readiness true. These values describe the verification time.

## Preset semantics

An empty custom template falls back to the gateway's built-in official template. Hermit uses that assembled text as a replacement prompt. The new `native_server` policy instead retains the CLI-generated core, appends caller instructions, removes recognized automatic client context, and preserves server attachments. Unknown custom prose and external tool data remain caller content. External tools still execute in the caller environment.

## Evidence and limits

The machine-readable deployment receipt is stored beside this document. Full source, build, package, qualification, private baselines, rollout operations, and verification receipts remain at `/opt/vm2api-releases/native-server-env-173c0ac-9dc97a07` on primaryserver. Private baselines and executor backups were not downloaded. Prior controller/native release artifacts remain available for rollback; no production rollback was exercised.

The web option is present in deployed assets. Interactive visual acceptance is NOT RUN. Real-provider model inference is NOT RUN. No extra model request was sent by this deployment.
