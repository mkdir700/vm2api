# Native Claude Code (server environment) acceptance

Status: isolated acceptance passed before production release. Deployment is recorded separately.

The console option is `原生 Claude Code（服务端环境）`. Its stable identifier is `native_server`. It uses the pinned CLI default core prompt and server context. Recognized automatic client environment sections and reminders are removed. Unknown custom prose, task paths, application instructions, images, external tool schemas, arguments, and results are retained. External tools still execute in the caller environment.

## Results

| Scenario | Result | Boundary |
| --- | --- | --- |
| Gateway settings and inference | PASS, 17 checks | Real HTTP; synthetic upstream |
| Full macOS chain | PASS, 59 checks | HTTP gateway, real API kernel, Hermit, pinned interactive CLI, isolated synthetic provider |
| Linux native and classifier | PASS, 61 checks | Hermit, pinned interactive CLI, isolated synthetic provider |
| Existing caller-environment policy | PASS, 48 checks | Pinned Linux native regression |
| Adjacent gateway E2E regressions | PASS, 2 tests | Environment switch and native failure ownership |
| Web production build | PASS | TypeScript and Vite |
| Real provider | NOT RUN | Separate authorization required |
| Production deployment | NOT RUN | Separate authorization required |
| Interactive visual UI acceptance | NOT RUN | Build evidence only |

The full chain covers initial requests, exact retained text and images, external tool continuation, malformed/missing/duplicate result rejection, changed and unknown policy rejection, stopped-owner restoration, tool-catalog growth, auxiliary requests, and owned process cleanup. The classifier consumes the private policy field before final provider serialization. Older Hermit runtimes fail capability validation before dispatch.

The unhooked interactive native baseline matches the entire 3554-byte core prompt in the main request. Its SHA-256 is `5f39da0c9d89df6e44e970da4e23e8fb5bb227bf43d21ecc5fedee213ef7b634`. Print mode has different session guidance and is not the baseline.

The attachment replay uses the observed native attachment schema with actual fixture cwd and platform. It verifies retention through the real native serializer. This is separate from claiming that a profile with disabled built-in tools naturally emits an environment attachment on every query.

## Evidence and reproduction

The immutable review bundle is `/tmp/vm2api-native-server-environment-20261111`. Its `receipt.json` contains executable, archive, and evidence hashes. `source.tar.gz` and `source-sha256.json` identify the exact dirty-source snapshot. `web-dist.tar.gz` contains the built console. Synthetic request captures, tool receipts, and native/API-kernel/baseline cleanup receipts are under `evidence/`.

Run `sh /tmp/vm2api-native-server-environment-20261111/reproduce-macos.sh /NEW/ABSOLUTE/OUTPUT` from this workspace. The output directory must be fresh. The Linux namespace command is in `reproduce-linux.sh`. The bundle is a review and reproduction package, not a standalone deployment image.

The new E2E files are `test/e2e/native-server-environment.e2e.test.mjs` and Hermit `experiment/native_server_environment_e2e.py`. The existing vm2api `test:e2e` glob discovers the gateway test. Native acceptance remains an explicit pinned-executable command and is not automatically enforced by that glob.

## Source and ownership

vm2api base: `f1e1e32a195c865b218c28b8f63ac65ccfd8df2e`. Hermit implementation source includes the independent screening fix at `366249bfe72b8ed306c5c376ca3256dd4aebbd47`. Hermit HEAD later advanced to `106f4ec99a9a24b98d9d77060dc2eb70bb1c85b0` through an unrelated documentation commit. The receipt records file hashes and binary identities rather than treating either HEAD as this uncommitted feature.

Existing unrelated operations documents, compatibility evidence, and history-recovery files remain untouched. This isolated acceptance did not operate on production processes, credentials, configuration, or active requests.

See [the extraction contract](native-server-environment-contract.md) and Hermit ADR 0061 for the policy boundary and its limitations.
