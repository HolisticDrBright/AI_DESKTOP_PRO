# Telehealth restricted owner source qualification

The exact 112, 113 and 114 assemblies compile on local PostgreSQL 17.7 under
`clinical_admin` without superuser or row-security bypass. This closes a local
source-permission evidence gap, not the managed Aurora admission or preserving
upgrade. PHI, provider authority and upgrade authority remain disabled.

## Restricted source boundary

The new `telehealth-restricted-owner-source/1` compiler requires a fresh random
`alp_owner_source_<32 lowercase hexadecimal characters>` database, current and
session owner `clinical_admin`, that same database owner, PostgreSQL 17.7, and
exact typed role attributes. The role must have LOGIN, INHERIT, CREATEDB and
CREATEROLE; it must not have SUPERUSER, BYPASSRLS or REPLICATION. No pre-existing
clinical namespaces, application roles, public application relations or owner
memberships are admitted. SET ROLE from a superuser session is refused.

The runner creates that role and its database in its own disposable loopback
cluster, disconnects the bootstrap user, and installs pgcrypto, runs the actual
historical installer and subsequent source, and projects metadata as the
restricted owner. Generated credentials are not accepted as inputs or printed.

```powershell
npm run qualify:telehealth-native-source -- --binary-directory <absolute-pgsql-bin> --driver-directory <absolute-driver-directory> --owner-profile clinical-admin
```

Only this empty-source mode accepts the owner profile. It does not accept an
existing target, cloud credentials, qualification manifest or race matrix.
The existing runtime inspector keeps its 18.3/postgres pins and rejects the new
contract. No engine or owner is renamed to make a runtime target pass.

## Empty table audit

The first restricted run completed compilation but failed the whole-table count
with SQLSTATE 42501: the owner cannot freely read every protected table. It
produced no success report. The runner now uses a separately identified local
`postgres` auditor in a read-only transaction solely to count selected tables.
It performs no compilation, projection, migration or grants through that auditor.
The report names both the compilation owner and the inventory owner and does not
claim these reads succeed as the restricted user. All owned servers are confirmed
stopped before a success report is published.

Two successful independent local runs, `pg17-LVhOqe` and `pg17-cRZZJj`, counted
zero rows in 223 application tables, excluding the ledger. Both confirmed
shutdown and compiled identical independent source fingerprints:

| Prefix | Items | Local restricted owner schema SHA-256 |
| --- | ---: | --- |
| 112 | 1111 | `ee570c4f14e36f94552a7267a28c47486260fd0acd2793fc4043d53b2903f640` |
| 113 | 1121 | `0271c62d9f0846c19843401b00b9b310867ddf850f92fda4deef132b00f7375d` |
| 114 | 1144 | `8bb707f52e9ca2049ea6d6154836c5658a27a463eb5ea7f1757c9783bf6b5c8d` |

These are source digests, not security approval hashes. Raw reports remain in
ignored `dist/native-source-runs/`. Portable binary provenance and limitations
are in [native source qualification](telehealth-native-source-qualification-2026-10-10.md).

## Managed Aurora remains separate

AWS read-only observation on October 10 showed `clinical_core_qualification`
still at 107 migrations, engine 17.7 and owner `clinical_admin`, with no SUPERUSER
or BYPASSRLS. That owner has managed `rds_superuser` and application memberships;
the fresh local role does not emulate those grants. The compiler consequently
records `managedRoleSemanticsVerified:false` and `runtimeAdmission:false`.
[AWS documents the managed role privileges separately](https://docs.aws.amazon.com/AmazonRDS/latest/AuroraUserGuide/Appendix.PostgreSQL.CommonDBATasks.Roles.rds_superuser.html).

Do not substitute these local fingerprints for independently qualified Aurora
metadata. The reviewed replacement 107-to-111 and 111-to-112 operators remain
pending owner approval. Later preserving upgrades still require exact custody,
rollback, recovery and source-mapping evidence. No schema was applied to AWS.

The predecessor key-fence head `0685fba` now has both exact-head CI runs green
(`38093373429`, `38093391461`); its full suite separately passed 6870 tests with
11 existing skips. Those checks do not qualify this new increment. Credential-free
owner/CLI negatives are included in the existing CI native-source test command;
the positive Windows PostgreSQL run remains local evidence, not hosted CI.

Focused verification for this increment: 58 credential-free native/owner tests
and 76 embedded projection/inspector tests passed, including refusal of the
new contract as runtime authority. Typecheck and targeted lint passed. These
results are not a current-head full-suite or hosted CI claim.

Claude's independent clinic privacy lane still needs the three reproduced V2
repairs and its unfinished source wiring and hosted executor. No clinic candidate
is registered by this work. All commercial, device and PHI activation gates remain.
