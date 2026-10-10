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

## Typed database interface

`src/server/clinical-core/zoom-host-registry.ts` now composes the actual SQL with a typed server-only interface. The interface checks 15 function bodies and their signatures, result types, languages, volatility, security mode and search paths against pins supplied by the compiled source artifact. It checks the candidate function inventory, API and PUBLIC permissions, forced RLS, absence of table policies and the six required triggers before setting request context. It refuses altered response identity, configuration hashes, unexpected fields and any provider-authorization claim. A malformed response aborts the transaction, including a newly inserted binding.

The compiled execution target pins mode, AWS account and Ohio region. Qualification code refuses production configuration. It retains the original secret version on a cleanup-metadata read after rotation; that metadata remains explicitly unauthorized for provider actions. Actual RDS database errors map to bounded categories without exposing provider or database details.

The real-SQL suite now contains 70 passing tests, including 22 tests of the composed interface. Five focused registry, driver, host-observation, credential and telehealth suites pass 483 tests without skips. TypeScript, targeted ESLint and diff checks pass. These are local checks only.

This interface is not a JWT/MFA verifier or an authenticated HTTP route. Its drift checks protect the specified contract surface; they do not independently verify every parent table, constraint, role membership, migration ledger or assembly identity. Those checks remain required in the release and authenticated execution boundary. The source credential resolver below now uses this interface; the deployed telehealth handler and provider actions do not use it yet.

## Exact secret version resolver

`src/server/clinical-core/zoom-host-credentials.ts` composes the source-pinned registry with Secrets Manager. It requires an existing immutable visit binding, a workforce context and a deployment-reviewed allowlist of complete secret ARNs in the compiled target account and region. It never creates a binding, accepts cleanup metadata, selects a global secret or retries against a rotated current version.

Before fetching credentials, the resolver reads current new-processing authority and compares the binding, clinic, patient, practitioner, appointment version and times, intent, release and configuration digest with the original durable binding. It sends `GetSecretValue` with the exact `SecretId` and `VersionId`, verifies the successful response's ARN and version, refuses binary/malformed/oversized values, and compares the actual Zoom account, client, canonical host and SDK application key with the release. All credentials come from one bounded secret string. AWS documents that omitting both version selectors returns `AWSCURRENT`; [GetSecretValue](https://docs.aws.amazon.com/secretsmanager/latest/apireference/API_GetSecretValue.html) is called with an explicit immutable version here.

The resolver rechecks database authority after the secret read and on cache hits. Rotation, revocation, suspended host membership, an archived patient, reassignment or rescheduling during the read withholds credentials. The request-local cache includes the secret version; a failed read remains refused within that request. The next request performs a fresh read. A shared deadline and caller cancellation bound both database waiting and secret waiting, and the AWS command receives the abort signal. Local waiting/cancellation is not remote settlement, deletion or an atomic provider lock.

Use the resolver inside `runZoomCredentialRequest`, after the future authenticated handler has verified JWT/MFA, full release/schema identity, applicable consent and durable admission. The resolver accepts the stored original binding, not a replacement supplied by a browser. It returns server-only credentials, never an SDK session or new provider permission. The allowlist does not grant IAM permissions; reviewed exact-secret IAM and any KMS grant still need the separate deployment integration. General API table grants remain absent.

Thirty-one added tests exercise this composition against the actual restricted-role SQL and a fictional Secrets Manager transport. The complete database suite passes 101 tests; five focused registry, credential-snapshot, host-observation, telehealth and RDS-driver files pass 543 tests without skips. The collected test list confirms those counts. TypeScript, targeted lint and diff checks pass. These results do not prove live Secrets Manager/KMS, deployed IAM, Zoom or HTTP authentication. The earlier full unit run at the response-repair predecessor passed 6,713 tests; it is not a full-suite result for this later resolver increment.

The subsequent full run crossed a source commit during the qualification build and failed its parent/child source-identity comparison: 432 files passed and one setup failed, with 6,666 tests passing, 89 skipped and no release qualification. Its 78 inventory cases were skipped by the failed setup, not accepted. After source stabilized at `5fd2f4e5e2a672aa1656dad99bd0406e43623824`, all 78 inventory cases passed in a separate run. The source-change refusal stays intact. A complete unchanged-source rerun is still required; the isolated pass does not retroactively turn the failed full run into a pass.

## Remaining integration

1. Create a distinct successor assembly and preserving upgrade with exact hashes, counts, security inspection and rollback acceptance. Preserve every canonical parent byte and obtain any required review of changed operators. Do not silently append this candidate to the approved 107-to-112 sequence.
2. Wire the typed interface into an authenticated, MFA-protected handler with full schema and release identity checks. Add a reviewed release/revocation operator that verifies actual target, clinic and reviewer, provider account, SDK authorization and evidence artifacts. Do not give patients or the general API role release-write privileges.
3. Integrate the locally verified exact-version resolver into the released authenticated provider boundary. Pin actual IAM to reviewed secrets and KMS resources, verify the live response/version and rotation failures, and prevent caller-supplied bindings or ARNs. Do not equate the source allowlist with deployed IAM or a reviewed provider activation.
4. Carry the binding through durable meeting creation, adoption, cancellation, end, summary import and recovery. Resolve the database/provider-store admission gap with explicit durable reconciliation and fencing. Database locks and repeated provider observations are not an atomic Zoom lock.
5. Implement separately reviewed cleanup-only provider authority. Retained metadata cannot grant a destructive provider action or certify deletion. Keep current consent, calendar assignment and independent historical-record authorization intact.
6. Qualify revocation/rotation races, late writes, ambiguous provider records, two clinics and two participant roles against actual synthetic AWS and Zoom resources. Record exact matched backend/Desktop/mobile release identities, physical acceptance and agreement coverage before any live rollout.

The existing global-host runtime is not replaced by this candidate. Clinic onboarding, credential-version/provider binding and positive hosted acceptance remain unfinished. PHI and production activation stay off, and paid mobile builds remain held.
