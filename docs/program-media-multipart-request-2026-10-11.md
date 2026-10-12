# Native multipart request orchestration and bounded upload handlers

This source increment continues the original documents and media readiness scope. It composes the selected restricted SQL ledger and S3 adapter into one per-request upload workflow, with separate metadata and binary handlers. It does not install a host, publish a route, create resources, apply SQL, enable a release or qualify a hosted upload. All activation remains OFF by default and PHI remains disabled.

## Source identity and preserved candidates

Branch: `agent/program-media-multipart-request-20261011`. Deliberate base: `7607c7d0432193be60e4f6a98482c7b7a77887e1`, the native multipart storage source. The selected lineage is `66fa018` → `8f06c84` → `0640c8d` → `772ff9b` → `363a7c8` → `7607c7d`. Claude's independent repair remains evidence only.

No candidate bytes, registered manifest, shared mirror, operation inventory, infrastructure template, release row or custody artifact changes in this increment. These LF-normalized SHA256 identities remain BLOCKED, unregistered and unapplied:

| Candidate | SHA256 |
| --- | --- |
| `program-media-ledger.sql` | `6dae2f237c13540b13cc3b7ecde877be104c35e59c7fddd9206130a62356a34d` |
| `program-media-settlement.sql` | `74f54bbb72539218dc6d12098a1773da572f4eb9230faae10010f69d5c95ff04` |
| `program-media-native-ledger.sql` | `69eb187cd22500014c1b79bf5dfdc7577e1c18376f30197eded0804f9114a6d7` |
| `program-media-multipart.sql` | `a9b2a38d76f7a07569ed94342cc53a7810c6480ba6f28e0a24297265e9f70092` |

The earlier approvals for fictional qualification schema upgrades do not approve these candidates, resource policies or any media/provider activation.

## Trusted request composition

`src/server/programs/program-media-multipart-request.ts` exports `createProgramMediaMultipartRequestSource`. A reviewed host supplies a restricted database, current MFA workforce context resolver, program-scoped temporary-credential dependency, the exact native and multipart release identities, and a separate multipart resource-policy review. The source captures functions and reviewed values at construction, and captures the command and mutable bytes before asynchronous work. A digest supplied by a caller is not a review or deployment approval.

The source rechecks the native configuration, artifact ownership, current program authority and multipart release through SQL before provider access. The host remains responsible for authenticating the caller and constructing that context independently. No public identity field or freely settable database session value substitutes for a reviewed authenticated host.

The browser-shaped command set is deliberately closed: `start`, `status`, `create`, `part`, `complete`, `reconcile`, `cancel`, `cleanup`. A command id is an idempotency key only. Actor, clinic, credentials, provider ids, release evidence, receipts, verification proofs and absence certificates cannot enter through this contract. Internal ledger proof operations are not exposed.

The public view carries artifact id, media type, total bytes, whole-file digest, state, deadline, received parts, pending parts and whether work remains pending. It carries no actor, clinic, object key, upload id, version, attempt claim or credential. Parts must be unique, within the file's actual part count and disjoint between received and pending. Pending parts cannot be reported as settled. A committed view requires every part received and no pending writer. An inconsistent reply is refused, not presented as progress.

## Admission and recovery

Every provider mutation follows a durable first SQL admission. A reused command never issues another mutation. SQL transactions remain short; all SDK work occurs outside them. One request deadline covers authentication, database calls, credential resolution, provider I/O and receipt recording. Late-opening stores are closed. Ignored cancellation cannot indefinitely hold the request open, but cancellation is not a remote settlement receipt.

Creation records the provider upload receipt under its admitted claim. Parts are measured against the immutable recipe before admission. Completion records its version/composite receipt, then separately verifies the exact object's metadata, writer, composite checksum, every part and whole-file bytes before commit. Receipt persistence failure retains the admitted writer for recovery rather than creating a replacement.

Recovery of known parts uses a complete bounded provider parts listing and records only the exact pending receipt. Recovery of a completion requires one candidate version at the exact key, then actual metadata and streamed-byte verification. An ambiguous version or denied/incomplete observation remains held. A completion already recorded is not reclassified or sent again when later verification fails.

An unknown initiation is never adopted from a key or upload count: upload listings do not provide the initiating metadata this source needs. It remains pending. Time passing, a timeout, a stopped HTTP request or an empty HEAD cannot authorize re-creation or certify that writer stopped. Separately reviewed drain/recovery for that state remains an integration requirement.

Cancellation fences subsequent creation, parts and completion. A previously admitted writer's late receipt may settle under retained authority, but it cannot commit a cancelled artifact. Cleanup makes no destructive request while any writer remains open or uncertain. After settlement it inventories, aborts exact uploads and deletes exact versions, inventories again and certifies only a complete empty result. A denied abort, denied listing or remaining object cannot certify deletion.

## Separate metadata and binary handlers

`src/server/programs/program-media-multipart-http.ts` exports `createProgramMediaMultipartHandler`, also disabled unless explicitly configured. It defines source handlers for:

- POST `/api/live/programs/media/multipart/control`: strict JSON, at most 64 KiB, no inline part body or internal proof command.
- PUT `/api/live/programs/media/multipart/part/<artifactId>/<partNumber>/<commandId>`: actual octet-stream, at most 8 MiB per part, no JSON/base64 envelope.

Only canonical paths and ids are admitted; query/fragment variants, foreign browser origins, missing Host/Origin and spoofed forwarded hosts are refused. The existing same-browser-origin helper is unchanged. Format, encoding and length checks happen before host authentication.

The host authorizes before reading either body. For a binary part, `admitPartBody` reads current SQL ownership and the immutable recipe before receiving bytes. It admits body reception, not provider mutation. The bounded reader requires exact length and SHA256. The native source then independently rechecks current authority and admits the first provider write. Withdrawing membership while the body is read cannot create a part attempt or provider write.

Replies are strict, bounded, private/no-store and contain only sanitized failure categories. Missing data or a service failure is not successful empty progress. An uncertain part may return an honest pending view, never a claimed received receipt. An actual host must support binary 8 MiB requests; API Gateway/Lambda JSON/base64 limits are not assumed sufficient.

## Reproductions and local verification

The initial combined HTTP/database run failed 13 of 57 cases because the new test Request fixtures omitted the required Host header, including the positive flow. The fixtures now match the existing browser boundary, and additional missing-host, missing-origin and forwarded-host negatives preserve that boundary. No production origin check was relaxed.

The fixture SQL connection initially remained in its reduced session after COMMIT because of an independently reproduced PGlite behavior. Fixture setup now explicitly restores only its original local operator connection; every source transaction independently asserts both `current_user` and `session_user` are `program_media_worker`. This does not prove actual PostgreSQL role-assumption or contention behavior. Those require hosted qualification.

Per-test programs isolate content because the selected native ledger intentionally refuses duplicate committed bytes within the same program. An explicit same-program negative preserves that rule; the constraint was not removed. One later test queried a nonexistent `admitted_at` column; it now uses the actual `started_at` column. Type errors in the new HTTP fixtures were corrected without removing assertions or changing the source contract.

Seven negative progress cases failed against the initial new view parser, which accepted duplicate parts, parts outside the file, received/pending overlap, contradictory pending flags and incomplete or pending committed views. They pass after the view consistency checks. This is a defect in this unshipped source increment, not a claim of a hosted incident.

Observed focused verification before final source freeze:

- 36 restricted-SQL request cases and 32 HTTP cases passed together, 68 total. They include real Request/Response metadata plus 8 MiB and final-part bodies through the actual SQL artifacts, with a fictional store computing receipts from bytes.
- The complete focused media run passed 376 cases across 17 contract, ledger, SQL, request, HTTP, S3 adapter, SDK middleware, role and parts files. No focused case was skipped.
- Current typecheck and changed-file lint passed. Earlier failed drafts and fixture errors are retained above; no test timeout was increased and no case was skipped or retried to manufacture these totals.
- The SQL suite applies the real 106-migration production artifact and all four byte-pinned media candidates in a local PGlite database. Provider I/O assertions require execution outside a database transaction. It covers lost receipt before and after commit, fresh-source recovery, both late part/completion cancellation journeys, authority withdrawal during body reading and provider I/O, credential-scope/store substitution, definitive pre-send failure, denied cleanup and ignored deadlines.
- The parent SDK suites separately exercise actual SDK serialization and middleware with fictional transports. The request database suite replaces the SDK factory with a byte-measuring fictional store; it does not prove a combined real-SDK/SQL hosted flow.
- Mock-import, identity/consent, authenticated API, compatibility, operation-inventory, production-core and stub-reset source gates passed. The artifact still has 106 migrations and zero seeded rows; the inventory still has 228 activation-blocked operations and zero enabled. These gates do not activate or hosted-verify any service.

Final checks for this increment at exact committed head `1297022e40fbf4bac806a9315f6dc7b1d6e206d2` subsequently completed: the normal full suite passed 477 files and 7,717 tests with 11 existing skips; full lint, clinical build and strict client scan passed. The Windows standalone symlink warning remains, so no deployable standalone image is proven. [Exact-head CI 38198622656](https://github.com/HolisticDrBright/AI_DESKTOP_PRO/actions/runs/38198622656) succeeded. These results do not prove a later successor, hosted deployment, a secrets-gated provider positive or physical-device acceptance. The next preview source and its separate verification are documented in `docs/program-media-preview-delivery-2026-10-11.md`.

## Status and remaining engineering

| Layer | Status |
| --- | --- |
| Native per-request composition and bounded handlers | Implemented; 68 focused local cases pass |
| Restricted native ledger and actual SDK adapter | Selected predecessor preserved; new composition tested locally with fictional provider bytes |
| Installed MFA host, restricted credential factory and routes | Not implemented by this increment; disabled source seams only |
| Studio upload, resume and recovery controls | Still required |
| Multipart preview and V2 read-only media reference | Still required; single-PUT FULL_OBJECT preview must not be relaxed to admit COMPOSITE |
| Reviewed resources, schema activation and retention | Held; no registration or deployment |
| Real STS/S3/KMS and physical-device acceptance | Unobserved |
| PHI or commercial readiness | Not achieved by this increment |

Next engineering is to install the reviewed host composition without exposing proofs, build Studio upload/resume controls, and implement the distinct trusted COMPOSITE delivery seam and mirrored V2 reference. Recovery for unknown initiation must remain visibly held until its writer-drain design is reviewed. Independent scheduled retention and a recovery identity cannot be invented from the ordinary author's session.

Then review exact bucket/KMS/IAM policies and candidate custody; qualify actual checksums, provider observations, IAM denials, writer races and post-settlement absence in the isolated target; reconcile deliberate source pairs and release kits; and qualify matched API/Desktop/mobile candidates with rollback. Physical iOS/Android acceptance and paid-build authorization remain separate gates. No AWS access, secret retrieval, provider contact, activation, paid build, mobile upload, deployment, main merge, PR, force-push or PHI enablement occurs in this increment.

All six original commercial-readiness scopes remain open. This increment advances documents/media custody, not identity/plan continuity, the complete privacy/retention operating model, clinical knowledge activation, commerce/provider acceptance or matched-release/device qualification. Preserve clinical holds, source verification, measured inputs, child/guardian deferral, free recovery of existing data and Core launch restrictions. Graphify uses local AST-only updates; the shared canvas is untouched.
