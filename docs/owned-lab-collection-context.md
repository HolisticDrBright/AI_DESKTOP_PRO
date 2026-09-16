# Owned lab observations: collection context persistence

September 16, 2026. Owned-storage deployment remains a separate candidate.
The completed-age matcher is deployed to the synthetic lab backend only.
No PHI or signed clinical release was activated.

## What changed

- `lab_observations` records in production-owned storage accept an optional `collectionContext` (`ownedCollectionContextSchema` in `src/server/clinical-core/owned-lab-observations.ts`). It carries the completed **age at the draw** (`ageAtDraw {value, unit: days|months|years}`), `observedOn`, sex, pregnancy status, cycle phase, reproductive stage, contraception, pregnancy trimester and assay identity. The dimension vocabularies are shared with the range population schema (`collectionDimensions`) so stored context cannot drift from signed range populations.
- The stored copy never carries a date of birth. Owned storage already refuses direct-identifier keys (`dateOfBirth`, `email`, `ssn`, and so on) at the payload layer; that rule is unchanged. Restore checks profile agreement but retains the recorded completed age. Agreement is not proof of an exact historical birth date.
- `observedOn` must equal the observation's `drawnAt` calendar day. Context describing a different draw is refused as `owned_lab_observation_invalid`.

## Consent enforcement

- `lab_history` consent is enforced by the SQL write function as before.
- A write whose context carries any reproductive dimension additionally requires active `reproductive_health` consent. Migration `20260916060000` supplies `owned_reproductive_context_allowed()` under the same owner lock used by consent withdrawal, plus a database insert trigger. The earlier consent-state helper was purpose-incompatible and was not race-safe merely by sharing a transaction. Refusal maps to `consent_required` (HTTP 403).
- Reads (`list`, `recent`, `get`) withhold the whole `collectionContext` of any record with reproductive dimensions while reproductive consent is not active. A partial record whose nulls read as "not pregnant" is never returned. The stored record stays intact for a later re-grant, correction or deletion; withdrawal is not object erasure.
- Non-reproductive context (age at draw, sex, assay) travels under `lab_history` consent only and is never withheld by the reproductive check.

## Not done here

- The chat-context builder still ignores `collectionContext`; it emits explicit lab fields only.
- The clinic-sharing `lab-result/1` import does not carry collection context. That transport hashes its canonical payload for de-duplication and its SQL signature would need a migration; it was left out of this increment.
- September 16: real rollback-only Aurora verification now covers positive writes, missing/revoked consent, read withholding, and direct-SQL write refusal (107 assertions across the expanded suite). No retained schema/fixtures. Hosted, physical-device and independent concurrent-session verification remain open.

## Verification

September 16 precision repair supersedes the prior DOB-only limitation:

- Saved-plan requests and the worker now accept either exact recorded DOB or
  completed age at draw, never both. Shared storage/request dimension schemas
  reject unknown fields, invalid dates, fractional ages and conflicting shapes.
- For completed age, the matcher calculates the possible birth-date interval
  transiently. A reviewed range must include **every** date in that interval.
  A year-only record cannot select a narrow month/day band by substituting the
  current profile birthday. These bounds are not persisted as a birthday.
- Stored completed-month arithmetic and reviewed clamped-anniversary boundaries
  deliberately remain distinct. Leap-day/month-end ambiguity withholds a match;
  no range values, source-verification requirements or approvals were changed.
- Existing exact-DOB matching, range kind, assay/population dimensions, signed
  release verification, expiry and ambiguous-match refusals remain in place.
- Local full suite: 1,692 passed / 11 existing skips. Typecheck, lint (four
  pre-existing warnings), range-tool and lab API/worker builds passed.
  V2 paired source: 1,069 passed / one hosted skip, typecheck/lint passed.
- Hosted runner gains opt-in `-TestRecordedAgeContext -TestSavedPlanGeneration`:
  malformed-context refusal with no durable request, persisted age precision,
  complete fictional saved-plan processing and cross-user denial/cleanup.
  Actual synthetic hosted execution passed as recorded below.

- Earlier isolated-container evidence reported timezone/demo-gate failures. The
  full local suite above ran with the repository's Pacific-time test command.
- `check:aws-production-readiness`, `check:aws-first-real-data-pilot` and `check:aws-production-foundation` fail identically on the clean tree because they need locally reviewed manifests that are not in this container.

## Exact synthetic deployment and hosted verification

- Source **b61a9005359f39696ac7b2a8a0b8644a5fdeeb4c**, PR65,
  deployed through recovery-b61a9005359f-20260916134019.
  Stack UPDATE_COMPLETE in account588966314750/us-east-2.
- Candidate/live templates canonically identical. Only API/worker artifact
  parameters changed; all other parameters retained. No active workflows before
  preparation. No database migration, resource removal, data-policy expansion
  or production-account write.
- All four runtime hashes verified: API/cleanup/session-authorizer ZIP
  ca55bf261a19ff248134384137aadc9f91a2959a91052bf7bf63ac6648cc68a5;
  worker ZIP6adbfe30411bd0b486677728a7bdb81de1a58ce565eb13d75be04afa50a6e95b.
  PHI false, classification synthetic_only,30routes, knowledge disabled and
  range mode synthetic_fixture remain unchanged.
- Hosted runner with ConfirmSyntheticOnly, CreateSyntheticTestUsers,
  TestReviewedContext, TestSavedPlanGeneration and TestRecordedAgeContext passed
  **41 distinct checks /49 evaluations**. Three fictional markers each retain
  completed40years with no invented DOB in their persisted request context.
  Invalid both-age-and-DOB, negative-age and mismatched draw date each return400
  and create no durable request (GET404).
- One actual workflow/OpenAI synthetic plan completed; exact measured values,
  units, unverified provenance and source-panel/context bindings preserved.
  Other-user access refused; repeat results stable; API cleanup followed by404.
  The unstarted recovery fixture also deleted. Two temporary identities signed
  out/disabled. Audit, PITR/backups and cleanup metadata were not erased.
- This proves deployed transport/persistence and synthetic processing. Matching
  signed range fixtures is separately unit-tested, not a claim that clinical
  source ranges are activated. No clinic-recipient context transfer, owned
  production storage deployment, native UI test or paid mobile build occurred.
- Paired V2 **1c9367c3f59ce57ff68ae16ba7cf40c2b85e3351**:
  CI35147881790 passed. Desktop CI35147874061 main checks passed; final live
  contract-fixture browser job was still running at capture. Its separate
  deployed-backend job skips real tests when secrets are absent.
