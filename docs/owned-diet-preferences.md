# Reviewed diet-preference backup and recovery

September 17, 2026. Original phases 1/3 increment; source candidate only.

## Behavior

Nutrition Settings now offers separate reviews for saving device preferences,
restoring the saved copy, retrying an interrupted save and logically removing
the saved copy. Nothing uploads or restores on hydration. The view compares
diet selections, allergy text, notes and timestamps, then requires confirmation.
Unsaved form edits must be saved locally first. Restoring preferences preserves
meals, drafts and account identity; retrying an earlier save preserves newer
device edits. Blank allergy text is "Not entered", never verified absence.
These are patient-reported preferences, not a prescribed therapeutic diet.

The owner-scoped singleton in `diet_preferences` uses
`personal-diet-preferences/1`. The authenticated owner provides authority, not
the shared record ID. The same nutrition consent, owner lock, revision checks,
durable request journal and server audit apply. This is not clinic sharing;
the legacy clinic collection whitelist is unchanged. No AI/context expansion
or clinical advice activation was added.

Reviews are process-local, exact-content/revision-bound and expire after ten
minutes. Consent, owner, remote/local revision and pending intent are rechecked
before applying. The screen discards review state on background/unmount and
fences late results. Already-issued cloud work may still finish: UI departure
does not imply cancellation. Interrupted requests retain the original idempotency
key through the existing encrypted personal-record client.

SQL independently validates the singleton, exact keys, bounded strings, diet
identifiers without duplicates, timestamp and patient-reported provenance.
Invalid payloads cannot bypass validation through direct API-role function calls.
Logical removal leaves the device copy and retained history/audit/backups intact;
it is not account erasure. Current preference versions and tombstones participate
in the existing private export, correction inventory and legal-hold controls.
V2 recognizes the collection in cloud exports and encrypted pending-command
device exports. The ordinary nutrition snapshot still contains local preferences.

## Verification

- Desktop: full official suite 2846 PASS /11 existing skips /220 files; typecheck
  passed; lint zero errors/four existing warnings. First run found the migration
  artifact assertion still expecting75. It now requires76 and the exact new
  final migration; no assertion was removed. The76-migration zero-seed gate passes.
  The actual personal-storage Lambda bundles successfully and returns503 with
  production_not_activated/phiAllowed:false when run in its blocked configuration.
  Both repositories carry byte-identical preference contracts (SHA-256
  c997f61e47b3bf018a510eb38ec180a9a2c99f0ca9341dfb8fc14bf93596bf20).
- Four actual canonical-SQL tests in isolated PGlite cover owner isolation,
  exact replay/conflict, malformed payload rejection, consent withdrawal/regrant,
  privacy export/correction inventory, legal-hold refusal and retained tombstones.
  The added hold assertion and artifact suite separately passed6 tests.
- V2: full suite1621 PASS /one existing hosted skip; typecheck/lint passed.
  Capability, TestFlight-source, container and workload gates passed.
  Eighteen focused recovery tests include a real personal-record client and
  account cache across a simulated lost-response/restart. The original command
  is replayed, newer local edits remain, and failed disk saving cannot claim a
  local receipt. Fresh empty-cache timestamps are now stable within a store,
  avoiding false conflicts on first-device restoration.
- Native screens are typechecked and source wiring is asserted; no rendered
  phone interaction or physical iOS/Android acceptance is claimed.

## Deployment and remaining requirements

Backend migration76 and owned API must be deployed and synthetically qualified
before this client feature is enabled. Review the existing nutrition consent
release to confirm that it explicitly covers these preference fields; this work
does not sign consent copy or seed approvals. The existing personal-service
activation and allowed-scope gates remain unchanged and blocked in the current
testing release. No data was uploaded, changed or deleted in a live environment.

Build70 and its matching synthetic API remain at V2c5b4d61. This source increment
is not in that binary. No extra paid build was started. Hosted Desktop remains
blocked by the expired ai-synthetic-staging login.

Hosted authentication/consent/concurrency/hold/export qualification, physical
two-account/two-device recovery and all other original phase requirements remain.
No clinical hold, source verification, provider approval or PHI flag changed.
