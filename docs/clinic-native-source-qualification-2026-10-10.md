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

All 66 credential-free source and argument refusal tests pass and are wired into
CI. Typecheck and targeted lint pass. Two independent positive native runs,
`clinic-pg17-k1j6AG` and `clinic-pg17-vqhR4y`, used clean source commit
`52d17428d4a68d44508c6e3bf4873179e7cd7ba6`. Both denied all five direct reads,
counted zero application rows in all 228 tables, and confirmed shutdown. Their
complete schema projections match at every prefix:

| Prefix | Projected items | PostgreSQL 17.7 restricted owner schema SHA256 |
| --- | ---: | --- |
| 112 | 1111 | ee570c4f14e36f94552a7267a28c47486260fd0acd2793fc4043d53b2903f640 |
| 113 | 1121 | 0271c62d9f0846c19843401b00b9b310867ddf850f92fda4deef132b00f7375d |
| 114 | 1144 | 8bb707f52e9ca2049ea6d6154836c5658a27a463eb5ea7f1757c9783bf6b5c8d |
| 115 | 1144 | b4f1b20842e45b02823f39638b491565a558a4aa2f74149021555a541ada6721 |
| 116 | 1172 | fe46eccd49db188f6c1e5dfe8e544506e2484fe3a11e6fe5528a7cca57529855 |

The source-only contracts are `clinic-restricted-owner-source/1` and
`clinic-native-source-qualification/1`. The binary provenance and its unsigned
Windows status are unchanged from the telehealth native-source notes. These
fingerprints describe the local owner profile, not Aurora managed memberships.
A local report is never hosted acceptance or permission to apply migrations.

## Independent definition check

The native runner now requires `assertClinicCompiledLocalSource` before it can
publish a report. That check validates the pinned receipt and exact executable
assembly, then compares every compiled object digest at all five prefixes to
the independent source receipt. It also checks the compiler, projection and
restricted-owner identities. Merely changing the permitted object names is not
enough; a changed function, relation, role, membership or type digest refuses.

Only the generated disposable database nonce may differ between runs. Engine,
owner, session owner, grantor, membership, permission and definition differences
are not normalized away. An existing qualification or production database is
refused. Expectations cannot be substituted with a target-shaped receipt.

`npm run test:clinic-source-definitions` has 80 positive and refusal cases. It
and the existing 66 native-source tests pass, with typecheck and targeted lint.
The new verification is an input to the separately compiled managed profile,
not that profile. The source rollback kernel remains observation-only for
permitted changed definitions; its managed admission and forward custody work
are still required. No runtime schema pin, historical operator or selected SQL
byte was changed by this check. New positive native runs belong to the exact
clean source reported by the runner, not the historical 52d1742 results above.

The existing runtime inspector and historical operators are unchanged. A
preserving 112-to-116 upgrade still needs its own protected-row, custody and
rollback implementation and review, followed by real PostgreSQL/Aurora lock,
authority, key-retirement and clinic privacy journeys. No seed, fixture,
disclosure release, secret or policy approval is synthesized by this compiler.
