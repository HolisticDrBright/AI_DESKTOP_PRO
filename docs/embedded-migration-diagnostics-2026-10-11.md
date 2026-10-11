# Embedded database diagnostics and release qualification

The Desktop authorization source has a failed Linux CI unit suite despite a
successful Windows serialized full suite. The underlying database error is
not yet established. This increment adds test-only diagnostics so a repeated
failure can be classified without printing SQL, parameters or exception text.
It is not a repair of the undiagnosed failure and does not qualify a release.

## Observed failure and unchanged source checks

Exact predecessor source: d03185aad5d207bbbfa4a0ba6afc9b9b6a99ff0b,
branch agent/telehealth-isolation-20261011. GitHub run38122462135 completed
FAILURE: ten jobs succeeded; the Typecheck, lint, unit, build job failed at
npm run test:unit. Later build/gate steps in that job were skipped. Its log
reports449 passing files, one failed suite,7,110 passing tests and20 skips.

The failed suite is inventory-qualification-identity-mapping.database.test.ts.
Setup threw migration_failed at migration20260916040000 statement30. Splitting
the unchanged historical SQL with the repository's actual splitter identifies
statement30 as the final grant of execute privileges to clinical_core_api.
The log does not retain the underlying error code; an error in that grant does
not establish that a patient-data mutation occurred.

The same predecessor's local serialized full run57313 completed exit0:
450 files,7,119 passed,11 skipped,1,308.55 seconds. An unchanged isolated run
of the affected file passed all9 cases in5.14 seconds. These are separate
observations, not a replacement for the failed CI run.

Local Node is24.18.0 on Windows; CI used Node22.23.3 on Linux. Local PGlite
is0.5.8 and Vitest4.1.11. Equivalent hosted behavior, the cause of the failure
and reliable parallel execution remain unproven. No retry-only result may erase
the original failure or classify it as an environment flake.

## Test only diagnostic contract

The affected fictional database fixture now observes each query once and
rethrows its original error. The diagnostic contains exactly a fixed event,
SHA-256 of the statement and a bounded five-character SQLSTATE when the error
carries that value as an own data property. Otherwise SQLSTATE is null.
Exception getters and inherited values are not evaluated. A reporting failure
does not hide or replace the query failure.

No SQL text, parameters, messages, stack, hint, detail, identifiers, credentials
or provider payload is serialized. The application migration runner remains
unchanged and opaque. No query is retried, test deadline widened, assertion
removed, role widened or SQL migration rewritten. The helper is imported only
by test files, not production handlers.

The focused final command passed33 tests across3 files. It covers eight
diagnostic cases, including an actual embedded PostgreSQL permission refusal
with SQLSTATE42501, the original nine mapping cases and the existing production
migration tests. Full typecheck and lint passed. The earlier focused command
passed32 cases before the additional real embedded-denial case was added;
that earlier total is not the final total.

```text
npm run typecheck
npm run lint
npm run test:unit -- src/test-support/embeddedDatabaseDiagnostics.test.ts src/server/clinical-core/inventory-qualification-identity-mapping.database.test.ts src/server/clinical-core/production-migrations.test.ts --maxWorkers=1 --no-file-parallelism
```

Build readback still yields telehealth-transfer-authority-candidate/4:
extension85990f316594c71aa054a5cdc449e75da3ac6bc04f744a30b7802f72a68d583e,
ledger34037e1ff05d583868c9a3796f673937777f88bcf4cebc2d589c6604626e9364,
and the unchanged116 parent. Runtime admission remains false, managed-role
semantics unverified, activation blocked, PHI false and all seeded authority
flags false. No source-only evidence supplies managed or production approval.

## Original completion requirements

The original phase identities are preserved from the September16 return,
commercial-six-phase-ledger.md and six-phase-current-evidence-2026-10-05.md
in the V2 source. Claude's six application work packages are not new phases.

| Original phase | Evidence still required for completion |
| --- | --- |
| 1 Account and plan continuity | Same-target governed catalog, authoritative adoption, revision/conflict/recovery, two-device and practitioner-connection journeys on matched releases. |
| 2 Reliable processing | Hosted owned labs/documents/voice with consent, provenance, duplicate protection, durable delivery, cancellation/restart and physical-device verification. |
| 3 Privacy and access | Hosted exports, corrections, holds, late-write handling, scheduled cleanup and cross-store fulfillment with explicit provider/backup accounting. Guardian authority remains deferred, not implicitly implemented. |
| 4 Clinical integration | Verified source and assay mapping, age/sex/phase/unit and consent requirements, preserved holds, reviewed intended use and actual high/low/conflict safety cases through published catalog, plan and Ask ALP. |
| 5 Commerce and providers | Core19.99 store setup and actual purchase/restore/cancel/reconciliation; calendar, Zoom, Fullscript, email and payment acceptance with covered runtime configuration. |
| 6 Release qualification | Exact matched backend/Desktop/mobile candidates, reliable full CI, hosted matrix, rollback/recovery/load, operational/security reviews and physical five-persona iOS/Android acceptance. |

Fresh V2 store-submission check still refuses with eight blockers: requested
Core intended-use scope, privacy-notice review, store products, paid-app
agreements, production HealthKit artifact, physical-device matrix, production
build authorization and production backend activation. Education-only behavior
is not a substitute for the requested lab-driven consumer plans and supplements.
No blocker is removed by this diagnostic increment.

Codex retains CI diagnosis, managed schema/target custody and hosted qualification.
Claude retains the separate application packages from f38b949/e97aec. Policies,
provider coverage and physical testing retain their separate reviewers. Changed
schema executable approval7d6a946 remains pending; earlier approval is not
permission for changed executables or117. PHI, production activation and paid
mobile builds remain off/held. No AWS call, fixture, key, provider call or
deployment accompanies this source work.
