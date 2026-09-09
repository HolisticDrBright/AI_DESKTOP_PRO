# Independent personal lab history — September 8, 2026

Status: implemented source candidate, not deployed or PHI-enabled. This closes a
lab-history/context gap; it does **not** complete production upload/analysis,
clinical source verification, privacy fulfillment or commercial release.

## Data contract and consent

The personal API accepts `lab_observations`, separate from the legacy clinic
collection list. Each observation has stable record, panel and marker UUIDs,
panel/marker names, an exact finite numeric value, nullable unit, imported date,
nullable explicitly reported range and `consumer_import_unverified` status.
Unknown fields, caller-selected owners, invented approval and functional-range
fields are refused. Missing dates/ambiguous legacy identifiers need review;
the importer never substitutes today or makes up a source identifier.

Migration `20260908110000` adds the collection and `lab_history` consent scope to
the existing owner-only versioned store. Existing RLS, immutable history,
request-id/hash duplicate protection, optimistic revisions, consent withdrawal,
metadata audits and restricted function grants apply. No approved consent text,
signatures, identities or clinical data are seeded. Assembled source: **49
migrations**; persistent Aurora remains **46**, with the last three tested only
inside rollback transactions. The migration-48 empty-release-table prerequisite
still applies if another operator has populated migration 47 independently.

Ask ALP requires both AI-context consent and lab-history consent plus enabled
release scopes. It pages through up to 1,000 observations, refuses repeated pages
or larger histories, rechecks consent revisions after assembly, and preserves
zero values, marker names, units and dates. Imported ranges remain stored for
review but are **not promoted into verified conventional/functional ranges** in
the AI snapshot. Source status remains explicit. No protocol is inferred approved.
V2 production chat no longer permits client context to override this server
snapshot, including after consent withdrawal. Synthetic context behavior stays
unchanged.

## Mobile ownership and copy flow

Personal data storage offers a separate lab-history consent and explicit copy
action. It validates the whole batch before writing and uses stable panel/marker
keys for safe identical retries. Partial saves report their count rather than
claiming a completed transfer. This action neither reruns analysis nor shares
with Desktop.

Production LabsProvider now uses encrypted owner-scoped caches and owner-tagged
state/query keys. Reads, writes and deletes verify the active account; a late
analysis result cannot be retagged for a new login. Unattributed legacy device
data is preserved but is **not automatically adopted into production**. The
existing synthetic cache path remains unchanged. Loading the production personal
cache does not automatically share it with a clinic. Other providers' cache
ownership and full cloud hydration still need separate qualification.

## Verification

- Physical rollback-only API-handler → real adapter → RDS Data API → Aurora:
  **45 assertions passed**, including lab-specific consent, own reads, direct
  cross-owner RLS, duplicate writes, measured zero in context and withdrawal.
  Independent rollback check: no retained schema, identities or fixture rows.
  The initial failure exposed missing per-request savepoint rollback in the
  single-transaction acceptance harness; that harness is now corrected.
- This is **not** hosted API Gateway, model inference or on-phone acceptance.
- Desktop: 1,167 unit tests passed, 10 skipped; typecheck passed; four pre-existing
  lint warnings. Migration build/check passed with zero seeded rows. Personal
  Lambda rebuilt with the unchanged disabled/logs-only template.
- V2 verification details and remaining device work are recorded in
  `expo/docs/personal-lab-history-readiness.md` in the mobile repository.

## Still required

Production document/job ownership, extraction verification and the signed reviewed
range release remain unfinished. So do the worker completion → durable verified
history path, full production protocol/intake context, cloud hydration and
conflict UI, deletion/export across all copies, reviewed consent/scope activation,
and exact hosted/device acceptance. Oversized histories currently refuse context
rather than silently dropping markers; scalable server-side selection is a future
step. No paid mobile build, live-data enablement or public Desktop deployment was
performed in this increment.
