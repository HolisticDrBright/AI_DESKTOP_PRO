# Telehealth native PostgreSQL source qualification

This increment qualifies the exact empty 112, 113 and 114 source assemblies on
local PostgreSQL 17.7. It is not an AWS upgrade, a deployment, an Aurora owner
profile, provider acceptance or approval for PHI. The existing PostgreSQL 18.3
runtime inspector and its literal schema pins remain unchanged.

## Source compiler and local runner

`scripts/compile-telehealth-schema-source.mjs` now shares the actual historical
106-migration installer and the exact subsequent migration bytes between its
embedded compiler and a separate native-source entry point. There is no weaker
hand-written bootstrap or inferred migration receipt.

The native entry point performs read-only identity and emptiness checks before
loading an installer. It admits only PostgreSQL 17.7, owner `postgres`, a randomly
named `alp_source_<32 lowercase hexadecimal characters>` database, no existing
clinical namespaces/roles and no public application relations. Qualification,
staging, production, `clinical_admin`, different versions and malformed counts
are refused before writes. Its output does not satisfy the current runtime
inspector's 18.3 identity check.

The Windows runner accepts only absolute binary and separate driver directories:

```powershell
npm run qualify:telehealth-native-source -- --binary-directory <absolute-pgsql-bin> --driver-directory <absolute-driver-directory>
```

It accepts no database URL, existing target, AWS profile, provider credentials,
approval, activation or PHI option. It creates its own loopback-only SCRAM cluster
and randomly named database, installs public pgcrypto to match the embedded
bootstrap, applies the real source, and verifies every selected application
table is empty. It deliberately creates unrelated objects outside the projected
schemas to perturb OIDs. A report is published only after the owned server's
shutdown is confirmed. Test directories and logs remain under ignored
`dist/native-source-runs/`; the temporary generated password file is removed.
No Windows service or global PostgreSQL configuration is installed.

## Native execution evidence

Two independent local clusters compiled the same exact assemblies on October
10, 2026. The second run, `pg17-4otnFU`, included OID perturbation and counted
zero rows in all 223 selected application tables, excluding only the migration
ledger. Both reports confirm shutdown. The earlier `pg17-Buq2qq` run did not
include the additional whole-table emptiness assertion. Both produced these
same source fingerprints:

| Prefix | Projected items | PostgreSQL 17.7 source schema SHA-256 |
| --- | ---: | --- |
| 112 | 1106 | `f2c5651da2a126d1259b1ae4f81c37c9e9cfee1446d9c7fe834f850dac842276` |
| 113 | 1116 | `34bbdd4b6604c1190a111f3d72bb543985bbae3ae9462a35d8912ab22b083ad2` |
| 114 | 1139 | `d5f35f0f11f8af91d098edc439c1a6b82fe5fc350e591d149b2bb88cfda365cb` |

These differ from the retained embedded 18.3 pins. Do not admit the live
qualification database by substituting these local `postgres` hashes for an
independently qualified 17.7/`clinical_admin` profile.

The runner fixes two native execution failures: captured Windows child pipes
could outlive server startup, and unqualified pgcrypto installation with
`pg_catalog` first could collide with built-in UUID functions. Startup now uses
the server's explicit log, and public pgcrypto is installed before the unchanged
historical installer. Both failed test clusters were stopped and produced no
success report. Error output omits installer data URLs, SQL and credentials.

## Tool provenance and limits

The local portable archive came from the vendor's HTTPS endpoint:
`https://get.enterprisedb.com/postgresql/postgresql-17.7-2-windows-x64-binaries.zip`.
The completed download was 333,961,446 bytes with observed SHA-256
`f256b0df079182965808d886ef132901e67f847a4ce1d439702dea8d55265998`.
`postgres.exe` reports 17.7 and has observed SHA-256
`098aafb55bf3bb121e2ef384ea3e8bcb7e0d8b2f340e2b830dd88c749fe83347`.
Its Windows signature status is **NotSigned**. These are observed provenance
hashes, not a separately authenticated published checksum, a signed binary or
production supply-chain approval. The older engine is used only to match the
current qualification target, not as a production security recommendation.

The separate test driver is `pg@8.16.3`, installed without lifecycle scripts.
No application dependency or lockfile was changed. Binaries, driver, cluster
and raw source reports are local artifacts, not committed runtime assets.

## Tests and remaining work

The separate [native race and key retirement increment](telehealth-native-races-and-key-retirement-2026-10-10.md)
adds an optional fictional matrix and a distinct forward repair; the default
empty-source run and embedded inspector pins remain unchanged. Matrix reports
do not assert the fixture-filled final database is empty.

`npm run test:telehealth-native-source` contains 22 credential-free negative
tests: rejected engine/owner/database identities, nonempty or malformed catalog
observations, and unsupported CLI inputs. Those tests assert no SQL mutation is
reached. The existing 75-test embedded source/inspector suite remains separate.
CI runs the negative native-source tests; it does not run the positive portable
Windows PostgreSQL fixture. Local positive evidence must not be described as
hosted CI or AWS acceptance.

Codex still owns the actual 17.7/`clinical_admin` profile, preserving 112→113→114
operators, durable custody and recovery, rollback rehearsals, native concurrent
lock-expiry/revoked-authority/retired-key tests and AWS hosted qualification.
The live qualification database was last observed at 107 migrations. The exact
replacement 107→111→112 review remains pending; sign-in is not review approval.
None of 113 or 114 is registered, approved or applied by this increment.

Claude's independent clinic-record privacy and V2 Clinic Data Center lane stays
unchanged. Coordinate the exact integration parent before numbering or packaging
a combined candidate. Preserve all holds, exclusions, verification requirements,
Core-only launch scope and the owner's hold on paid mobile builds.
