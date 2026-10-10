# Telehealth schema source inspection

The chart and clinic Zoom host successor proposals now have source-derived
schema fingerprints for the exact 112, 113 and 114 assemblies. The read-only
inspection engine refuses mismatched migration names, hashes, permissions or
schema metadata. It has no upgrade method, host release or provider authority.
It is a prerequisite for the preserving upgrade work, not its completion.

## Source construction

`npm run build:telehealth-schema-source` compiles the validated blocked host
candidate in an isolated embedded PostgreSQL database. It uses the actual
historical empty production installer for migrations 1 through 106, including
the ledger checksum constraint, then applies the remaining source and fictional
ledger receipts. It emits `dist/aws-clinical-core/telehealth-schema-source/schema-source.json`.
The installer bundle and projection SQL digests identify the computation;
neither is a human approval or signature.

The source fingerprints include schema ownership/grants; all selected relations
and types; columns, constraints, indexes, inheritance and partition metadata;
row policies; user and normalized internal foreign-key triggers; function bodies
and attributes; application role traits, relevant memberships including SET and
INHERIT authority, and global/selected-schema default grants. Internal trigger
identities are based on their constraints and functions rather than generated
OID names. Selected-schema extra aggregates, ranges and collations are visible.
Metadata is hashed inside PostgreSQL. Record values, admission keys and review
rows are not returned by the projection.

The query limits responses to 3,001 items and refuses more than 3,000; parsing
also refuses malformed, extra-field, duplicate, unordered or oversized rows.
The seven selected schema names travel as one JSON scalar, compatible with the
existing Data API encoder. A JS array parameter is never sent.

## Exact identities

| Count | Ledger SHA-256 | Schema SHA-256 |
| --- | --- | --- |
| 112 | `45aec4369ec94bf6339a17e47eadba7b81e7b5195fd5be46c2903e587b709fb4` | `98f3f5fa4cbf9d744645d2adacf7f670cbb7acd2730d2efa671c19ce27c77538` |
| 113 | `c980ff93f46b4e4fe36360a0f39288a2fb604a87c522ee88d4421f35f6035384` | `2926b31d6e3963c6fefb4ae7f26f8abffd1aff52bdc71dca7d0564c48ae57adb` |
| 114 | `7c09615ba12bd1122d34d459c57e1c88c42f1c51d598f4f71183e472b15d802c` | `f338287b111e87a830fbf71268a9250e3bcc5aab0cb7ae31daa47c19cc90e2fa` |

These schema hashes describe embedded PostgreSQL 18.3 with the source owner
`postgres`. They are explicitly NOT fingerprints for another engine or owner.
The inspector compares the full canonical source artifact and pinned metadata,
never an expected digest learned from the target being admitted. It requires a
qualification configuration and observed assumed-role identity; the native
caller must obtain that identity from STS, not a saved report or user parameter.

## Verification and live target

The new focused suite initially passed 70 tests covering independent actual
schema builds with deliberately perturbed OIDs, each exact source prefix,
metadata drift, bounded parsing, source substitution and read-only inspection.
Two first-run failures were non-mutating fixtures: the patient table did not
have forced RLS or user triggers to remove. Tests now remove protections that
actually exist on the host-release and appointment tables; they are not waived.
Five strict-shape negatives were added afterwards; the final focused run finished
with 75 passing tests and no skips. TypeScript, targeted lint and diff checks
also finished successfully after those changes. Source artifact generation
passed. No new full-suite or CI result is claimed.

The predecessor source `4968784c70e71cb0f93149dea4b21c860c4494b0` separately
finished 436 test files with 6,795 passes and 11 existing skips. Both CI runs
`38087097321` and `38087056500` succeeded. Those results do not qualify this increment.

Fresh October 10 AWS observations verified member account `588966314750` and
`OrganizationAccountAccessRole`; the foundation remains CREATE_COMPLETE,
PHI false, activation blocked and qualification execution disabled. After an
initial Aurora-resuming refusal, a successful read showed database
`clinical_core_qualification`, owner `clinical_admin`, engine **17.7**, and exactly
**107** migrations, ledger
`542b101ca1729576d2b203c9c2b3d98d2d9dd897e7480ab08ff150c8eacf773c`.
Do not claim 112 is applied from source or prior narrative. The 18.3 inspector
will correctly refuse this target, not silently normalize its owner or engine.

## Remaining implementation and approval

First settle the replacement 107-to-111 and 111-to-112 preserving operators on
the existing exact target. The older approved 48fb320 operator refused before a
write because of unsupported array transport. The 9d03cfc replacement changes
that transport and has two successful CI runs. Clean rebuilding of that exact
source reproduced both proposed operator hashes, but their changed identities
require the separate review packet before any write. Preserve original custody;
never clear a lock or retry a write based on a timeout.

Then compile and independently qualify metadata for the actual native engine
and reviewed migration owner. Do not remove engine/owner checks or use a live
target snapshot as canonical expected source. Complete distinct preserving
112-to-113 and 113-to-114 operators with bounded historical data/hold comparison,
locks, rollback admission, immutable input identity and durable native custody.
The new read-only engine does not implement that write/recovery protocol.

Complete workforce MFA and full runtime release admission, reviewed per-clinic
host registration, exact-version secret/IAM integration, durable Zoom action
settlement and hosted two-clinic/participant races. Deployment, real device
verification and provider/policy reviews remain separate requirements. All six
original commercial phases remain open; no PHI, paid mobile build, provider
activation, secret retrieval or schema application occurred in this increment.

The projection follows PostgreSQL's catalog descriptions for
[internal trigger enforcement](https://www.postgresql.org/docs/current/catalog-pg-trigger.html),
[membership authority](https://www.postgresql.org/docs/current/catalog-pg-auth-members.html)
and [default privileges](https://www.postgresql.org/docs/current/catalog-pg-default-acl.html).
It does not inspect provider configuration, global server hardening, unrelated
schemas or cluster administrator permissions; those need their own reviewed
runtime/security admission rather than a claim that this hash certifies them.
