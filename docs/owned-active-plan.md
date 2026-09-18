# Authoritative personal active-plan pointer

September 16, 2026. Original phase 1 (account continuity). Source only: no
persistent migration, deployment, real data or paid build.

Migration `20260916030000_production_owned_active_plan.sql` adds an owner-scoped
pointer (`owned_consumer_active_plans`) to exactly one immutable `protocols`
record revision, plus append-only lineage (`owned_consumer_active_plan_history`:
adopted / released / record_deleted, idempotent by request identity). Adoption is
an explicit owner request under the same per-owner advisory lock as record and
consent writes: it requires current `protocols_supplements` consent at the exact
revision, the record to be the owner's latest non-deleted revision, and the
predecessor (or none) to match the current pointer. Re-adopting the same
revision, a stale or deleted record, a mismatched predecessor or a reused request
with different content is refused (`40001`). Tombstoning the adopted record
clears the pointer in the same transaction with `record_deleted` lineage.

Routes on the personal storage candidate (`GET/POST .../personal/active-plan`,
`POST .../active-plan/release`) require the plans scope and the verified consumer
context; the server reads content only to verify its canonical digest under the
owner lock, never interprets it as clinical approval, never promotes
consumer-written generation metadata, and never adopts on its own. The
rollback-only Aurora acceptance gains an `active_plan` stage (adoption, replay,
stale/deleted refusals, predecessor conflict, cross-owner isolation, tombstone
reconciliation). The September 16 integration repair physically passed the
expanded rollback-only Aurora suite (107 assertions total), including public
handler adoption/digest/replay checks. No persistent migration or deployment.

Still open for phase 1: V2 resolution of the pointer against device copies,
adoption from plan application and copy review, physical two-device tests, and
release/deletion of a lost device's local copies.
