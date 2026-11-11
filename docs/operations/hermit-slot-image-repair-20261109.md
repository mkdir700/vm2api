# Hermit guest-image preparation

## Problem

The control-plane release and the guest-image release are independent. A successful pull of `kin-os-ubuntu:24.04` did not prove that the image met the installed Hermit package requirements. The production image lacked `/usr/bin/tmux`.

## Behavior

Before stopping a slot for a Hermit transition, vm2api prepares a guest image. It checks Ubuntu version, architecture, glibc version, and the tmux SHA-256 declared by the installed package. The check runs in a temporary container with no network and no production mounts.

vm2api reuses a qualified local image. If no local image qualifies, vm2api builds the shipped Ubuntu Dockerfile under a separate local tag. The tag depends on the Dockerfile and the package environment requirements. The Dockerfile installs the fixed tmux version and checks its digest. vm2api validates the resulting image again.

The transition creates the slot with the qualified immutable image ID. It does not pull the mutable Ubuntu tag again. Pending external tools are rejected before preparing another Hermit image. Readiness is checked again after drain. Preparation errors leave the current slot running. Preparation does not change the global Ubuntu image tag. Startup failures retain their specific error message and transition error code.

Only local Linux AMD64 Ubuntu 24.04 Docker slots are supported. This change does not install packages inside a running slot.

## Verification

The real Docker reproducer first failed against the original control image: image preparation succeeded, but the pinned-tmux assertion failed. The repair passed image construction, tmux digest verification, immutable image selection, cache reuse, invalid digest rejection, original-container preservation, and cleanup checks.

The repeatable driver is `test/e2e/hermit-slot-image.mjs`. Run it in a Linux control image with Docker access:

```sh
node test/e2e/hermit-slot-image.mjs <new-evidence-directory> <public-Hermit-manifest.json>
```

The driver saves `prepared.json`, `checks.json`, and `summary.json`. It uses a disposable container without production data or credentials. Full control-image acceptance and production rollout receipts are recorded separately.

## Final results

| Verification | Result |
| --- | --- |
| Real Docker image preparation | PASS, 7 checks |
| Current worktree shared install HTTP endpoint | PASS, 34 checks |
| Complete candidate control image, OAuth | PASS, 129 checks |
| Complete candidate control image, API Key | PASS, 153 checks |
| Frozen sources and isolated fixture cleanup | PASS |
| Production control image and slot container unchanged | PASS |
| Original production kernel health | PASS |
| Real-account inference | NOT RUN |
| Production deployment or slot activation | NOT RUN |

The complete-image tests used source `e98b338b07c601512ebc17cdc0b681778a43ebbe`, candidate control image `sha256:9f753e597af40da52698a42a27253ce938edea0aeab6ed1c0c2724ab1dc5faaa`, and guest image `sha256:47be124603b9f6f1484f25610697734f0d24d82a1a63b75ea7caa33ac5e632e8`. These are verification artifacts. They were not deployed.

The server evidence directory is `/tmp/hermit-slot-image-repair-20261109`. `verification.json` records source hashes, image identities, test results, cleanup results, and unchanged production identities. `args-final-oauth.json` and `args-final-apikey.json` retain replay arguments. Use a new output directory when replaying them. Initial failed runs remain available for diagnosis.

The current worktree installer check separately verifies compatibility with the single-package API. Its source hashes match the local repair files. A local copy of the final receipt is `.tmp/hermit-slot-image-repair/verification.json`.
