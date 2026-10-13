# Learner media delivery: exact-version, per-learner, closed by default (2026-10-13)

Source engineering only. Nothing here was deployed, applied, registered, enabled or run against AWS,
S3, KMS, STS, Cognito or any provider. No paid or production mobile build was started, no PHI path was
opened, and no Core file was changed. Every test described is a **source test** over fictional
stand-ins; none is hosted, provider, device or PHI evidence.

## Where it starts and what it carries

| Repository | Base (integration head) | Branch | Head |
| --- | --- | --- | --- |
| Desktop | `8e07449792004b7ae5002b9ee9b61d10018b9eac` (`agent/core-ask-alp-integrated-20261012`) | `claude/learner-media-delivery-20261013` | see the return message |
| V2 | `0a34aa329a50db27864e3a7d4aa4a28a1c17fc6e` (same branch name) | `claude/learner-media-delivery-20261013` | see the return message |

The handoff named older media heads (Desktop `b3565156`, V2 `daedb0a3`); both are ancestors of the
integration heads, as are the native editor's withdrawal repair `c488f2ce` and the `/courses` source.

**Deliberate merge.** The integration heads do not carry the purchase-to-course closure (Desktop
`dd78f2f7`/`a627ef1e`, V2 `7c1848d`). That closure holds the verified consumer session with
per-request revocation, the reviewed learner host and the least-privilege database interfaces that a
learner media read must stand on, so each media branch begins with a merge of it (Desktop `b3546669`,
V2 `3b6a540`). No Core file is touched by either merge. On V2 the launch-acceptance index and its test
keep the integration branch's Core binding unchanged; the closure branch's superseded predecessor
copy is not taken.

## Mirrored contracts (LF-normalised SHA-256, byte-identical in both repositories)

| Contract | SHA-256 | Changed here |
| --- | --- | --- |
| `programLearnerMedia.ts` (new, `program-learner-media/1`) | `8d2c9f62e1bec110cd666d9bcae86a786b58a24d0fabd11ae39c89b6b89a5f99` | added, pinned on both sides |
| `programLessonMedia.ts` | `a766b6000d12b0b5ce81ff4f2cbbe6e4a13a748720e41596508370e30ff87636` | no |
| `programAssignments.ts` | `4df1e6db3574cf05f9ec6c95a9adf308971e4517d716eefdd0919237771bf29b` | no |
| `programEducationProgress.ts` | `6f4f3be5e3a714fbf4b9a5cde98a86b507f24933b3bb0f70cd8fe9d219f777e6` | no |
| `programEducationAccess.ts` | `61b8df5a09f5255bef1b1a9cf7d7c70933491504d22559a9ee692088e70005d3` | no |

## What was missing (failing before)

On the base chain (installed manifest, catalog admission, the four media candidates, the seven
commerce candidates and the runtime sessions), probed without the new candidate:

| Probe | Base result |
| --- | --- |
| A course whose lesson carries `nativeMedia` | `program_consumer_content(...)` is **null**: the whole course is not servable, so no offer, purchase or learner read can name it |
| Immutable text of a published version | none: `program_media_publications` records caption/transcript **digests**; the text lives only on the artifact and changes with it |
| Curriculum admission of a publication | none |
| A learner read of a media slot | none: My courses has no `media` service (400), the education API has no media route (404), V2's reader answers `held` always |

Found while building (fixed): the SQL adapter decoded jsonb as an object, but the RDS Data API returns
it as **text**. Every hosted read would have answered `service_unavailable`. The reviewed-path test
over the fake Data API failed (503) before the adapter parsed it, and passes after.

## Work package 1: the BLOCKED successor

`infra/aws-clinical-core/source-candidates/program-media-learner-admission.sql`,
SHA-256 `773f7456122889154e9d767ecc6db45b275414cbe909a0f32e816c2871d440f2`. Not in any manifest, not
applied anywhere, not registered. Its header names every parent by digest:

| Parent | SHA-256 |
| --- | --- |
| `program-education-catalog-admission.sql` | `eac6f2f1ae0ff2d418da9f7a06b5086d50ba46374f31961726fd52fa0530ba1d` |
| `program-media-ledger.sql` | `6dae2f237c13540b13cc3b7ecde877be104c35e59c7fddd9206130a62356a34d` |
| `program-media-settlement.sql` | `74f54bbb72539218dc6d12098a1773da572f4eb9230faae10010f69d5c95ff04` |
| `program-media-native-ledger.sql` | `69eb187cd22500014c1b79bf5dfdc7577e1c18376f30197eded0804f9114a6d7` |
| `program-media-multipart.sql` | `a9b2a38d76f7a07569ed94342cc53a7810c6480ba6f28e0a24297265e9f70092` |
| `program-commerce-runtime-sessions.sql` (and through it the seven commerce candidates) | `d2142ad80fead07f83fa23636434274037c87ebad91fa1ce59988ab973b2c037` |

What it adds:

- **Text, captured once.** An AFTER INSERT trigger on `program_media_publications`, running after the
  two parent admission triggers that lock the artifact and prove the reference is its current version,
  copies the caption and transcript text into `program_media_text_snapshots` (append-only; a CHECK binds
  each body to its SHA-256 and byte length, so even a write below the triggers cannot change the text
  without breaking the digest). A publication recorded before this file has **no** snapshot and stays
  text-unavailable; nothing is backfilled from the artifact's current text.
- **Content syntax.** `program_content_valid` is replaced with `nativeMedia` admitted as syntax (exact
  reference keys and shapes, at most five slots with `media`, no repeated artifact version). Content
  without `nativeMedia` validates exactly as before, so every existing digest is unchanged.
- **Admission at publish.** A trigger on program versions admits each `nativeMedia` slot when the
  version becomes published, only when the reference is **exactly** (jsonb equality) a recorded
  publication of the same clinic and program whose artifact is still ready at the same version and
  bytes, with an object version, at the canonical address under the current authoring origin. Anything
  else refuses the publish (`program_media_admission_foreign | _unrecorded | _not_ready | _stale |
  _address`); the version stays unpublished and no admission row survives the rollback. The version
  row, its digest and every entitlement are untouched.
- **Withdrawal.** `clinical_core.withdraw_curriculum_media(admission, reason)`: a program author of the
  admission's clinic, append-only, once. A withdrawn admission is never served.
- **Reads.** `commercial_education.education_media_for_caller(entitlement, phase, item, slot)` (consumer)
  and `clinical_core.program_media_admitted_for_staff(version, phase, item, slot)` (workforce). Both
  answer `held` while `program_media_learner_delivery` is disabled (it is, and only a reviewed change
  may enable it). Otherwise every authority failure is one identical `{"outcome":"refused"}`.
- **Authority.** One new NOLOGIN, NOINHERIT, non-bypass role, `program_media_learner_authority`, owns
  every function and reads only through policies added for it. `clinical_core_api` may execute the two
  reads and the withdrawal and gains no table privilege. No login, password or activation is created.

Reduced-role calls the source makes (API session, after `set_request_context` with the verified
context): `select commercial_education.education_media_for_caller($1,$2,$3,$4)` and
`select clinical_core.program_media_admitted_for_staff($1,$2,$3,$4)`.

Why it stays BLOCKED: its parents are themselves BLOCKED and unregistered; the hosted qualification
database's installed assembly has not been compared with them; the owner role's policies, the FORCE
row-level security posture and the definer chain need review against real roles; the learner-delivery
review has not happened; and the retention of captured text is an undecided policy.

`src/server/programs/learner-media-admission.database.test.ts` (14) runs it on the whole chain with
publications made by the real authoring runtime through the restricted media worker and purchases
made through the real checkout, settlement, delivery and claim path. Covered: the exact text captured
and append-only; exact admission with the digest and entitlements unchanged; held while disabled;
the owner served through the SQL adapter and service with a second decision; one identical refusal
for another learner, a text-only, unreleased or missing slot, a nonexistent entitlement and a
mismatched identity; refused publishes for another clinic, another program, an unrecorded version or
digest, a preview capability in place of the address, a rewritten clinic, changed text (stale) and a
retired artifact, each with zero admission rows and the version still unpublished, including a mixed
publish rolled back whole; duplicate and over-slot items not servable; no request role can write,
replay or change an admission; the purchased version still served after a replacement is published
and its artifact retired, and the newer unsold version never; the staff read only for a clinician of
the version's own clinic; withdrawal; access revoked by the operator **while storage is being read**
(the capability is discarded and the next read refused); and a pre-capture publication served as
text-unavailable.

## Work package 2: the learner read

| Piece | File |
| --- | --- |
| Contract | `src/contracts/programLearnerMedia.ts` (mirrored) |
| Service (decide, verify text, issue, decide again; one deadline) | `src/server/programs/learner-media.ts` |
| SQL adapter (exact candidate identity or disabled) | `src/server/programs/learner-media-ledger-sql.ts` |
| AWS storage reader | `src/server/programs/aws-learner-media-storage.ts` |
| Fictional reader (tests, fixture) | `src/server/programs/learner-media-fictional.ts` |
| Consumer host: education API | `POST /clinical-core/consumer/education/media` in `src/server/commerce/reviewed/education-api.ts` |
| Consumer host: Desktop | `service: "media"` on `/api/my-courses` through the learner host |
| Workforce host | `src/server/programs/learner-media-staff-host.ts` and `/api/live/programs/media/staff-view` (nothing installs it) |
| Desktop page | `src/components/learner/LearnerCourses.tsx`, `src/lib/learner/learnerController.ts`, `learnerTransport.ts` |

The request names the course the device has open (entitlement, purchased pin, lesson, slot) and the
published identity it is rendering. It names no person, clinic, key or address. The grant must answer
that request exactly. Publication text is re-hashed. The AWS reader assumes the reviewed learner-reader
role **with a session policy naming exactly one object** (GetObject/GetObjectVersion on its key,
Decrypt on the reviewed key), HEADs the exact version (checksum mode on) and requires that version, no
delete marker, the exact bytes and type, SSE-KMS under the reviewed key, the authoring store's identity
metadata and the admitted whole-object SHA-256 (full-object checksum for a single upload, the
`whole-sha256` the multipart commit verified for a composite one). It then signs a five-minute,
private/no-store GET of that version with the existing exact-version signer. S3 object versions are
immutable, so this binds the capability to the admitted bytes. No redirect is followed, no address
from the ledger or the browser is fetched, and no provider credential reaches a browser. A capability
issued for a decision that no longer holds is discarded.

Closed by default: the commerce host target's new `learnerMedia` section is optional; absent, every
read answers `held` before any ledger call. The database's own delivery row is disabled. Without a
reviewed host the Desktop answers `learner_host_unavailable`, and the staff route answers
`staff_media_host_unavailable`.

The Desktop page asks for each slot of the open lesson and shows a player with the publication's own
captions as a track plus its transcript, or says held, not available, could not be checked, or lapsed.
It drops the capability, the player and the text **synchronously** when the tab is hidden or the page
left (the same posture as the editor's `c488f2ce` repair), and on lesson change, capability expiry,
sign-out, an access refusal or a change of account. A text-only lesson shows no media notice; a video
lesson is never shown as playable without the service's answer.

Tests: `learner-media.test.ts` (9: held without a reader; refusals before the ledger; exact answer
with two decisions; mismatched grants; a changed or refused second decision; tampered text, malformed
decisions, storage failure, a foreign or day-long capability; a storage read past the deadline; a
session ending mid-read; identical refusals), `aws-learner-media-storage.test.ts` (7: the one-object
session policy and exact-version signing; composite objects; eleven metadata mismatches including
oversized, truncated and corrupt bytes; missing objects, provider errors, short-lived and partial
credentials; foreign keys refused before any provider call; abort and session lapse; configuration
refusals), `learner-media-reviewed.database.test.ts` (4: through the reviewed runtime as the bootstrap
composes it, the education API and the Desktop route, over the fake Data API under the API login only),
`learner-media-staff-host.test.ts` (4) and `src/contracts/programLearnerMedia.test.ts` (4).

Browser: `e2e/learner-media-journey.spec.ts` (2), under its own flag `LEARNER_MEDIA_FIXTURE=1` on top
of the journey fixture, with its own CI step. A real purchase and claim, My courses, the media lesson
with the exact-version player, caption track and transcript, a text lesson with none, a hidden tab
dropping all of it, another learner refused, and signing out elsewhere taking media and lesson with it.
The signed bucket host is intercepted and the reference's own address is never requested. Without the
flag the journey course is byte-for-byte the eight-case journey's; those eight cases pass with and
without it.

## Evidence by kind

| Claim | Source test | SQL (fictional, embedded) | Hosted | Physical device | Provider agreement | PHI approval |
| --- | --- | --- | --- | --- | --- | --- |
| Text captured once, immutable | yes | yes | not run | n/a | n/a | n/a |
| Admission exact, refusals roll back | yes | yes | not run | n/a | n/a | n/a |
| Request-time authority, one refusal | yes | yes | not run | not run | n/a | n/a |
| Exact-object STS session and HEAD checks | yes (fictional transports) | n/a | not run | n/a | not reviewed | n/a |
| Capability expiry and withdrawal | yes | yes | not run | not run | n/a | n/a |
| Desktop page clears on authority loss | yes (browser, fictional) | partly | not run | n/a | n/a | n/a |
| V2 reader and panel | yes (mounted component) | n/a | not run | not run | n/a | n/a |
| Real role isolation, concurrency, locks | no | single connection only | not run | n/a | n/a | n/a |
| PHI | not applicable: educational media only | | | | | not requested |

## Dependencies on the host, and what Codex supplies (qualification account only)

| Source | Needs from the host |
| --- | --- |
| SQL adapter | the candidate applied after its parents; the API runtime login; `program_media_learner_delivery` enabled by a reviewed change |
| AWS reader | the learner-reader role, its trust for the education API function role and the Desktop task role, the bucket and key policies, STS and S3 egress |
| Target | the `learnerMedia` section in `program-commerce-host-target/1` with the pinned candidate identity |
| Education API | the new route on the API, the consumer JWT authorizer, the `x-alp-consumer-access-token` header allowed |
| Staff host | a reviewed workforce identity (MFA session, current membership); none exists in the reviewed runtime |

Ordered inputs:

1. Review the candidate. In the qualification database only, after its BLOCKED parents are reviewed and
   applied, apply it and record its identity. Confirm the installed assembly matches the pinned parents.
2. Role readback: `program_media_learner_authority` is NOLOGIN, NOINHERIT, NOBYPASSRLS; the API runtime
   login can execute the two reads and cannot select any new table.
3. Create a learner-reader IAM role: `s3:GetObject` and `s3:GetObjectVersion` on the dedicated education
   bucket's `program-media/*`, `kms:Decrypt` on the education key, nothing else. Trust the education API
   function role and the Desktop task role for `sts:AssumeRole`; add `sts:AssumeRole` on that role to
   both. The bucket and key policies allow it; the recording store and its key are excluded. The source
   narrows every session to one object.
4. Add `learnerMedia` to the target: `candidate` = the SHA-256 above, `storage` (bucket, owner
   `588966314750`, `us-east-2`, key ARN, `readerRoleArn`, forbidden buckets and keys including the
   recording store's), `evidenceSha256` of the learner-delivery review. Re-pin the target SHA-256.
5. API Gateway: `POST /clinical-core/consumer/education/media` to the education API function with the
   consumer JWT authorizer.
6. Egress for the education API function and the Desktop container: `sts.us-east-2.amazonaws.com` and
   the regional S3 endpoint.
7. A reviewed change enables `program_media_learner_delivery` with evidence, reviewer and time.

Ordered hosted tests (fictional data only):

1. Target negatives: without `learnerMedia`, and with a wrong candidate identity, the route answers
   `held` or refuses the target.
2. Publish a fictional video with supplied caption and transcript, then publish a version naming it.
   Read back one admission row and two snapshots. Change the text, publish again, and see the stale
   refusal.
3. Learner A (purchased) reads the slot. Verify the STS session policy names one object and the URL
   expires after five minutes. Fetch the URL once and see the exact bytes. Fetch another key with the
   same credentials and get 403.
4. Learner B, a second clinic and a newer unsold version: each refused identically.
5. Revoke A on another device mid-read: the reply is discarded and the next read refused.
6. Withdraw the admission: refused from the next read.
7. Faults: delete-marker, wrong-key and corrupt-object versions are each refused.

## Remaining defects and owner decisions

- **No authoring path writes `nativeMedia` into a step.** The editor publishes a reference but does not
  place it in the program; the authoring validator still labels the field pending admission, which is
  correct while this candidate is unapplied. A Studio change is needed once it is.
- **V2 cannot play video.** It has no reviewed native player module. Adding one (for example
  `expo-video`) changes the native binary and needs a mobile build, which is held. The V2 panel shows
  images and the published captions and transcript only, and says video cannot play.
- **A signed URL cannot be recalled.** Its exposure is bounded by five minutes, the one-object session
  and the bucket policy.
- **Clinical program assignments** (patients assigned a program by a clinic, the V2 program card) have no
  learner media read; their media stays held.
- **Retention of captured text**, who may withdraw, and whether withdrawal should notify learners.
- **Staff learner-progress visibility**, storefront classification, prices, terms, refunds: unchanged
  and held.
- **Embedded engine only.** Isolation, concurrency and lock behaviour are hosted questions. So are S3
  version immutability, the HEAD checksum under SSE-KMS, and STS session-policy intersection.

Unchanged: Core scope and every Core file, clinical holds, catalog binding, source verification,
measured-data-only and synthetic-only gates, the free recovery of saved meal data after a Core lapse,
the optional consult path beside direct purchase, PHI off, and production activation blocked.
