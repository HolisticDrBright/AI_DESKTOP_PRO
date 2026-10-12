# Native lesson media preview delivery

This increment repairs a real SDK preview response that the media contract rejected and adds original-author video preview through the selected multipart ledger. It advances the original documents and media readiness scope. It does not authorize learner access, install a server host, apply a schema, enable a release, deploy a candidate or make either app commercial or PHI ready.

## Source and preserved authority

Branch: `agent/program-media-preview-delivery-20261011`. Deliberate parent: `1297022e40fbf4bac806a9315f6dc7b1d6e206d2`, the committed per-request orchestration and bounded metadata/binary handlers. The parent normal full suite completed with 477 files, 7,717 passing tests and 11 existing skips. [Parent CI 38198622656](https://github.com/HolisticDrBright/AI_DESKTOP_PRO/actions/runs/38198622656) succeeded on that exact head. Those results do not prove this successor. The parent's Windows standalone symlink warning remains; no standalone image or hosted media journey was qualified.

No candidate, registered manifest, shared program-reference mirror, operation inventory, template or release row changes. These LF-normalized SHA256 identities remain BLOCKED, unregistered and unapplied:

| Candidate | SHA256 |
| --- | --- |
| `program-media-ledger.sql` | `6dae2f237c13540b13cc3b7ecde877be104c35e59c7fddd9206130a62356a34d` |
| `program-media-settlement.sql` | `74f54bbb72539218dc6d12098a1773da572f4eb9230faae10010f69d5c95ff04` |
| `program-media-native-ledger.sql` | `69eb187cd22500014c1b79bf5dfdc7577e1c18376f30197eded0804f9114a6d7` |
| `program-media-multipart.sql` | `a9b2a38d76f7a07569ed94342cc53a7810c6480ba6f28e0a24297265e9f70092` |

Earlier fictional schema-upgrade approvals do not approve these candidates, storage policies or media activation. The original-author fence in SQL and the SDK remains unchanged. This is not a team-preview or learner-delivery permission.

## Preview contract repair

The actual installed AWS SDK produced a signed URL of 1,736 characters under fictional explicit temporary credentials, while `programMediaPreview.previewToken` allowed only 512. The regression test failed against the parent contract even though the SDK had signed the exact intended version. No network or AWS account was used for that reproduction.

`PROGRAM_MEDIA_PREVIEW_MAX_TOKEN_LENGTH` now bounds the ephemeral capability at 16,384 characters. The response shape is unchanged. The limit admits URL encoding of the configured temporary-token and version lengths; it does not admit arbitrary storage endpoints, persistent curriculum URLs, writer proof or private identity fields. An actual SDK test signs a URL over 9,000 characters using the maximum configured fictional temporary token, and the real response schema accepts it. A token exceeding the new ceiling is refused.

`aws-program-media-preview.ts` is the shared exact-version signer for the existing single-PUT and new multipart paths. It verifies HTTPS, the exact regional bucket hostname, exact decoded object key, one exact version, five-minute expiry, signing time, algorithm, response type and no-store directive, and one well-shaped signature. It refuses credentials in the authority, ports, fragments, substituted paths/versions and duplicate version parameters. Ignored signing waits stop returning after withdrawal and late promise rejection remains observed. The helper grants no author or learner authority and performs no mutation.

The single-PUT reader still requires `FULL_OBJECT` integrity. It does not treat a multipart `COMPOSITE` digest as the whole-file hash. That negative test covers already-correct protection, not a second runtime defect.

## Multipart original-author read

`aws-program-media-multipart-store.ts` exposes a distinct `preview` read. A session must be committed, have every recorded part and no pending writer, and remain bound to the original actor, clinic, program and exact artifact. The artifact must be ready or retired, and its object key, version, total bytes, type and SHA256 must agree with the session. Neither write admission nor original-actor checks were broadened.

Before signing, the reader checks actual SDK HEAD and GET observations: exact version, SSE-KMS identity, media metadata, writer claim, composite checksum, each streamed part and the whole-file digest and byte count. Reads are bounded and the body is discarded on failure or withdrawal. Preview sends no PUT, multipart mutation, delete, settlement, cleanup or publication request. A retired version is explicitly historical; it is not republished.

`program-media-multipart-preview-request.ts` composes this port with the selected restricted native and multipart SQL ledgers. It is OFF by default. One deadline covers host-context resolution, database reads, scoped credentials, resource inspection, integrity verification, signing and the final checks. The host must independently verify current workforce MFA; the caller cannot supply actor, clinic, role, review hash, provider version or proof in the command.

The source rechecks the active native release and storage, program authority, artifact and committed multipart state before provider access. After signing it resolves current identity again, rechecks release/storage, rereads the exact artifact and checks the original-author session. A changed identity, suspended membership, disabled release or changed artifact discards the capability instead of returning it. SQL calls stay short and storage calls run outside transactions. Opened and late-opening stores are closed.

The existing bounded metadata handler can deliver this response. Its body contains the artifact's public preview fields and the short-lived capability, not separate object key, provider version, writer claim or credentials. A signer error is a failure, not a ready-looking preview.

## Capability limitations

A signed URL is a bearer capability. This source rechecks authority before issuing it but does not instantly revoke a URL already returned when membership later changes. It remains constrained by its expiry, underlying credentials and storage policy. It must never enter logs, analytics, a published curriculum or a persistent media reference. [AWS documents these presigned-URL limits](https://docs.aws.amazon.com/AmazonS3/latest/userguide/using-presigned-url.html).

The integrity read streams the entire video before signing. The configured maximum is 256 MiB and the request deadline is at most 30 seconds. Actual transfer timing and cost at that bound remain hosted qualification, not proven performance. The preview flow requests SSE-KMS checksums and must have the appropriate reviewed key permissions; a 403 is never absence. [AWS HEAD requirements](https://docs.aws.amazon.com/AmazonS3/latest/API/API_HeadObject.html) remain real-store acceptance inputs.

## Local verification and failed drafts

The four focused files passed 174 tests with no skips, followed by a clean typecheck and changed-file lint. Coverage includes 37 single-PUT SDK cases, 66 multipart SDK cases, 18 shared-signer cases and 53 actual-ledger/request cases. The ledger suite applies the real 106-migration production artifact plus the four pinned candidates in PGlite. It asserts the reduced worker as both current and session user during source calls; local operator reset is fixture setup, not a hosted privilege or contention proof.

Three new combined cases use the actual SQL authority, actual SDK resource/HEAD/GET/signing code and real Request/Response metadata handler. The provider transport is intercepted with strict fictional responses computed from the committed fixture bytes. An unexpected command fails rather than contacting a network. A valid exact-version capability reaches the HTTP response; changed writer metadata and changed bytes do not. This is combined local integration, not AWS or device evidence, and SDK transport interception does not prove real middleware/IAM behavior.

Earlier drafts are retained as failures: the first artifact assertion expected version 1 although commit produces version 2; the withdrawal fixture attempted the invalid membership state `revoked`, so its database update failed before withdrawal; diagnostic tracing identified that error and the fixture now uses the real `suspended` state. The fictional Data API transport also uses the unchanged production rejection mapper. No authorization check was relaxed. The new combined test initially had an arrow-function cast syntax error, and the historical-read fixture initially omitted the existing retire timestamp argument; both were corrected. No acceptance case was removed, retried to obtain a pass, given a longer timeout or recategorized as a production defect.

The broader media suite passed 431 tests across 18 files with no skips. Mock-import, identity/consent, authenticated API, Desktop compatibility, operation inventory, production clinical-core and stub-reset gates passed. The inventory remains 228 activation-blocked operations and zero enabled; the production artifact remains 106 migrations and zero seeded rows. The first gate sequence stopped after three passing gates because its next script name was mistyped; the corrected sequence used the repository's actual script names and all seven exited successfully. No gate was added or weakened.

The local AST-only graph update completed with 18,325 nodes and 47,582 edges. The normal full suite, full lint, clinical build, strict client scan and exact-head CI are separate frozen-source checks. Record their terminal results before calling this successor fully source-verified. Focused passes are not a commercial-readiness audit.

## Remaining engineering and qualification

| Requirement | Current state |
| --- | --- |
| Bounded genuine signed-URL response | Implemented and focused locally verified |
| Original-author multipart preview with final access checks | Implemented and combined locally verified with fictional transport |
| Reviewed MFA host, restricted database credentials and scoped STS factory | Not installed; required before native use |
| Studio upload, resume and recovery controls | Required |
| Team authority and learner read-only media delivery | Required separately; original-author preview does not grant either |
| Mirrored V2 media-reference successor and player | Required |
| Unknown initiation drain and scheduled retention | Still held pending complete authority and operating design |
| Candidate custody, reviewed storage/IAM and hosted acceptance | Unobserved; activation remains OFF |
| Matched API/Desktop/mobile and physical acceptance | Unobserved; paid builds still require separate authorization |
| Commercial and PHI readiness | Not achieved |

Next install the trusted native host and bounded routes, finish Studio controls and the distinct learner authority/reference path, then obtain candidate/resource reviews and qualify real services. Preserve Claude's parallel commerce branch and return additive overlap rather than overwriting it. Commercial terms, practitioner and patient data permissions, clinical holds, source verification, measured inputs, child/guardian deferral and free recovery of existing personal data are unchanged.

No AWS write, secret retrieval, real provider call, candidate application, review approval, deployment, activation, mobile build/upload, main merge, PR, force-push or PHI enablement occurs in this increment. All six original readiness scopes remain open. Graphify updates are local AST-only; the shared canvas is untouched.
