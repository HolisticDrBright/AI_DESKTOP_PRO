# Consumer identity deletion — the final reviewed deletion step

September 19, 2026. Original phase 3 increment, source only. Nothing deployed, no PHI, no paid build.

## What changed

- Migration `20260919020000_production_owned_identity_deletion.sql` adds an identity deletion
  ledger and two functions. `begin_owned_identity_deletion` refuses until the other eight
  stores each carry an accepted terminal receipt, then disables the owner's consumer identity
  in the database under the request lock and records the attempt. The database disable comes
  before any provider call, so a partial failure leaves the account locked, never
  half-deleted. Repeat calls return the existing attempt. A missing identity row refuses
  rather than inventing an outcome. `record_owned_identity_deletion` stores provider progress
  in order (disabled, signed out, deleted or absent), refuses regressions, refuses completion
  while a hold is active, and on deletion or absence records the `identity` fulfillment as
  `purged` or `not_applicable` with the provider-derived evidence. A completed row never
  changes again.
- `owned-identity-deletion.ts` runs the provider steps in order against the consumer user
  pool: disable, global sign-out, delete. A user the provider no longer knows counts as
  absent at any step; any other provider failure throws so nothing is recorded and the
  operator retries. Evidence is a hash over the pool, subject and confirmed state.
- The workforce operation `purgeIdentity` begins the ledger entry, calls the provider only
  when the entry is not yet complete, records the provider's outcome, and returns a fresh
  request detail. It is gated behind its own reviewed evidence hash. The Lambda template adds
  an `IdentityDeletionActive` branch granting exactly the three admin actions on the pinned
  consumer pool.

## Verification

PGlite runs of the real migration artifact cover the eight-store precondition, database
disable before provider work, idempotent repeat, the disabled identity losing owner access,
ordered provider progress, hold refusal, completion immutability, the absent outcome and the
missing-identity refusal. The operation test uses a provider double that fails once, then
confirms, and finishes with the reviewed `completeDeletion` succeeding. The deleter unit
test checks command order, pool binding, absence handling and error propagation. API and
infrastructure tests cover gating and permissions. Manifest count is 81.

## Not done

No hosted Cognito, Aurora or device run. The identity row remains as a disabled tombstone
so the ledger's references stay valid; the person row is not removed. Backups and audit
records follow the retention receipt, not this step. Activation evidence, operator
assignments and the consumer pool binding are human inputs and are not seeded.
