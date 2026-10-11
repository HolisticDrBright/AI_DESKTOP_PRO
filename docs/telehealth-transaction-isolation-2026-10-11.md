# Telehealth transaction isolation safeguard

The blocked 117 source candidate now refuses transaction modes whose retained
snapshot can hide a committed authority withdrawal. This is a source repair,
not a deployment, managed-owner qualification or PHI approval. All 116 parent
migrations remain byte-identical; no historical SQL or review receipt changes.

## Confirmed failure

The predecessor is `416febce99a7d9e69b919c6b21462a48e7b52a28`, selected
`telehealth-transfer-authority-candidate/3`. Its twenty native cases passed
under read committed. Its exact CI run 38121015804 completed successfully;
the missing-secret deployed-backend steps remained skipped.

The expanded native runner at `386ca89d65d173be21558104ee81fcf33b78b09e`
tested the same exact candidate/3 on PostgreSQL 17.7 with the restricted owner
and API role. Twenty existing cases passed and four new cases failed. Both
repeatable-read and serializable transactions admitted a transfer. In the two
withdrawal cases, a real serialization lock wait was observed, membership
withdrawal committed, and the transfer nevertheless committed one encounter,
one note and one receipt. The runner persisted the incorrect result rather than
rolling it back to make the diagnostic look safe. Local cluster shutdown was
confirmed.

Before report: `dist/native-authority-runs/authority-pg17-16ybNf/race-qualification.json`.
Managed, hosted, provider and PHI verification are false in that report.

These modes retain an earlier snapshot; a later shared advisory lock does not
refresh it. This agrees with the documented
[PostgreSQL 17 transaction isolation behavior](https://www.postgresql.org/docs/17/transaction-iso.html).
This finding is specific to the current-authority guarantee, not a claim that
serializable transactions are generally unsafe.

## Safeguard

`require_current_telehealth_authority` checks the actual transaction isolation
before any authority lookup, key read or tentative destination write. Only
read committed is supported. Other modes raise the controlled
`telehealth_transaction_isolation_refused` marker. The application must neither
retry inside the same stale transaction nor weaken the authority checks; an
operator must correct an unsupported transaction configuration.

The RDS adapter maps the exact marker to an opaque `request_invalid` refusal,
never raw database text. Its new regression failed before the mapper change
as `query_failed`; the remaining filtered tests were skipped, not executed.
The existing key fence, late shared authority fence, fresh identity bindings,
expiry checks, private owner policies, API denials and replay semantics remain.

The native runner adds four cases: refusal in each unsupported mode without
withdrawal, and refusal in each mode when withdrawal is attempted around a
serialization wait. A setup error, unknown wait or different error marker
cannot satisfy the new cases.

## Exact candidate

- Contract: `telehealth-transfer-authority-candidate/4`.
- Migration: `20261011040000_production_telehealth_transfer_authority.sql`.
- SQL SHA-256: `85990f316594c71aa054a5cdc449e75da3ac6bc04f744a30b7802f72a68d583e`.
- Ledger SHA-256: `34037e1ff05d583868c9a3796f673937777f88bcf4cebc2d589c6604626e9364`.
- Assembly SHA-256: `d73f67f2197886cf24360f773018a72c92d666789891e679e151ae2c65bd796a`.

Build output is `dist/aws-clinical-core/telehealth-transfer-authority-candidate-v4`.
Earlier artifacts and the exact 116 parent are not overwritten. The candidate
remains unregistered, not deployed, runtime admission false, activation blocked
and PHI false. No approval, consent, key or record is seeded.

## Evidence and remaining qualification

The candidate, runner and preserved-parent suites passed 92 tests. The candidate
build passed and its ledger/assembly were recomputed from emitted files. Native
after results, focused database suites, full lint/typecheck and exact successor
CI must be recorded separately once terminal; the predecessor's green CI is
not evidence for this successor.

Before any reviewed preserving upgrade or activation, verify managed role and
definition projections, the actual API transaction isolation, the fresh target
ledger, preservation/custody and rollback. Run the native and hosted authority
matrix, cross-owner/clinic negatives, replay races and broader global-fence
contention/deadlock cases. The local source report cannot admit an AWS target.
Existing 107-to-112 executable approvals do not authorize this 117 candidate.
No AWS write, external provider call, paid mobile build or launch occurs here.
