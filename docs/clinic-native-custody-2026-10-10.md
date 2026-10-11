# Clinic native custody and interrupted write recovery

This increment provides real local-file custody for the preserving command protocol. It retains an interrupted attempt's original operator, target/profile/source binding, baseline, hash-chained observations and uncertain write outcome. It does not expose a live migration command or authorize a database upgrade.

Source base: `7115ef33b71ab42e98ce3e550ce38136445338f4`; branch `agent/clinic-native-custody-20261010`. The separate checkout preserved the predecessor's running full suite. That predecessor subsequently finished:448 files,7,063 tests passed,11 skipped; both exact CI runs38110668838 and38110671044 succeeded. Those results belong to7115ef3, not this newer source. No historical SQL, approved operator, source receipt or migration mapping changes in this increment.

## Implemented controls

- Uses the existing shared operator namespace by default, not a new per-checkout lock. A foreign operator or either reconciliation guard refuses a new writer. Root/runtime injection is for explicitly local source qualification, not a live configuration surface.
- Requires the actual original operator bytes to match the binding's digest. Pins ancestor directories and file identities, refuses symlink files/directories, bounds reads and detects same-byte pathname substitution.
- Creates, flushes and reads back the original operator, canonical header and complete baseline before atomic hard-link publication. Rechecks those archives after the asynchronous fence check and immediately before publication.
- Appends ordered, bounded hash-chain events. Baseline/rehearsal/admission are identical whole112 observations; successor reply/readbacks are identical whole116 observations with all historical data and receipts preserved. A finding is terminal and never retires custody.
- Archives a settlement and exact lock before retirement. No receipt or local-file test promotes injected observations into managed-database, operator-acceptance, provider or PHI authority.
- Recovery requires the same host, a genuinely stopped original PID, a60-second interval, exact original binding/operator/header/journal archives and the caller's fence. A live/foreign/changed guard is retained. A stopped prior recovery guard can be replaced only after its original archive and binding are checked and archived.
- Torn final journal bytes remain intact and never create write admission. No-admission recovery refuses a successor. If a successor reply was recorded, recovery cannot substitute another definition digest or downgrade to a predecessor.
- Recovery archives the exact original journal, including a torn tail. It retires the subsidiary recovery guard first and the original operator lock last, so interruption between those steps retains the original attempt for another explicit read-only reconciliation.

The guarantee is process-interruption custody under the checked local namespace and injected fence. It is not disk power-loss durability, protection from a hostile local administrator, proof of an AWS lock or proof that the observed definitions were independently admitted for RDS. The60-second delay is a local stopped-process recovery condition, not an S3 or database settlement guarantee.

## Regression evidence

The first37-case custody suite exposed three failing negative tests: header, journal or operator archive changes during the publication fence were accepted. Rechecking archive identities and exact bytes before publication fixes all three without weakening their tests.

A further negative test showed recovery accepting a changed successor schema after an original `write_reply`. The recovery settlement now matches that recorded observation exactly. The test failed before the repair and passes afterward.

Final focused run:109 tests across five files passed:38 new native-custody cases, four native-file/command integration journeys,53 existing command/fence cases and14 unchanged historical Fullscript custody cases. Broader run70277 completed112 tests across six files, adding the three existing actual embedded SQL journeys; the command also named three nonexistent test paths, which were not executed. A corrected separate run19831 explicitly targeted the actual rollback, row-witness and hosted-port files and completed88 tests across three files. Together these two disjoint runs cover200 regressions, not one full application suite. Typecheck initially caught a test's widened string index; a readonly typed case list repaired it. Final typecheck55392, targeted lint, package/CI parsing and diff checks passed after the successor comparison repair.

The source-transition builder and production-core, compatibility and operation-inventory gates passed after these changes. The inventory reports228 implemented but activation-blocked operations, zero enabled and140 requiring provider-specific rewrites. An inventory pass is not proof those external integrations are complete. The registered production artifact remains106 migrations; this increment does not register proposed successors.

The native-file/command journeys use real temporary files, hard links, immutable receipts and actual spawned-child liveness. Their database observations and outer fence are fictional injected ports; the child PID represents the source-qualification writer identity, not a child that executes a real database migration. Existing separate database journeys execute the116 artifact in PGlite, but currently use in-memory custody. Neither test kind is hosted acceptance, native PostgreSQL concurrency or physical-device acceptance.

Commands:

```text
npm run test:clinic-native-custody
npm run test:clinic-preserving-workflow
npm run typecheck
```

CI runs the native-custody suite in the existing candidate source-qualification job. Inspect the final commit's actual CI result; earlier green commits and skipped deployment jobs are not current hosted evidence.

## Remaining executable operator engineering

1. Independently assemble/admit canonical managed-owner definitions for112–116 under the actual RDS role/grantor identity. Do not learn the expected profile from the target or normalize local-versus-managed ownership differences away.
2. Implement the preserving forward kernel under real database fences, with baseline admission inside the mutation transaction and exact per-prefix definitions,217 historical-table data,112 historical receipts and empty new tables checked before commit.
3. Compose that kernel, native custody, actual target/source/profile/approval guards and explicit recovery into a reviewed executable. Define outer-fence exit failure/settlement semantics before enabling any live write; source adapters alone do not resolve that authority boundary.
4. Qualify real native PostgreSQL lock waiting, authority/key retirement and concurrent operator/fixture behavior, then run authorized fictional AWS acceptance. A fixture transport or local-file run cannot supply managed evidence.
5. Register exact selected mappings/coverage only after the appropriate source and executable reviews. The pending exact predecessor review and separate successor approval remain independent requirements. No approval is fabricated here.

## Commercial readiness scope remains intact

All six original scopes still require their full acceptance: authoritative plans/catalog and two-device recovery; owned lab/document processing; privacy/retention/export/clinic amendments; reviewed clinical release and intended use; Core store/provider acceptance; and exact matched releases, rollback/security/operations plus physical iOS/Android journeys. This increment advances upgrade/recovery safety within that work; it does not replace or close the other scopes.

Claude's parallel consumer assignment is `handoffs/claude-v2-launch-journey-closure-2026-10-10.md` in the shared workspace. Codex retains the operator and AWS lane. Keep clinical holds/exclusions/source verification, Core-only launch, PHI off, activation blocked and the hold on paid mobile builds.
