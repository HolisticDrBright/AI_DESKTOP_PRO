# Governed lesson media: dedicated-media design and blocked ledger candidate — October 11, 2026

For Codex's review. This is the authoring side of the media a patient program's lessons
carry: how an artifact is prepared, admitted, committed, captioned, previewed, published
by exact identity and retired. It is source with a fictional store behind it and a
runtime that is **disabled**. Nothing here is deployed, nothing certifies a hosted store,
and no schema successor is created: the ledger is a blocked candidate for review.

## Inventory: what exists before this

| Contract or source | What it is | What it is not |
| --- | --- | --- |
| `programItemEducation.media` in `src/contracts/programAssignments.ts` (mirrored byte-for-byte in V2; mirror sha `70c25790d159a328804496d0b8efdcb14f4a89553c945c76d9b5486d9edb5e39`) | A media slot: `{ kind: video \| image, url: https, caption? }` | Proof of ownership, review, integrity or availability. An address is a claim. |
| `governedMediaIssue` in `src/lib/programs/consumerProgramAuthoring.ts` | Shape checks on the address: https, no credentials, no query or fragment, public host | A hosting lifecycle. It cannot know whether the bytes exist or who put them there. |
| `src/server/clinical-core/recording-segments.ts`, `aws-recording-segment-store.ts`, `docs/qualification-recording-storage.md` | The clinical recording store: dedicated bucket, SSE-KMS, Object Lock, conditional create, full-object SHA-256, reserve → put → head → complete, no delete on an uncertain write | Reusable for education. It is a PHI store under clinical retention; a lesson video must never share its bucket, keys, roles or cleanup. |
| `infra/aws-clinical-core/source-candidates/program-education-catalog-admission.sql` (sha `eac6f2f1ae0ff2d418da9f7a06b5086d50ba46374f31961726fd52fa0530ba1d`, standalone, unregistered, unapplied) | Admits the education fields and the catalog binding into the SQL copy of the program contract | A media ledger. Its identity is preserved; this design does not amend it. |

Conclusion of the inventory: **no reviewed media architecture exists.** The recording
store must remain separate. The source specification now requires durable writer and
cleanup admission, complete version-inventory absence proof and the entire recorded
publication. See `docs/program-media-settlement-2026-10-11.md` for the four independently
reproduced defects and their source repairs. The runtime remains disabled.

## Design

### Purpose and separation

- Educational media only. The authoring context must be a workforce member of a clinic
  with `containsPhi: false` and `realPatientData: false`; a context that carries PHI is
  refused before the ledger is touched. No input names a patient, a connection, an
  encounter or a consumer. The ledger candidate has no such column.
- A dedicated store. The storage declaration (`programMediaStorageSchema`) must say
  `purpose: educational_media`, `phiAllowed: false`, `dedicated: true`, name a bucket
  whose name does not read as a recording, voice, encounter, transcript, PHI or patient
  store, and name an https public origin that is not an `amazonaws.com` address. A
  declaration that fails this is refused at construction.
- No browser provider calls. Bytes go to the Desktop server, which proves them and writes
  them; a patient app loads only the published https address.
- Captions and transcripts are supplied material. The only admissible sources are
  `supplied_by_author` and `supplied_vendor_file`; a request naming any other source is
  refused as `text_source_refused`. Nothing is transcribed or generated here, and nothing
  claims accessibility coverage that the author did not supply.
- Authoring writes and preview reads are different operations. `preview` returns a
  short-lived store handle for the author, never the published address and never a write;
  `publish` returns the reference a program step would carry.

### Contract: `program-media/1` (`src/contracts/programMedia.ts`)

- Kinds `video` (`video/mp4`, `video/webm`) and `image` (`image/png`, `image/jpeg`,
  `image/webp`). The file name is `[A-Za-z0-9][A-Za-z0-9_-]{0,118}.<ext>` and its
  extension must match the declared content type.
- Byte limits are storage values: images at most 16 MiB, videos at most 256 MiB, both
  lower by declaration. A single bounded admission is what the source implements; whether
  a real store needs multipart for the upper range is a Codex decision (see prerequisites).
- The object key is a function of identity:
  `program-media/{clinic}/{programId}/{artifactId}/{sha256}.{ext}`. The ledger candidate
  enforces that equality as a check constraint, so a key can never name another clinic's
  or another program's object.
- States: `reserved → ready | held | error | abandoned`, `error → ready | held | abandoned`,
  `ready → retired`. `held`, `abandoned` and `retired` are terminal. `ready` and `retired`
  require a proven object version and a commit time; `retired` requires its time.
- Every metadata change raises the artifact `version`. A publication names the exact
  version, bytes (sha256), kind, content type, origin clinic and program, and the https
  address under the dedicated public origin. `programMediaReferenceStatus` reports whether
  that reference is `historical` only for a recorded reference after retirement, and
  `current` only when the whole recorded reference matches the current artifact snapshot.
- The mirrored slot is not changed. A successor slot carrying the reference is a
  separate, mirrored contract change for both repositories after this review.

### Runtime: `src/server/programs/program-media-authoring.ts`

`createProgramMediaAuthoring({ ledger, store, storage, activation })` with
`PROGRAM_MEDIA_ACTIVATION = { enabled: false }` as the default. Every operation refuses
with `program_media_disabled` until a reviewed activation is passed in. The interfaces:

- `ProgramMediaLedger`: `authorize`, `reserve` (idempotent on clinic, program and command;
  a changed payload under the same command conflicts), `reservation`, `artifact`, `commit`
  (idempotent for the same object version), `settle`, `attachText`, `retire`,
  `recordPublication`, `hasPublication`, `expiredReservations`, and the durable
  `beginWriter`, `finishWriter`, `beginCleanup`, `certifyCleanup` operations. Commit checks
  the writer claim in the same transaction as its state change. An uncertain writer does
  not expire automatically and needs a separately reviewed recovery protocol.
- `ProgramMediaObjectStore`: `put` (conditional create, `If-None-Match: *`), `head`
  (full-object SHA-256 checksum, SSE-KMS key, object metadata), `remove` (exact version,
  cleanup only), `inventory` (complete exact-key version inventory), `preview` (short-lived read handle).

What the runtime keeps:

| Promise | How |
| --- | --- |
| A lost response never duplicates an upload | The reservation is idempotent on the command. `admit` for a `ready` artifact returns it without writing. A `put` that throws (conflict or lost response) is followed by a `head`; a proven object is committed, never rewritten. Two concurrent admits of one reservation write one object. |
| A lost response never claims a publication | A reference exists only when `recordPublication` returned; a ledger failure leaves no reference. |
| Integrity | Bytes must match the reservation's length and sha256 before any write; the stored object must report the same length, content type, full-object checksum, KMS key and identity metadata, else the artifact is `held` as `storage_unverified` and nothing commits. |
| Explicit retry and reconciliation | Writer admission precedes storage calls. `reconcile` can recover proven bytes after the upload window expires; expiry alone is not absence proof. An abandoned reservation stays discoverable until cleanup is certified. |
| Cleanup and committed artifacts | A durable cleanup seal must win before deletion. Active and uncertain writers block it; the seal prevents later writer admissions and commits. Cleanup verifies a complete exact-key version inventory after deletion and records its proof. A no-op, denied or uncertain delete remains pending. Ready, retired and held artifacts are not deleted. |
| Retirement | A retired artifact is never newly published and accepts no new text; earlier references stay exactly what they were and read back as `historical`. |
| Version binding | Text, publication and retirement each name the version they saw; a stale version conflicts. |

### Fictional store and ledger: `src/server/programs/program-media-fictional.ts`

In-memory, no network, no credentials. The store behaves like the dedicated bucket the
design asks for and can inject `lose_put_response`, `fail_put`, `fail_head` and
`corrupt_object`. They exist so the journeys below are executable here and repeatable by
Codex against a real store. They certify nothing hosted.

### Blocked ledger candidate

`infra/aws-clinical-core/source-candidates/program-media-ledger.sql`
sha256 `6dae2f237c13540b13cc3b7ecde877be104c35e59c7fddd9206130a62356a34d`.
Standalone, unregistered, unapplied, and marked BLOCKED in its header. Parents pinned by
digest: `20260812010000_synthetic_identity_consent.sql` (`c4ca9673…`) and
`20260903200000_synthetic_desktop_programs_inbox.sql` (`6ba42349…`). It is not a
successor to the education admission candidate (`eac6f2f1…`) and does not touch it.

It holds `program_media_activation` (disabled, no bucket, no origin; the API role can
neither read nor flip it), `program_media_artifacts` (identity, key equality, the state
machine as constraints and a transition trigger, one committed artifact per clinic,
program and bytes, supplied text sources only, no patient column), `program_media_events`
and `program_media_publications` (append-only; a publication is admitted only for a ready
artifact at its current version and bytes with the activation origin's address, so nothing
is publishable before activation names an origin). The API role is granted nothing. The
PGlite test `src/server/programs/program-media-ledger-candidate.database.test.ts` runs it
on the full synthetic manifest and proves each invariant.

## Verified here (local, fictional)

| Suite | Result |
| --- | --- |
| `src/server/programs/program-media-authoring.test.ts` | 33 passed: activation disabled by default and refusing before any ledger or store call; the positive journey (prepare, admit, caption, preview, publish, retire, historical reference); video with vendor transcript; denials (PHI context, consumer, other clinic, unauthorized program, type, name, size, zero bytes, smuggled patient field, mismatched bytes, expired reservation, generated caption, cross-clinic reads); races (repeated prepare replayed, lost put response, lost publication, concurrent admits, failed write then reconcile, corrupt object held and never deleted, unreachable store, stale version); orphan cleanup. |
| `src/contracts/programMedia.test.ts` | 4 passed, including that the mirrored media slot admits no artifact field. |
| `src/server/programs/program-media-ledger-candidate.database.test.ts` | 8 passed on the full synthetic manifest. |

Not verified here, and not claimed: any S3, KMS, IAM, CloudFront or database behaviour;
the Studio's media slot still accepts an https address and is unchanged.

## Prerequisites Codex owns before activation

1. **Store.** A dedicated bucket in the qualification account (`588966314750`,
   `us-east-2`) for educational media: versioning, bucket-owner-enforced ownership, all
   public access blocked, SSE-KMS with a key that is not the clinical recording key or is
   explicitly reviewed for this purpose, TLS and encryption denial policies, no Object Lock
   requirement (this is not a retention store) unless review wants one, and a lifecycle
   decision for abandoned uploads. Its name must not read as a recording, voice, encounter,
   transcript, PHI or patient store.
2. **Delivery origin.** An https origin for published references that is not the bucket
   address (CloudFront or equivalent), read-only, serving only `program-media/` keys, with
   the origin recorded on the activation row. Until the row names it, no publication is
   admissible.
3. **Ledger.** Review of the blocked candidate; then a registered successor with a
   reviewed function family for the API role (reserve, commit, settle, text, retire,
   publish, expired reservations) and a SQL `ProgramMediaLedger` adapter. The fictional
   ledger is the behavioural specification for that adapter.
4. **Runtime.** An `ProgramMediaObjectStore` over the AWS SDK modelled on
   `aws-recording-segment-store.ts` (conditional create, `ChecksumSHA256`, SSE-KMS,
   `HeadObject` with `ChecksumMode: ENABLED`, object metadata `artifact-id`, `program-id`,
   `clinic`, `purpose`), a `preview` implementation (short-lived pre-signed GET of the exact
   version, five minutes), and the Desktop routes that call `prepare`, `admit`,
   `attachText`, `preview`, `publish`, `retire`, `reconcile` and `cleanupOrphans` behind
   the workforce cookie session and same-origin checks. Bounded admission above a few MiB
   through a Lambda or Next route needs a multipart decision: the source admits one object
   per reservation and does not decide this.
5. **Activation.** A reviewed change that sets `program_media_activation.enabled` with
   evidence, reviewer, time, bucket and origin, and passes `{ enabled: true }` to the
   runtime. Until then the runtime is off in source.
6. **Mirror successor.** A mirrored contract change in both repositories adding a
   reference field to the media slot, with the consumer app loading only the published
   address and showing caption and transcript provenance as supplied.

## Ordered real-store qualification (fictional data only, no PHI)

1. Store readback: versioning, public-access blocks, SSE-KMS key, policy denials, and that
   the bucket name is the dedicated one. Receipt: the readback JSON and source commit.
2. Prepare: `prepare` with a fictional PNG under the image limit returns `reserved` with
   the computed key and a fifteen-minute `acceptBefore`. Repeat the same command: `replayed:
   true`, one ledger row.
3. Admit: `admit` writes once (`put` with `If-None-Match`), `head` reports the full-object
   checksum, the KMS key and the identity metadata, the ledger row is `ready` with the
   object version. Receipt: the head response and the ledger row.
4. Lost response: inject a timeout between `put` and the reply; retry `admit`; expect one
   object version, one ready row, no second write (`ListObjectVersions` shows one).
5. Mismatch: write bytes with a different checksum under a reservation out of band; `admit`
   must hold the artifact as `storage_unverified` and must not delete the object.
6. Text: attach a supplied caption (plain) and, for a video, a vendor VTT; a `generated`
   source must be refused; the version must rise each time.
7. Preview: a pre-signed GET of the exact version, expiring in five minutes, that fails
   after expiry; not the public origin.
8. Publish: with the activation row naming the origin, publish at the current version;
   the reference's address is `origin + objectKey` and loads from the delivery origin; a
   stale version conflicts.
9. Retire: publication after retirement is refused; the earlier reference reads back
   `historical: true`; the object is not deleted by retirement.
10. Reconcile: an admitted recovery can commit an object after the acceptance window
    expires. Empty recovery certifies no deletion; unresolved reservations remain discoverable.
11. Cleanup: prove both race orders, delayed and uncertain uploads, denial, incomplete
    inventory and acknowledged no-op deletion. A settled orphan is removed by exact version
    only after the durable seal; success needs a complete empty version inventory and recorded
    absence proof. Ready objects and uncertain writers are preserved.
12. Refusals: a consumer token, a production (PHI) context, another clinic's program, a
    PDF, a 17 MiB image, a name with a path separator, a patient field in the request, a
    publication before activation names an origin.
13. Cleanup of the qualification itself: delete only the fictional objects written by
    these cases, by version, and record the final empty listing.

Failure recovery for each step is the state the runtime leaves: `error` is retryable,
`held` needs review, `abandoned` is final. No step may be reported as passed on a store
other than the dedicated one, and no step is evidence of patient-facing delivery.

## What this does not decide

Retention of educational media, who may retire, whether a published reference may be
withdrawn from an already-assigned program, the delivery origin's caching, multipart
admission, accessibility obligations beyond showing supplied provenance, and any
production-clinical family. Each is named for review, not answered.
