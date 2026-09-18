# Personal meal backup boundary

September 16, 2026. The independent consumer owned-record API accepts a strict
`personal-meal/1` payload for `meal_logs`. Shared contract and fictional fixture:
`src/contracts/personalMealBackup.ts` and `personalMealBackup.fixture.json`.
These are mirrored byte-for-byte in V2.

All seven nutrients and matching item totals are required; source labels,
known measured grams, food identity/portions, notes and historical suggestions
are retained. Duplicate items, source mismatch, unexpected keys, false authority
and oversized payloads are rejected. Copies are unverified historical records,
not current dietary advice. The existing summary format remains valid.

No migration, clinical-sharing payload expansion or authorization bypass:
existing owner RLS, nutrition consent, revision checks, idempotency, audit and
16 KiB JSONB limit apply. A stricter 12,000-byte encoded payload limit leaves
space for JSONB serialization.

## Executed evidence

`scripts/test-aws-owned-consumer-records.ps1 -ConfirmRollbackOnly` completed
**122 checks** against the PHI-disabled AWS foundation in account173535830222:
rollback verified; no retained schema or fixture rows; no clinic connection
required; PHI false. Added checks cover missing consent, full round trip,
duplicate retry, inconsistent totals, stale revisions, cross-owner reads,
withdrawal, regrant and deletion markers. All fixture approvals exist only
inside the rolled-back test transaction and do not approve live operation.

Five focused adapter/validator tests cover owned-only acceptance, legacy
compatibility, invalid payloads, size and actual adapter dispatch.
This is not hosted API Gateway/Cognito, mobile or practitioner-screen evidence.

Remaining: production personal-storage deployment/role qualification,
authenticated hosted and physical device acceptance, correction/deletion
reconciliation and full privacy fulfillment. No PHI flag, deployed service,
provider approval, clinical hold or paid build changed.
