# Fictional qualification care-messaging schema upgrade 103 → 104

This is a **schema-only**, data-preserving qualification operator. It cannot activate a service, approve consent, deploy an API, enable production traffic or permit PHI. The care-messaging API library remains `deployable:false`; its handler/template, consumer/provider wiring, clinic lifecycle/amendments and real hosted concurrency acceptance remain engineering work.

## Exact scope and release identities

- Account `588966314750`, region `us-east-2`, fixed foundation `ai-clinical-core-qualification-foundation`, database `clinical_core_qualification`; staging `clinical_core` is refused.
- CLI and SDK both use `ai-synthetic-member`. The actual STS observation must be a short-lived assumed role in that account; root and long-lived IAM users are refused by the shared AWS binding. The current broad organization role is not a final production least-privilege approval.
- The foundation must be complete, PHI-off, activation blocked and qualification execution disabled. The cluster and secret identifiers come from its actual outputs, not caller-provided environment overrides.
- The exact predecessor ledger hash is `9bc30d04930816a523a7dc67b95944fba1d294dad4d71cf7585158fbc3a874aa` (103 migrations). The exact new ledger hash is `57fdf022f0fdd7d70be12384d6e6d54caab1a0ddb4965a884e4d59eec4c552b0` (104 migrations). The separate 104-file assembly hash is `e168b74caafe46732c976f8b7fb320198a5587dad9420e983d50a476cb6e0187`; do not confuse the hash formulas.
- Only `20261006010000_production_care_messaging.sql` is applied. All 103 earlier SQL bytes/hashes stay unchanged. Four new tables are empty; no release, identity, patient, consent, provider or approval is seeded.
- The new canonical coverage map accounts for 206 tables: 105 organization-column, 46 parent-linked and 55 retained. The empty installer verifies 127 core/audit tables and 84 counted contracts. Exact historical 102/103 artifacts retain their old 123/81 verification pins; no count-only exception is introduced.

## Build and run

Run from a clean Desktop checkout of the reviewed source. These builds themselves access no AWS service:

```powershell
npm run build:aws-production-clinical-core
npm run build:aws-care-messaging-upgrade
node dist/aws-clinical-core/care-messaging-schema-upgrade/index.cjs inspect
node dist/aws-clinical-core/care-messaging-schema-upgrade/index.cjs rehearse --confirm-fictional-care-upgrade
# Only after reading the actual passing rehearsal and confirming this target:
node dist/aws-clinical-core/care-messaging-schema-upgrade/index.cjs upgrade --confirm-fictional-care-upgrade
```

Write commands refuse a dirty-source artifact. `upgrade` also performs a fresh physical rollback rehearsal before its commit attempt; it does not treat a caller flag or old report as a passing rehearsal. Inspect is repeatable-read/read-only. Rehearsal applies the exact DDL in a transaction, verifies it, intentionally rolls back, then opens a new read-only transaction to prove the predecessor ledger, inventory and row digests remain. Upgrade holds the migration and fixture advisory locks and deterministic table writer locks, checks the exact ledger, compares all old row fingerprints/RLS metadata, requires all added tables empty, and verifies actual function bodies, execution/table privileges and trigger table/function/event bindings before committing. Replay verifies the resulting schema without reapplying DDL or creating rows.

The bounded fingerprint operation returns only per-table counts/digests, not health content, and refuses tables over 5,000 rows. This is a small fictional qualification database tool, not a general production or large-PHI migration tool. Do not disable RLS or increase its limits to force a pass.

## Preservation and retention boundaries

Messages/receipts remain immutable. Owner correspondence exports survive sharing withdrawal but are live pages, not atomic whole-account export. Coverage is inventory/dependency mapping, **not a deletion approval or receipt**. Clinic destruction detects holds belonging to app owners even without staff membership, including the immutable original owner after a connection reassignment. An ordinary consumer deletion request cannot erase a retained clinical message, and a hold cannot be bypassed by terminating a clinic. Authorized hold-aware clinic disposition and amendment work is still required; do not weaken immutable triggers to make an unreviewed deletion succeed.

The historical 102→103 export-discovery operator now explicitly selects only its exact historical prefix when building from newer source; its boundary remains unchanged. The old isolated-consent registrar still intentionally pins the 103-row target and will refuse a 104-row database. Review/update that registrar's exact ledger binding before using it after this transition; never lower its checks to a mere table existence test. Existing approved releases must be preserved, not overwritten.

## Evidence required next

Local PGlite tests execute the actual canonical SQL, historical installer, fictional preexisting records, upgrade and rollback. Only the database-name observation is substituted because PGlite supports one database. They cannot prove real Aurora locks, concurrent API writers, IAM, deployed endpoints, mobile-device behavior or production retention approval. No AWS upgrade or candidate deployment has been performed for this increment. Before a hosted run, rebuild a clean-source operator, inspect/rehearse the live isolated target, record the actual result and keep any failure as a finding. A new migration release requires matched candidate artifacts and updated exact target manifests before full hosted qualification; old 103-row manifests must not be presented as 104-row evidence.

The six original commercial-readiness phases remain incomplete. Keep PHI disabled, clinical exclusions/holds and source-verification requirements intact, and paid mobile builds held until the user-authorized release condition is met.

## October 6 execution checkpoint

Clean source `1604f1d56c4c207b9ba2f873eeb2bdc62ff03be4` was rebuilt and the shipped operator ran against the actual isolated AWS database. Physical rehearsal/rollback passed, the upgrade committed migration 104, separate inspection passed, and upgrade replay returned `alreadyApplied=true`, `applied=false`. All 46 predecessor rows were preserved and four added tables were empty. The live qualification target is now **104**, not 103. Exact hashes, digest domains and limitations are recorded in `docs/aws-qualification-2026-10-05.md`, section “Hosted schema-only qualification upgrade.” The earlier source-only paragraph above is historical; no endpoint, provider, consent release, production activation or mobile build was supplied by this schema change. Old 103-bound candidate manifests and the consent registrar must not be used as current evidence.
