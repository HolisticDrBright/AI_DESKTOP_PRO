# Individual record removal honors owner legal holds

September 16, 2026. Original phase3 increment; no live policy or hold changed.

The account-wide privacy deletion function checked active legal holds, but the
ordinary per-record tombstone path lacked that check. Migration20260916070000
adds a BEFORE INSERT guard on owned_consumer_record_versions. A tombstone under
an active owner hold is refused with owned_record_legal_hold.

The guard uses the same owner advisory transaction lock as writes and hold
placement/release. It has an empty search path and no public execute privilege.
History remains append-only and no approval, policy or hold is seeded.
The production migration manifest includes the new file.

The database adapter maps only the authored hold markers to legal_hold; the
owned API returns403 without forwarding provider/SQL details. V2 renders safe
copy and does not remove its local copy on a held refusal. The change also
allows the existing account-wide privacy_request_held marker to surface safely.

Executed rollback-only foundation acceptance:124 checks, rollbackVerified true,
retainedSchema false, retainedFixtureRows0, clinicConnectionRequired false,
phiAllowed false. A fictional held meal could not be removed; its revision
stayed unchanged; removal succeeded after the fictional hold was released.
Everything was in the rolled-back transaction. This is not persistent migration,
hosted IAM/JWT acceptance or multi-transaction concurrency qualification.

Local full regression and exact-source CI accompany publication. The migration
operator and default-blocked personal-storage bundles build. A registration
test caught the initially missing migration-manifest entry; the manifest was
corrected before publication. Legal/retention policies and operational approval
remain human gates. No cloud deployment, PHI activation or paid mobile build.

Exact-source CI at52f1936 caught a second inventory check still expecting55
migrations. Updated the reviewed count to56 and explicitly require the hold
migration and trigger in the generated artifact. The failed CI run is retained;
unit success alone did not establish release-gate success.
