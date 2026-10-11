# Clinic native source qualification

The exact clinic 116-migration candidate has a separate local PostgreSQL 17.7
source compiler. It checks schema construction and permissions under a fresh
non-superuser owner. It cannot authorize an existing database, a preserving
upgrade, an AWS deployment, a provider or PHI activation.

## Exact source and owner

The compiler requires clinic privacy candidate `/4`, its exact 115 parent, all
116 ordered migration bytes and the whole assembly and ledger hashes recorded
in `clinic-source-integration-2026-10-10.md`. Unknown permission claims, altered
posture, seeded approvals and historical candidates are refused. The original
112/113/114 compiler remains separate; the new compiler verifies its exact prefix
before adding 115 and 116 in transactions with whole-ledger readback.

The owner is `clinical_admin`, also the session and database owner, with
NOSUPERUSER, NOBYPASSRLS, NOREPLICATION, CREATEDB and CREATEROLE. It starts with
no memberships or application objects. This local profile does not emulate
Aurora managed-role semantics. Bootstrap disconnects before compilation; a
separately identified local `postgres` auditor counts rows in a read-only
transaction because forced-RLS and private tables cannot all be counted by the
restricted owner.

## Local procedure

Run only from a clean source commit, using the already reviewed disposable
local binary and driver directories:

```powershell
npm run test:clinic-native-source
npm run qualify:clinic-native-source -- --binary-directory <absolute-pgsql-bin> --driver-directory <absolute-driver-directory>
```

The Windows runner creates a fresh loopback-only SCRAM cluster and a generated
database. It admits no existing target, credential, AWS profile, matrix,
approval or activation flag. PostgreSQL must report 17.7 and the separate driver
must be `pg` 8.16.3. Native children inherit only operating-system path and
temporary-directory settings, not cloud/provider credentials or database URLs.
Temporary generated authentication is never printed. Unrelated objects perturb
OIDs outside the projected schemas.

A successful report requires snapshots for 112 through 116, five direct clinic
table reads denied to `clinical_core_api`, and zero application rows in exactly
228 selected tables. Publication occurs only after the owned server is confirmed
stopped and the same clean source commit is rechecked. Reports and test clusters
remain in ignored `dist/native-source-runs/`; no global service is installed.

## Evidence and remaining requirements

Credential-free source and argument refusal tests are wired into CI. Positive
native runs must be recorded with their exact commit, independent report
directories, schema fingerprints, table counts and confirmed shutdown. A local
report is never hosted acceptance or permission to apply these migrations.

The existing runtime inspector and historical operators are unchanged. A
preserving 112-to-116 upgrade still needs its own protected-row, custody and
rollback implementation and review, followed by real PostgreSQL/Aurora lock,
authority, key-retirement and clinic privacy journeys. No seed, fixture,
disclosure release, secret or policy approval is synthesized by this compiler.
