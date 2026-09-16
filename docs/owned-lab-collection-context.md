# Owned lab observations: collection context persistence

September 16, 2026. Source engineering only; nothing deployed, no PHI, no signed release.

## What changed

- `lab_observations` records in production-owned storage accept an optional `collectionContext` (`ownedCollectionContextSchema` in `src/server/clinical-core/owned-lab-observations.ts`). It carries the completed **age at the draw** (`ageAtDraw {value, unit: days|months|years}`), `observedOn`, sex, pregnancy status, cycle phase, reproductive stage, contraception, pregnancy trimester and assay identity. The dimension vocabularies are shared with the range population schema (`collectionDimensions`) so stored context cannot drift from signed range populations.
- The stored copy never carries a date of birth. Owned storage already refuses direct-identifier keys (`dateOfBirth`, `email`, `ssn`, and so on) at the payload layer; that rule is unchanged. The device re-derives a range-equivalent context from its own profile on restore and withholds the context when the recorded age does not reproduce exactly.
- `observedOn` must equal the observation's `drawnAt` calendar day. Context describing a different draw is refused as `owned_lab_observation_invalid`.

## Consent enforcement

- `lab_history` consent is enforced by the SQL write function as before.
- A write whose context carries any reproductive dimension additionally requires an active `reproductive_health` consent. The adapter reads `clinical_core.get_owned_storage_consent_state('reproductive_health')` **inside the same transaction** as the write, so a withdrawal cannot race the write. Refusal maps to `consent_required` (HTTP 403).
- Reads (`list`, `recent`, `get`) withhold the whole `collectionContext` of any record with reproductive dimensions while reproductive consent is not active. A partial record whose nulls read as "not pregnant" is never returned. The stored record stays intact for a later re-grant, correction or deletion; withdrawal is not object erasure.
- Non-reproductive context (age at draw, sex, assay) travels under `lab_history` consent only and is never withheld by the reproductive check.

## Not done here

- The chat-context builder still ignores `collectionContext`; it emits explicit lab fields only. Range matching against a signed `lab-ranges/2` release still needs a full `collectionRangeContextSchema` context with a date of birth, supplied per request by the device. A server-side age-at-draw matcher was deliberately not added so the reviewed range semantics stay unchanged.
- The clinic-sharing `lab-result/1` import does not carry collection context. That transport hashes its canonical payload for de-duplication and its SQL signature would need a migration; it was left out of this increment.
- No hosted, Aurora or physical-device verification. Unit tests cover the validator, the in-transaction consent read and the read-path withholding with mocked queries only.

## Verification

- Desktop `npm run test:unit`: the new and updated tests in `owned-lab-observations.test.ts` and `owned-consumer-records.test.ts` pass. Two failures are pre-existing on the untouched tree in this container (`src/lib/dates.test.ts` Pacific-time expectation and `src/lib/edition.server.test.ts` demo credential gate).
- `check:aws-production-readiness`, `check:aws-first-real-data-pilot` and `check:aws-production-foundation` fail identically on the clean tree because they need locally reviewed manifests that are not in this container.
