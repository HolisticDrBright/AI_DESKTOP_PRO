# Preserving telehealth consent database upgrade

This operator adds the exact telehealth consent function to the isolated fictional qualification database. It preserves existing clinical and Fullscript data, consent history, migration receipts, legal holds and historical schema. It does not register consent copy, grant patient consent, activate a provider, deploy an API or authorize PHI.

## Exact release and prerequisites

The predecessor must be the complete 111-migration release `98ef31a24baeafb83bfd65a7832b1e4e02dbe1c71b6e78f8efdad4e0b0e62d4c`. The successor is the distinct 112-migration release `45aec4369ec94bf6339a17e47eadba7b81e7b5195fd5be46c2903e587b709fb4`, assembly `6cc191355442ae2c2349cab50466979eaab0e45961a4e1547f34785294dce4b9`. The single new SQL file has digest `5d4b361c4849b900c4c6e4f95686cf77c28797584bc9e9ec1136f38bdc325e0e`.

The qualification database last observed before this increment was still at release 107. Reobserve it before proceeding; the preserving predecessor upgrade and its own review remain required. Do not apply all migrations blindly or widen the historical Fullscript operator to accept 112.

Build from a clean, committed checkout:

```powershell
npm run build:telehealth-consent-upgrade
npm run test:telehealth-consent-upgrade
npm run test:telehealth-consent-upgrade-artifact
```

The builder embeds the actual migration bytes and source commit, observes source bytes before and after compilation, and refuses drift. These observations are not an atomic filesystem snapshot. Its manifest records the operator digest and whether the source was clean. A dirty build can be inspected as an artifact but its command refuses execution.

## Reviewed target

The command requires an absolute target-file path and that file's SHA-256. Target bytes must be canonical JSON: recursively sorted object keys, no spaces, and one final LF. The strict `telehealth-consent-upgrade-target/1` schema is in `telehealth-consent-upgrade-command.ts`.

The target binds the actual foundation, cluster, secret identifier, qualification database, staging database to refuse, operator commit and operator-file digest. Account `588966314750`, region `us-east-2`, role `OrganizationAccountAccessRole`, PHI false and activation blocked are fixed. Native STS and foundation observations must agree. Environment overrides cannot substitute another account, database, region or endpoint.

Brandon Bright must review the exact target and record its review time under `fictional-schema-transition-only`. That review covers this fictional schema operation only. It is not a substitute for security, retention, consent-copy or provider approval. Do not fill review fields with invented approvals, example hashes or test identities.

## Execution and recovery

`index.cjs` accepts `inspect`, `rehearse`, `upgrade` or `reconcile`, followed by `--target` and its absolute path, then `--target-sha256` and the exact digest. Inspection takes no confirmation argument. Rehearsal and upgrade require `--confirm-fictional-telehealth-consent-upgrade`; reconciliation requires `--reconcile-fictional-telehealth-consent-upgrade`.

Upgrade obtains the shared database fence, records a durable baseline, completes a rollback rehearsal, admits one write and verifies two readbacks before settlement. It adds one function and one migration receipt, with no new tables or seeded authority rows. Existing Fullscript tables may contain legitimate holds and consent records; unlike predecessor installation, this operation must preserve them rather than require them to be empty. Preservation includes all 217 historical tables, reference ledgers and historical migration receipt dates.

An interrupted or uncertain write retains the shared operator lock and original hash-chained journal. Never delete the lock or rerun upgrade to guess the outcome. Reconciliation requires the stopped original process, original compiled operator and exact target, a settlement interval, the shared database fence and three consistent readbacks. It may observe a preserved predecessor or an admitted preserved successor; it performs no database mutation or automatic retry. Changed or foreign custody, a live writer and unadmitted successor state are refusals.

The native shared namespace remains the existing `DESKTOP_COMMERCIAL_20261005/dist/synthetic-care-routing` directory. It is not a per-checkout namespace or a caller-selectable recovery directory. Local test suites use private temporary directories and fictional transports; those fixtures are not deployment approvals.

## Qualification still required

Local evidence covers real embedded PostgreSQL SQL, rollback, existing data and hold preservation, historical schema and privilege changes, command refusals, native files and stopped-process recovery, and the actual compiled artifact. Hosted Data API transaction settlement, PostgreSQL locks and privileges, interrupted-process recovery against the real target, and clean reviewed target execution remain unverified.

After a reviewed hosted upgrade, the separate exact 112 [telehealth consent copy registration engine](telehealth-consent-copy-registration.md) supplies the source mapping. Its native target and interruption-custody wrapper are still required before AWS use. Reviewed copy registration, the matched published consent API and telehealth deployment, SDK/provider acceptance and physical V2 patient/host journeys follow. Preserve all clinical exclusions, source-verification holds and synthetic-only restrictions. None of these local results establishes commercial or PHI readiness.
