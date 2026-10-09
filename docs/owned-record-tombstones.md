# Owned record tombstone listing — September 19, 2026

Personal-storage listing returns live records only, so a device that still holds a copy
of a record the owner removed on another device could never learn about it, and a reload
would quietly resurrect the copy. Migration 82
(`20260919030000_production_owned_record_tombstones.sql`) adds
`clinical_core.list_owned_consumer_tombstones(collection, limit, after_time, after_id)`:
the owner's records whose latest version is a tombstone, as `recordId`, `revision`,
`deleted: true` and `receivedAt`, never a payload. Identity, `clinical_data` purpose,
active scope consent, bounds and pagination behave exactly like live listing, and each
call records the same `records.listed` audit event.

The adapter exposes it as `listTombstones`, parsed with exact keys. The API reuses
`GET /clinical-core/consumer/personal/records` with `view=tombstones`; any other view is a
400 and the feature-scope gate applies unchanged, so no route or template changed.

This is information for a device to review, not proof of erasure. Device copies, recovery
archives, backups and other stores are untouched; V2 (`expo/docs/cross-device-lab-deletion.md`)
shows the owner which local lab panels were removed elsewhere and removes only the ones
they confirm. No hosted deployment carries the migration yet; the PGlite run is the only
evidence. PHI remains disabled.
