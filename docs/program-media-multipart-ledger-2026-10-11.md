# Durable lesson video upload ledger

This source increment adds the native database authority for resumable lesson-video uploads on `agent/program-media-multipart-ledger-20261011`, based on exact Desktop `772ff9bc8d5ec9cec78ac813422d353c178824e3`. It advances media custody and release qualification inside the original readiness scopes. It does not install routes, perform an S3 multipart upload, approve a schema upgrade, deliver a video to V2, or activate commercial/PHI use.

## Exact source and activation boundary

`infra/aws-clinical-core/source-candidates/program-media-multipart.sql` is a distinct BLOCKED, unregistered, unapplied candidate. Its LF-byte SHA256 is `a9b2a38d76f7a07569ed94342cc53a7810c6480ba6f28e0a24297265e9f70092`. Its exact native parent is `69eb187cd22500014c1b79bf5dfdc7577e1c18376f30197eded0804f9114a6d7`, on the preserved ledger `6dae2f237c13540b13cc3b7ecde877be104c35e59c7fddd9206130a62356a34d` and selected settlement `74f54bbb72539218dc6d12098a1773da572f4eb9230faae10010f69d5c95ff04`. Those three parent files are unchanged. Claude's alternative settlement is not included.

The candidate adds `multipart_enabled=false` and a separate multipart evidence digest to the existing activation row. Each call also rechecks the native parent release and current authority. The new completeness constraint permits the existing operator to disable the parent independently; an enabled multipart flag cannot override a disabled parent. No reviewed release value, credential or login role is seeded.

Embedded tests apply the real 47-migration synthetic artifact and exact blocked parents, then this source. That is not the hosted qualification assembly or an approved preserving upgrade. The unchanged production artifact still has 106 migrations and zero seeded rows. No installed migration or production activation mapping is added.

The frozen predecessor has independently observed exact CI [38188473090](https://github.com/HolisticDrBright/AI_DESKTOP_PRO/actions/runs/38188473090) SUCCESS and a normal local suite of 471 files, 7,556 passed tests and 11 existing skips. Its clinical build's Windows standalone dependency-junction copy warning means that local package is not a qualified deployment artifact. Predecessor evidence does not automatically qualify this successor.

## Restricted native authority

`src/server/programs/program-media-multipart-ledger.ts` exposes `createProgramMediaMultipartLedger` under `program-media-multipart-ledger/1`. It is an internal server port, not a browser command or mounted route. It is unavailable without a reviewed native storage release and separately enabled multipart evidence.

The closed SQL entry point is `clinical_core.program_media_multipart_request(jsonb)`. The existing non-login worker receives only EXECUTE on that family, not raw-table or private-helper access and not membership in the non-superuser, non-bypass authority role. New private tables use FORCE RLS. Every operation resolves the immutable author, active workforce identity and clinic membership, current program/artifact, native release and multipart review before proceeding. Authority/release/program/artifact locks precede multipart locks; provider I/O remains outside each short database transaction.

The adapter snapshots context, command and reviewed release before awaiting the database. It verifies reply actor, clinic, artifact, key, media type, ordered part recipe, composite checksum, provider receipts and the exact pending claim before the transaction can commit. A newly granted creation, part or completion must match its operation and current upload stage. Malformed replies remain unavailable, with no raw provider or database text returned. Synthetic-only context is required; consumer context, real patient data, PHI and production context are refused.

The existing RDS Data API worker helper can execute this closed family once its separately reviewed candidate and role are installed. No host credential, live MFA resolver or Data API session is installed by this increment.

## Durable upload state

The ledger retains one immutable ordered manifest and native writer fence per artifact. The full 256 MiB ceiling remains at most 32 parts of 8 MiB; all non-final parts must have exactly 8 MiB. The manifest stores measured size and SHA256 per part as well as the reservation's independently bound whole-file size/SHA256. Provider IDs and recorded object versions cannot be replaced.

The twelve closed operations are start, status, admitCreation, recordUpload, admitPart, recordPart, admitCompletion, recordCompletion, settleAttempt, cancel, commit and certifyAbort. The eleven non-status commands carry append-only, operator-attributed request/review audit records; identical receipt replays do not add a second audit row.

| Stage | Authority and observation |
| --- | --- |
| prepared | Manifest and parent writer are durable; no provider creation is authorized until its own attempt is admitted. |
| creation admitted | Only the first matching `admitted:true` authorizes initiation. Lost replies remain open/uncertain; replay is not permission to create again. |
| uploading | Exact upload ID is recorded. Each part has its own durable claim and exact measured receipt; duplicate part receipts are idempotent, substitutions refuse. |
| completion admitted | Every manifest part is recorded and every earlier writer is settled. Ordered receipts authorize one completion attempt. |
| verifying | Exact returned version and composite checksum are saved; the artifact remains reserved, not ready. |
| committed | A qualified host's bounded whole-file observation must match version, composite checksum, full SHA256 and size before the native ready transition and parent settlement. |
| abort requested | No fresh part/completion is admitted. Previously admitted late creation, part and completion receipts remain recordable and their objects remain subject to cleanup. |
| aborted | All writers are settled and a complete exact-key upload/version listing proves absence after settlement. Only then is the parent fence released. This is not a normal artifact deletion receipt. |

Unknown attempts never expire themselves or become permission to resend. Only a definitive not-sent/pre-mutation failure releases a failed attempt; uncertainty cannot be relabeled as not sent. Current authorization loss refuses the call and preserves unresolved work. A privileged recovery operator for a withdrawn original author is still an explicitly reviewed host/authority dependency, not impersonation built into this source.

Existing native entry points cannot bypass this ledger: whole-file commit before multipart verification, early parent settlement, and a competing writer while the upload is nonterminal are refused. Composite SHA256 is not whole-file SHA256. This ledger checks a host observation receipt; it does not itself read S3 or prove the observed bytes. Those observations must never be accepted from the browser.

## Negative tests and local evidence

New source contains 20 embedded-database cases and 19 adapter cases. The database cases use the actual synthetic artifact and candidate under `program_media_worker`, not a mocked ledger. Independent, identical-artifact connections lower session authorization for role-assumption probes so retained superuser fixture identity cannot make an unauthorized role switch appear permissible.

Reproductions and repairs are kept distinct:

- The initial new candidate completeness check prevented parent shutdown. One filtered test failed before the check was corrected; parent withdrawal now refuses further receipts without altering an open writer.
- A direct raw SQL null outcome settled an unknown attempt. One filtered negative failed before explicit null/type validation and database completeness checks were added; the writer now remains open.
- Seven malformed reply/admission cases failed before operation, part and stage binding was strengthened. Correct first admissions remain covered separately.
- Two privileged operator inserts exposed SQL null-logic gaps in receipt/settlement CHECKs. Both failed before null-safe checks were added. These were operator invariant tests, not alleged worker raw-table exploits.
- Early implementation syntax/name-collision and fixture failures were corrected; they are not hidden by retries or weakened assertions. A delete-audit assertion now names the existing `append_only_record` refusal.

Final focused command:

```text
npx vitest run src/server/programs/program-media-multipart-ledger.test.ts src/server/programs/program-media-multipart-ledger.database.test.ts src/server/programs/program-media-native-ledger.database.test.ts src/server/programs/program-media-native-ledger.test.ts src/server/programs/program-media-native-request.test.ts src/server/programs/program-media-parts.test.ts src/server/programs/program-media-http.test.ts src/server/programs/program-media-authoring.test.ts src/server/programs/program-media-settlement.database.test.ts
```

Result: 9 files, 197 passing tests. Typecheck, changed-file lint and diff whitespace check exit 0. Mock-import, identity/consent, authenticated API, compatibility, operation inventory, production-core and stub-reset gates pass. Inventory remains 228 implemented but activation-blocked operations and zero enabled; its legacy 140 provider flags are not a count of this increment's remaining source work.

The full 256 MiB case validates an immutable 32-part recipe, not an actual 256 MiB transfer. Controlled embedded ordering validates the two cancellation orders, not real PostgreSQL lock-wait timing or a live provider race. Fictional provider receipts, review hashes and exact-key absence proofs never qualify production evidence.

| Evidence tier | Status at source freeze |
| --- | --- |
| Implemented | Restricted durable multipart ledger and transactional adapter. |
| Locally verified | Focused 197 tests and named source gates above. Normal full suite, full lint and clinical build/scan are tracked separately when started. |
| CI verified | Not yet observed for this successor. Predecessor CI is green. |
| Hosted verified | Not run. No candidate installed, real credential used or provider request sent. |
| Device verified | Not run. No mobile build or upload. |
| Approved for PHI | No. Educational synthetic-only source remains held. |

## Remaining work in dependency order

1. Extend the qualified S3/STS source with exact initiation, part upload, bounded upload/part/version listings, conditional completion, reconciliation and abort. Persist each admitted attempt before external work. An unknown creation/completion must never be blindly reissued or certified absent while a writer may still act.
2. Review multipart-specific encryption policy and KMS/IAM behavior. The existing single-PUT policy and FULL_OBJECT readback are not approval or proof for multipart. Bind each observation to reviewed account/region/bucket/key/upload/version and permit no alternate destination.
3. Stream the exact completed version under a byte/time bound and verify whole-file SHA256 and size independently of the composite checksum. Preserve missing/ambiguous versions as holds. Connect actual listing observations to post-settlement abort proof; real provider cancellation and late-write behavior remain hosted negatives.
4. Install current workforce/MFA/session and narrowly scoped STS host wiring, bounded control/binary routes and Studio upload/resume/recovery controls. Select a host that can genuinely carry 8 MiB binary parts; do not assume a JSON/base64 Lambda payload can.
5. Complete the mirrored V2 media-reference/read-only delivery contract, private short-lived access, publication/retirement history, text provenance and foreground/second-device isolation. Do not overlap Claude's purchased-course account/enrollment assignment.
6. Deliberately reconcile source branches and rebind release kits. Only after separate schema/resource/release review may an operator register/deploy a preserving candidate and run real-store positives, both race orders, rollback, matched releases, physical iOS/Android acceptance and provider/human reviews.

All six original commercial-readiness scopes remain incomplete. Clinical holds, exclusions, source verification, measured inputs, guardian deferral and Core launch boundaries remain intact. No AWS write, secret read, provider call, schema application, new paid build, main merge, PR, force-push, commercial launch or PHI activation occurred. The shared Graphify canvas is not changed.
