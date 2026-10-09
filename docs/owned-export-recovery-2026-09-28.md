# Prepared export recovery — source and release boundary

## Defect reproduced

A lost request response, screen restart or device switch loses V2's in-memory job ID.
Submitting a different request UUID correctly hits the one-open-job conflict. Replaying
the original UUID succeeds, but the reopened app does not know it. The real production
migration artifact reproduces this, not a substitute SQL fixture.

## Repair

Migration 103 (`20260928010000_production_owned_privacy_export_discovery.sql`) adds
`find_latest_owned_privacy_export_job()`. It derives the owner from the existing verified
consumer context, requires `consent_management`, selects at most one newest row using the
existing `(owner_id, created_at, id)` index, and reuses the current get-job function's
owner check and committed deadline transition. A found job receives a `job.recovered`
audit event with zero exported rows. Private-table access and public function execution
remain denied. No approval or fixture rows are seeded.

`GET /clinical-core/consumer/personal/privacy-export/job/current` accepts no query fields,
body, caller owner or job ID. It returns `{contract: "personal-storage-export-current/1",
job: <existing public job view> | null}`. The API adds its usual `data` envelope. No storage
keys, object versions, download links or health payloads are returned. Existing activation,
qualification identity restrictions and reviewed export configuration apply. Discovery
does not create, advance, cancel, download, clean or reconcile an object. Expiry may update
the existing job state through the established get-job function.

The CloudFormation route is appended as Route19; existing route logical IDs are unchanged.
Consumer JWT verification remains required. Schema/table counts remain 123 tables and 81
contracts; the migration count becomes 103. Existing one-open-job and hourly limits remain.

V2 offers an explicit “Find my most recent prepared copy” before any new/oversized request.
The owner can review the recovered status, then deliberately continue, cancel or download.
No per-device pointer is needed, so response-loss and cross-device discovery use the same
server record. A null response is distinct from an unavailable or invalid service response.

## Evidence and outstanding acceptance

The production-artifact database tests reproduce the conflict and prove new-instance
recovery, same-owner discovery, foreign-owner and workforce refusal, wrong-purpose refusal,
private-table denial, committed overdue state, terminal recovery and zero object-store
calls during discovery. API tests refuse caller IDs/advance and missing export configuration.
Infrastructure tests compare deployed-route declarations with the API's exact allowlist.

Local verification: full Desktop suite 267 files, 3,243 passed and 11 skipped; focused
database/API/artifact/qualification tests 69 passed; personal-storage infrastructure
tests 7 passed. Typecheck, targeted lint, CloudFormation lint, personal-storage build and
the 103-migration production gate passed. The full suite used its normal configured
timezone with the unrelated `CLINICAL_SUPABASE_ANON_KEY` environment value unset.
V2 full suite: 1,891 passed and one existing skip; typecheck, lint and release-source
gates passed. Screen tests are not physical native-device acceptance.

No AWS migration/deployment, PHI activation or real-device run is performed by this change.
The isolated qualification database is still at the previously applied 102-migration
release until separately verified otherwise. Previously uploaded `1b54728` artifacts do
not include this repair. Build a new exact source release, inspect/apply the reviewed
103-migration artifact to the qualification target, update the manifest's actual migration
identity, and redeploy the personal-storage candidate before hosted recovery acceptance.
Do not relabel old uploads or invent replacement review hashes. Re-run rollback acceptance
and owner/foreign-owner/response-loss/device journeys on the matched release.

The new artifact builder release hash is
`8a9a8f321fafc1f4e2c20b44825845cc64bb291c1746b1cdacfe7f23bfa3c9c2`;
the actual production ledger identity hash is
`9bc30d04930816a523a7dc67b95944fba1d294dad4d71cf7585158fbc3a874aa`.
The gate's combined-SQL checksum is
`06572c1889bf6d3e6bf6c65e8b687dd10500d445338ebc3233f9b447fe5c543f`;
an earlier version of this note incorrectly called that the production identity.
All three are different contracts, not interchangeable approval evidence.
