# Lesson media control requests and bounded video parts

The educational-media control HTTP source and bounded part reader are implemented on `agent/program-media-http-admission-20261011`, based on exact Desktop `0640c8d5560b669eec57bdf8abdf1506f811c102`. They advance the existing media custody and release scopes. They are not installed routes, a completed multipart upload, a managed schema upgrade or commercial/PHI activation.

## Verified predecessor

The exact predecessor's frozen local suite completed with 469 files, 7,497 passing tests and 11 existing skips. Exact-head [CI 38186787464](https://github.com/HolisticDrBright/AI_DESKTOP_PRO/actions/runs/38186787464) reports SUCCESS on `0640c8d`. Its lint, clinical build and 309-chunk client scan passed. The Windows standalone dependency-junction EPERM warning still prevents treating that local package as a qualified deployment artifact. These results do not apply automatically to this successor.

All existing candidate SQL bytes are unchanged:

| Candidate | SHA256 |
| --- | --- |
| Media ledger parent | `6dae2f237c13540b13cc3b7ecde877be104c35e59c7fddd9206130a62356a34d` |
| Selected settlement | `74f54bbb72539218dc6d12098a1773da572f4eb9230faae10010f69d5c95ff04` |
| Native ledger | `69eb187cd22500014c1b79bf5dfdc7577e1c18376f30197eded0804f9114a6d7` |

No new SQL candidate, mapping, installed migration, secret, role login, consent or release row was created. Embedded fixtures remain fictional and apply the 47-migration synthetic artifact plus the exact blocked parents, not the hosted qualification assembly.

## Control HTTP boundary

`src/server/programs/program-media-http.ts` exports `createProgramMediaControlHandler`. Its `program-media-control-http/1` source serves metadata commands at `/api/live/programs/media/control` only when the trusted host explicitly enables it and provides a request-specific native source. Default activation is OFF. No Next route is mounted by this increment.

The host must verify current MFA workforce authority before returning a source. The real native factory then independently checks current DB authority, reviewed release, program scope and the scoped provider binding for every action. A browser cannot set an actor, context, storage, activation, review hash or role. The resolver is captured at construction, not read from a mutable host configuration on each request.

Only POST, the exact path without a query, and the shared strict same-browser-origin check are admitted. Forwarded-host headers do not confer authority. JSON is strict UTF8; compressed or ambiguous formats are refused. Bodies and replies are capped at 1 MiB, including unknown-length streams. Declared length is checked before authentication; actual length is checked while reading. Authentication precedes body consumption. One overall deadline bounds both authentication and execution; stalled reader cancellation never blocks the response.

Responses contain only the closed contract and one validated, request-bound result or refusal code. They are private/no-store, vary on Cookie and Origin, and carry no provider exception text or unknown provider fields. An empty success cannot substitute for failure. A timed-out response never certifies that a write was cancelled or an object erased: durable native writer settlement still governs uncertain work.

The commands are prepare, reconcile, attachText, preview, publish, retire, describeReference and cleanupOrphans. Inline file bytes, base64 files and `admit` are not accepted in the JSON control body. A valid 256 MiB video reservation remains valid metadata; this is not evidence that its bytes have been uploaded.

## Bounded video parts

`src/server/programs/program-media-parts.ts` exports an exact ordered part manifest, `readProgramMediaPart`, and a composite checksum helper. The full 256 MiB video ceiling is retained as at most 32 parts of 8 MiB. Non-final parts have exactly 8 MiB; only the last may be smaller. Each read checks content type, encoding, admitted size and SHA256, actual bytes, deadline and cancellation. The immutable admission must be loaded from current durable authority first; browser headers are not that authority.

S3 multipart SHA256 is a composite checksum formed from the binary part digests with the part-count suffix. It is not the whole-file SHA256 already bound to an ALP reservation. The helper preserves that distinction; it cannot make a multipart object satisfy the existing FULL_OBJECT contract by relabeling its checksum. S3 also requires consecutive part numbers with checksums and at least 5 MiB for non-final parts. See [S3 multipart upload](https://docs.aws.amazon.com/AmazonS3/latest/userguide/mpuoverview.html) and [CompleteMultipartUpload](https://docs.aws.amazon.com/AmazonS3/latest/API/API_CompleteMultipartUpload.html).

Only one 8 MiB part is read in the large-part test; the 256 MiB case proves the bounded manifest recipe, not a whole 256 MiB provider upload. The reader is not yet connected to native multipart admission or a provider operation. Deployment must select a host capable of this binary request bound; do not assume an API Gateway/Lambda JSON or base64 payload can carry it.

## Reproductions and verification

The first two new suites failed to load because the source modules did not exist; that is an implementation gap, not a reproduced bug in the predecessor. Initial implementations passed 54 new tests. Typechecking then exposed fixture typing defects and a parameterized manifest test that unpacked arrays instead of testing the full list; both were corrected without weakening assertions. The expanded suite passed 65 cases before the final additions.

A new configuration-mutation regression failed with 1 failure and 34 passing HTTP tests: replacing the resolver after construction changed the host used. Capturing the resolver repaired it. New positive/negative response-contract cases cover publication, preview, historical references and cleanup. Existing database tests gained two real HTTP-to-native-factory-to-restricted-SQL journeys: command replay creates one reservation, and membership withdrawal during body consumption refuses the later factory before reservation or provider admission.

Final focused command:

```text
npx vitest run src/server/programs/program-media-http.test.ts src/server/programs/program-media-parts.test.ts src/server/programs/program-media-native-ledger.database.test.ts src/server/programs/program-media-native-request.test.ts src/server/bounded-request-body.test.ts src/server/same-browser-origin.test.ts
```

Result: 6 files, 105 passing tests. Typecheck, changed-file lint and diff whitespace check exit 0. Identity/consent, authenticated API, mock-import (285 entries/612 reachable), stub-reset (141 bindings), compatibility (223 RPCs/5 read models), operation inventory and production-core gates pass. The inventory still reports 228 activation-blocked operations and zero enabled; its legacy 140 provider-rewrite flags are not a count of this increment's remaining engineering. The unchanged production artifact still has 106 migrations and zero seeded rows. No retry, deadline increase or added skip was used. The native provider connection in the two embedded journeys is fictional; no actual S3/STS request or host login ran. Successor full unit/build/CI results must be recorded separately when observed.

## Remaining engineering in dependency order

1. Implement a distinct blocked native multipart candidate on the preserved ledger, with immutable whole-file and ordered part identities, durable upload and part admission, exact provider upload/part receipts, current authority/release checks and bounded recovery. Lost create/upload/complete responses remain unresolved until proved; no automatic writer expiration may certify absence.
2. Extend the real S3/STS source for initiation, exact-part upload, bounded listings, conditional completion, reconciliation, abort and exact-version verification. Persist admitted work before external writes. Recheck the reviewed bucket policy and KMS/IAM grants for multipart requests; the existing single-PUT encryption policy/readback is not proof that multipart works.
3. Verify the assembled bytes against the reservation's whole-file SHA256 using bounded streaming before existing commit/publication. Do not substitute an ETag, caller metadata or a composite checksum. Bind recovery to one exact version and preserve ambiguity as a hold.
4. Provide the real current-session/STS host wiring and bounded control/chunk routes, then Studio upload/resume/recovery controls. Authority withdrawal, deadlines, retirement, cleanup sealing and cancelled/late writes need both race orders. Source interfaces are not a deployed workforce verification path.
5. Complete the mirrored V2 media-reference successor and scope-filtered, read-only delivery, including retirement/publication history, private short-lived media access, supplied text provenance and foreground/second-device isolation. Do not duplicate Claude's separate paid-program commerce assignment.
6. Reconcile branches on an intentional base and rebind release kits. Register/deploy only after reviewed schema custody and dedicated-resource evidence; then run real-store positives/negatives, matched builds, rollback, browser/device accessibility and provider/human acceptance. Those are not proved by Request objects, PGlite or fictional SDK replies.

Retention/withdrawal of published education, legal/content approvals, caching/accessibility review, the selected hosting request bounds and production provider/security evidence remain separate decisions. Clinical holds, source verification, Core scope, guardian deferral, PHI disabled and the paid-mobile-build hold are preserved. All six original commercial-readiness scopes remain incomplete.
