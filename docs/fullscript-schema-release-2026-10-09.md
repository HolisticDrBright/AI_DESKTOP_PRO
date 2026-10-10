# Fullscript schema release and preserving transition

Fullscript now has a distinct, blocked 111-migration source candidate. It keeps
the exact 106, 107 and 108 historical releases unchanged, including the
telehealth consent scope and all prior scopes. Building the candidate creates
local release files only. No AWS database, provider, consent or approval changes.
Cart delivery still reports `not_implemented` in the installed runtime.

## Release mapping

| Release | Migration ledger SHA256 |
| --- | --- |
| Adopted inventory parent 107 | `542b101ca1729576d2b203c9c2b3d98d2d9dd897e7480ab08ff150c8eacf773c` |
| Telehealth consent parent 108 | `4e8e78f6d9aea14d9e622f07f5523380c17e704730c543230846c0ba5dc8e38b` |
| Fullscript successor 111 | `98ef31a24baeafb83bfd65a7832b1e4e02dbe1c71b6e78f8efdad4e0b0e62d4c` |

The filename-bound successor artifact hash is
`658fd3697bff08d7d16afba2033e6aaca439e77266aff6369730089c0b18fd7a`.
These are source identities, not security, provider or retention approvals.

The three appended migrations are `production_fullscript_draft_ledger`,
`production_canonical_protocol_carts` and
`production_fullscript_canonical_authority`, at 20261009110000, 20261009120000
and 20261009130000. The last includes the narrow worker-only ledger function.
Every SQL hash is pinned in `scripts/fullscript-candidate.mjs`; changed SQL is
refused, not assigned a new accepted hash automatically.

Run `npm run test:fullscript-candidate`, `npm run build:fullscript-candidate`
and `npm run test:fullscript-schema-upgrade`. The output directory is
`dist/aws-clinical-core/fullscript-candidate`. These commands neither deploy
nor activate anything. The qualification API accepts only this exact release;
its tests use the real generated migration entries with fictional identities,
AWS responses and providers.

## Preserving transition

`runFullscriptSchemaUpgrade` is a server-only engine, not a public HTTP route or
native AWS operator. It supports read-only inspection, rollback rehearsal and
an admitted forward transition from exact 107 or 108 history. Only the isolated
synthetic qualification database/account/region is allowed. PHI is false and
production activation is blocked.

The engine takes the migration and fixture advisory locks, then write-blocking
locks on all 209 historical application tables and the ledger. It compares
complete historical rows and receipts, table/column/index/policy/trigger/grant
metadata, functions, roles, memberships and schema metadata. The two consent
scope checks are separately checked against their exact expected definitions.
New foreign-key enforcement triggers on historical tables are permitted only
for the eight explicitly registered new relations; unrelated changes still
fail. The new tables' column/default/constraint/index/policy/trigger shape is
pinned separately, and new function bodies, properties and execute grants are
checked against the source. No clinical approval, consent, recipient, catalog
or provider row is created. The new tables must be empty before commit.

A forward call requires the exact prior observation and rechecks it under the
locks. A changed record, schema or admission refuses before commit. A rehearsal
runs the actual extension SQL inside a transaction, rolls it back, and inspects
the original state again. It never erases a committed intent, consent, provider
receipt or uncertain writer. A target already at 111 returns `recovery_required`
rather than blindly reapplying SQL after a lost commit response.

## Local verification and remaining engineering

The initial migration verifier incorrectly treated the new foreign-key triggers
as unrelated historical changes. The fix recognizes only those exact additions.
Subsequent negative tests caught a function-property verifier assumption about
an immutable function; its volatility is now read from the pinned source.
Failed intermediate runs remain failures, not retrospective passes.

The final focused SQL/API group passed 111 tests in two files, and the candidate
builder passed 16 tests. SQL, privileges, fingerprints and rollback execute in
PGlite; only its fixed database name is modeled. AWS responses in the API tests
are fictional. Typecheck and targeted lint passed. Locally reused dependencies
are not a clean-install or hosted result. CI runs these checks independently.

The complete final draft, authority, cart and transition group passed 618 tests
in 16 files with no skips in 155.78 seconds, starting at 20:22:09 PDT on October 9.
The final production migration gate and three newline regression tests passed.
These results do not qualify the separate native AWS transition or a provider
operation.

The separate [native qualification operator](fullscript-upgrade-operator-2026-10-09.md)
now supplies current STS/foundation and exact-target binding, local durable writer
custody, interrupted-commit reconciliation and settled readback. Its source and
local tests are not hosted qualification. Review the exact clean operator and
target, then run its preserving transition against the actual qualification database.
The local shape pin must
match the actual Aurora engine; a mismatch is a finding, not permission to ignore
metadata or relabel the test as passed. Configure the reviewed separate target
loader and published Lambda/route/IAM candidate, without embedding its own zip
hash inside the zip. All provider-backed, cross-owner, privacy, retention,
OAuth-callback and mobile/Desktop acceptance remains required.

The six commercial-readiness phases remain incomplete. Clinical holds,
source-verification requirements, exclusions, the adult-only Core launch and
the restriction on paid mobile builds are unchanged. This release is not an
authorization for real patient data or a PHI activation approval.
