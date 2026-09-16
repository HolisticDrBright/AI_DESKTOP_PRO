# Owned lab observations: collection context persistence

September 16, 2026. Source engineering only; nothing deployed, no PHI, no signed release.

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
  Deployment and hosted execution are tracked separately; this paragraph does
  not claim they have run for the precision repair.

- Earlier isolated-container evidence reported timezone/demo-gate failures. The
  full local suite above ran with the repository's Pacific-time test command.
- `check:aws-production-readiness`, `check:aws-first-real-data-pilot` and `check:aws-production-foundation` fail identically on the clean tree because they need locally reviewed manifests that are not in this container.
