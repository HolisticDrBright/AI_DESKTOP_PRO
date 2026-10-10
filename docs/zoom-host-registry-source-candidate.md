# Zoom host registry source candidate

The clinic-specific Zoom host registry is an unreleased SQL candidate, not a deployed service. Its source is `infra/aws-clinical-core/source-candidates/zoom-host-authority.sql`. It is deliberately outside the canonical 112-migration assembly and the frozen schema upgrades reviewed by the owner. It seeds no identities, reviews, consent, provider authority or PHI activation.

## Implemented authority rules

Each immutable release belongs to one organization and practitioner. It records the Zoom account, canonical host ID, OAuth client ID, SDK application key, AWS account and region, exact secret ARN and immutable secret version, review digests, reviewer and expiry. Configuration is bounded and hashed in PostgreSQL. Only a current same-clinic owner or administrator may be named as reviewer; the host must be a current clinical workforce member. Review digests are references, not proof that the corresponding review occurred.

Releases have sequential revisions. Revocation is append-only. Admission always chooses the newest revision before checking expiry and revocation; it never falls back to an older release. The API role has no direct table access and cannot insert releases or revocations. Every release, revocation and binding admission has an immutable audit event. All four new tables have forced row-level security.

A visit binding captures the original appointment, patient, practitioner, slot, appointment version, release and intent. Admission locks the calendar row and host-release key in one transaction. The caller must be the assigned practitioner, the patient must be active, and the calendar appointment must still be an eligible telehealth visit. Exact intent retries return the original binding without another admission event. A different intent or current release does not overwrite an existing binding.

New-processing reads revalidate workforce identity, membership, current release and calendar. Rotation, revocation, expiry, patient archival, reassignment, cancellation, rescheduling and version changes refuse new processing. Calendar patient corrections are not frozen by a foreign key to the calendar's mutable patient field; the original visit patient remains separately bound to the same clinic.

Authorized reconciliation can read original release metadata after rotation or revocation. Such a read is explicitly `cleanup_metadata`; every response carries `providerActionAuthorized: false`. It does not authorize a secret fetch, meeting creation, SDK session, consent renewal, end/delete, or an erasure certificate. A clinic colleague is not automatically authorized to inspect the retained binding.

## Local qualification

Run `npx vitest run src/server/clinical-core/zoom-host-authority.database.test.ts --no-file-parallelism`.

The suite builds the actual canonical 112 source artifact, applies the real initial migration operator and subsequent SQL to in-memory PostgreSQL, then executes this candidate under the restricted API role. All records, review hashes and identities are fictional. It covers empty configuration, replay, clinic isolation, current and retained authority, expiry, revocation, identity withdrawal, calendar corrections, invalid secret configuration and table privileges. This is not AWS, Zoom, browser, device, rollback-upgrade or production activation evidence.

## Remaining integration

1. Create a distinct successor assembly and preserving upgrade with exact hashes, counts, security inspection and rollback acceptance. Preserve every canonical parent byte and obtain any required review of changed operators. Do not silently append this candidate to the approved 107-to-112 sequence.
2. Implement an authenticated, MFA-protected typed server binding with full schema/function identity checks. Add a reviewed release/revocation operator that verifies actual target, clinic and reviewer, provider account, SDK authorization and evidence artifacts. Do not give patients or the general API role release-write privileges.
3. Resolve credentials using the reviewed secret ARN and explicit Secrets Manager `VersionId`. Check the returned version and actual account/client/host/SDK fields against the binding. Pin IAM to reviewed secrets; do not use a caller-supplied ARN or `AWSCURRENT` as historical custody.
4. Carry the binding through durable meeting creation, adoption, cancellation, end, summary import and recovery. Resolve the database/provider-store admission gap with explicit durable reconciliation and fencing. Database locks and repeated provider observations are not an atomic Zoom lock.
5. Implement separately reviewed cleanup-only provider authority. Retained metadata cannot grant a destructive provider action or certify deletion. Keep current consent, calendar assignment and independent historical-record authorization intact.
6. Qualify revocation/rotation races, late writes, ambiguous provider records, two clinics and two participant roles against actual synthetic AWS and Zoom resources. Record exact matched backend/Desktop/mobile release identities, physical acceptance and agreement coverage before any live rollout.

The existing global-host runtime is not replaced by this candidate. Clinic onboarding, credential-version/provider binding and positive hosted acceptance remain unfinished. PHI and production activation stay off, and paid mobile builds remain held.
