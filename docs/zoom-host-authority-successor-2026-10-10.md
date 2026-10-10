# Clinic Zoom host authority source successor

This source proposal composes the clinic-specific Zoom registry with the exact
telehealth chart predecessor. It preserves all 113 predecessor files and adds
one blocked migration. It does not register a migration, apply a reviewed
upgrade, grant provider permission, configure a host or enable PHI.

## Exact source identities

| Identity | Value |
| --- | --- |
| Parent contract | `telehealth-chart-lifecycle-candidate/4` |
| Parent count | 113 |
| Parent ledger | `c980ff93f46b4e4fe36360a0f39288a2fb604a87c522ee88d4421f35f6035384` |
| Parent assembly | `f940e0aacbf8a8899ea21fbb027f6132044608492baf1a9286502637b57d3ce2` |
| Successor contract | `zoom-host-authority-candidate/1` |
| Added file | `20261010200000_production_zoom_host_authority.sql` |
| Added SQL hash | `7cddacc6aa38a4abb3bf55a5548eac48717ea420d8f811870502c9a9d19764fe` |
| Successor ledger | `7c09615ba12bd1122d34d459c57e1c88c42f1c51d598f4f71183e472b15d802c` |
| Successor assembly | `8e4fc72b54015f1f0b183fa308aeba8ff3db886e6e4c236fad88bf53f7820f3e` |
| Function pin digest | `fc9b07b3ba6ed4c69c2d92ec3738c682cb44848204d73d95b8acd8c74fb6997a` |

The filename is a proposed source identity, not a registered schema position or
permission to include it in the owner's approved 107-to-112 upgrades. The 113
chart predecessor and this 114 proposal each need separate preserving operators
and qualification. No historical operator or migration has been widened.

## Build and refusal checks

`npm run build:zoom-host-authority-candidate` generates the source artifact in
`dist/aws-clinical-core/zoom-host-authority-candidate`. Its manifest lists all
114 files; `candidate.json` records blocked activation, PHI off, no deployment
and no seeded identities, approvals, consents, admission keys, host releases or
bindings. `function-pins.json` holds 15 hashes from the validated final source
bodies, not observations learned from a live database.

The builder accepts only the exact predecessor contract, every posture field,
ledger, assembly, manifest shape and unchanged LF-normalized parent bytes. It
refuses missing or extra files, duplicate or unordered versions, changed source,
altered permission or seeded-review SQL, and activation/apply command arguments.
The normal output refuses an unexpected stale file instead of silently shipping
a mixed directory. This is artifact integrity, not a security/provider approval.

## Database composition and rollback rehearsal

`npm run test:zoom-host-authority-candidate` exercises builder refusal and
integrity cases. `npm run test:zoom-host-authority` executes the complete compiled
assembly and the source SQL rollback rehearsal in isolated embedded PostgreSQL.

The registry suite now applies all 114 source files, compares every fictional
ledger receipt with the artifact, verifies no admission key or host release is
seeded, and uses the emitted source pins for its restricted-role registry and
credential tests. Existing chart-transfer tests remain a separate exact-113
test suite. The registry still does not authorize provider actions.

The additional rehearsal begins with the exact 113 predecessor and nonempty
fictional identities, memberships, patient/calendar records and an active owner
legal hold. It injects interruption after schema creation and later DDL stages,
then verifies rollback removes the new schema, appointment constraint and ledger
receipt while preserving historical data and schema. A complete apply is also
rehearsed inside a transaction that is deliberately rolled back. Historical
function definitions, table columns, constraints, indexes, policies, user
triggers, roles and memberships are compared; the sole permitted parent schema
delta is the named appointment unique constraint and its index. New child
foreign-key triggers are internal, not included in the user-trigger comparison.

These are source SQL rehearsals with privileged fixture setup, not the reviewed
native preserving operator, real PostgreSQL lock races, live RDS, Secrets
Manager, KMS, Zoom or physical-device evidence. Do not turn their results into a
hosted acceptance verdict or a deletion certificate.

## Verification observed October 10

The candidate validators passed 50 tests: 32 host-successor cases and the
unchanged 18 chart-predecessor cases. The compiled host registry and rollback
rehearsal passed 105 tests across two files, with no skips. The separate chart
and combined-host run passed 124 tests before the four rollback cases were
added. TypeScript, targeted ESLint and source-artifact generation passed.

The integrated predecessor `7f365cc942c05737532a0614c94d57fa0dd45a52` separately
finished its unchanged-source full suite: 435 files, 6,791 passing tests and 11
existing skips. Its CI runs `38085717164` and `38085713578` both succeeded. Those
results belong to the predecessor, not this new assembly increment. This
increment needs its own full-suite and CI results after publication.

The predecessor clinical compile/client scan passed, but Windows standalone
tracing emitted an EPERM dependency-symlink warning. Actual matched-image
packaging and boot remain unverified. An AWS account inspection attempted in
this increment reported expired authentication; no live target or deployment
was accepted from that attempt.

## Remaining Codex integration

The registry and exact-version resolver are implemented in source. The deployed
telehealth handler still uses its existing global-host boundary; this artifact
does not replace that runtime or make a clinic ready for video.

1. Implement separately reviewed preserving operators for the exact 113 and 114
   transitions, including full schema inspection and rollback admission.
2. Bind the authenticated workforce execution boundary to the complete release,
   database and schema identity. A configured MFA review hash is not proof that
   a particular request completed MFA. Qualification subjects remain fictional.
3. Provide a reviewed host release/revocation operator. General API callers must
   not gain release-write privileges; supplied evidence hashes must refer to
   actual reviewed provider, security and SDK authorization artifacts.
4. Wire the exact-version resolver into the provider boundary with deployment
   IAM pinned to reviewed secret/KMS resources. A server-supplied binding, current
   consent and durable provider admission are required before credentials.
5. Carry the clinic/practitioner binding through meeting creation, adoption,
   start, end, summary import, shutdown and recovery. Database locks cannot make
   external Zoom actions atomic; ambiguous and late outcomes need settlement.
6. Qualify those paths against synthetic AWS and Zoom resources, including
   revoked/rotated authority, two clinics, both participant roles and cleanup.

Claude's independent clinic-record privacy and V2 fulfillment lane remains in
[the major handoff](claude-clinic-records-and-v2-privacy-2026-10-10.md). Neither
lane closes the original six commercial phases by source tests alone. Matched
releases, store/provider acceptance, physical iOS and Android journeys and owner
policy/agreement reviews remain required. No paid mobile build is authorized.
