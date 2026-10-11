# Clinic privacy source integration

The clinic privacy candidate now follows the selected telehealth lifecycle,
clinic Zoom-host and admission-key retirement safeguards. The combined source
remains blocked, unapplied and unregistered. It is not a deployment approval or
a completed commercial-readiness phase.

## Integrated source

The integration branch preserves the source histories of Desktop `85fa5fc`
(clinic target guard, portability and consent ordering), `10443ee` (native-owner
preserving operator repair), and `f0f9271` (restricted-owner source qualification
above lifecycle `/4`, host `/1` and key-fence `/1`). It is a separate working copy;
none of those reviewed branches or their AWS execution packets is overwritten.

The merge initially combined duplicate expiry checks from lifecycle `/3` with
`/4`. The selected lifecycle file was restored to the exact `/4` bytes, which
already check expiry after authority/serialization, before drafting, after
drafting and before returning a receipt. The `/4` SQL hash remains
`78f03a282b3f5ba97af2f50683aeab0fc1e20d19d77ec7111fc28116ede7bab7`.
The consent test retains both explicit chronology assertions and the two
equal-timestamp insertion-order cases.

## Exact new candidate

`clinic-record-privacy-candidate/4` appends one migration above the exact
115-migration `telehealth-transfer-key-fence-candidate/1`. All 115 parent files
are copied byte for byte. The parent metadata shape, posture, extension, whole
ordered ledger and assembly must match; extra permission claims are refused.

| Identity | SHA256 |
| --- | --- |
| Parent 115 ledger | cf9e9a80ec6e2973cf53ce1718ce1b48b48e6c62c90af360fb33bb45d6635119 |
| Parent 115 assembly | 3172e6b60c62edbb9e9cec10fbc74fe908eb7c41bad562e499b08620d5d670a9 |
| Clinic extension | c326461d26c0b2c4e93083f84e4b75cced0c72d6457be16634e2df9a5852714f |
| Successor 116 ledger | 3d6858c8c5ce16e9b903a75e9e890bca7ec3e5052e4cd53bcf011f307d59ab4d |
| Successor 116 assembly | 631615dd75b3c909c56997df36b53e1f43c8324b53a745eb55dd13369dee7fdc |

The extension filename remains
`20261011000000_production_clinic_record_privacy.sql`. Only its introductory
source-lineage comment changes from the old `/3` proposal; its executable SQL is
unchanged. Its new hash and candidate revision prevent the earlier 114 proposal
from being treated as this source. Deployment builders, compiled runtime identity,
report requirements, whole-ledger target guards and tests now require 116.
No clinical hold, source verification, disclosure exclusion or approval is changed.

## Verification

The seven source/artifact/target/report suites pass 171 tests, including drift
in each of lifecycle, host and key-fence parent extensions. Six real embedded
database/runtime suites pass 83 tests, including the 30-case clinic handler
journey, missing-copy consent refusal, patient-bound transfer and late expiry.
Typecheck, targeted lint, clinical-core, 223-RPC/five-read-model compatibility
and 228-operation inventory gates pass. A mistyped compatibility alias did not
run a check; the correct gate subsequently passed without changing it.

These are local source and embedded PostgreSQL results, not real AWS, Zoom,
managed-role, browser, device or PHI evidence. Full-suite and exact-source CI
must be recorded separately after the source is committed and frozen.

## Remaining integration and execution

1. Extend restricted-owner native source qualification to this exact 116 artifact
   and preserve metadata/permissions for its added clinic tables and functions.
   Existing 112/113/114 qualification is not automatically 116 qualification.
2. Prepare a separately reviewed preserving 112-to-116 operator with exact ledger,
   custody, protected-row and rollback evidence. Existing 107-to-112 approval is
   not permission to append this candidate or reuse a changed executable hash.
3. Register canonical migration/coverage and selected source only after review.
   Build clean exact backend/Desktop candidates and verify real target identity
   with the guard before any fictional fixtures, reviewed release or hosted run.
4. Execute real locks, authority/key revocation, concurrent transfer and privacy
   journeys against the isolated target; then matched mobile releases, physical
   iOS/Android, provider/store acceptance and independent policy/agreement review.

PHI stays disabled and activation blocked. No secret retrieval, AWS call, schema
apply, release/identity/consent seeding, provider call, paid mobile build or
production launch occurred in this source integration.
