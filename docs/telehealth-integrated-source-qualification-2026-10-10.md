# Integrated telehealth source qualification October 10 2026

The Desktop integration branch now combines the chart-transfer repair with the
existing exact-copy consent and clinic-host source components. Signed visit text
can be placed into the chart only as an unsigned draft through the admitted,
patient-bound transfer contract. This is locally qualified source, not an applied
schema, a deployed service or permission to use real patient data.

## Source identity

The integration merges `fa9910ce1c30309b70dfa0eb41f24b8b5860a8dc` into
`agent/telehealth-canonical-integration-20261009`. That branch includes Claude's
audited chart lifecycle at `7ff170b` and Codex's completion-expiry repair. The
distinct candidate remains `telehealth-chart-lifecycle-candidate/4`, with file
`20261010190000_production_telehealth_chart_lifecycle.sql` and SQL SHA-256
`78f03a282b3f5ba97af2f50683aeab0fc1e20d19d77ec7111fc28116ede7bab7`.
All 112 parent migration bytes are unchanged. No version 113 mapping, admission
key or provider release was registered, and no migration was applied.

The clinic-specific Zoom registry and exact-secret-version resolver remain
unreleased source components. Merging the chart lifecycle does not wire those
components into the telehealth provider path or replace its existing global
host configuration. Their remaining integration is listed in
[Zoom host registry source candidate](zoom-host-registry-source-candidate.md).

## Repairs found during integration

The consent-copy fixture previously created its old and new artifacts using
separate calls to the database clock. Identical timestamps could leave ordering
to randomly generated identifiers, contradicting the test's premise that one
release was newer. Commit `5941f4b` assigns an explicitly older approval time
to the predecessor and asserts the newer timestamp in the no-copy case. The
newest-release refusal, all assertions and historical SQL remain unchanged.

The new chart-transfer screen had a separate authorization-loss bug. After a
transfer returned a service error, its recovery read could deny access while the
screen swallowed that refusal and retained signed clinical text. A browser
regression failed against the merged predecessor: five earlier journeys passed,
the new case failed, and two serial successors did not run. The captured page
still displayed practitioner notes, the edited summary and action items.

Recovery now handles an authorization refusal through the same opened-note
clearing function as a primary denial. It clears transfer controls as well as
clinical text and increments the access epoch so pending replies cannot restore
the opened record. A non-authorization recovery error remains a transfer error;
it does not claim the chart write was absent. The unchanged regression and the
full eight-case telehealth browser spec pass after this repair.

## Local evidence and its limits

- The standalone expiry repair at `fa9910c` passed its full unit suite:
  425 files, 6,277 tests passed, 11 existing skips, zero failures, 663.30 seconds.
  This is not the integrated branch's full-suite result.
- The merged chart SQL, clinic-host registry and resolver, telehealth handler,
  RDS driver, record-inventory contract and live adapter passed 508 tests across
  six selected files, without skips. The chart SQL contains 23 cases; the host
  SQL and resolver suite contains 101.
- All 18 distinct chart-candidate tests pass and preserve the exact 112 parent.
- Consent-copy and consumer consent API checks pass 52 cases; a subsequent
  isolated consent-copy run passes all 32 cases.
- The actual Chromium telehealth spec passes eight cases with no skips or
  retries. It uses the committed fictional loopback contract fixture and aborts
  Zoom SDK downloads. It does not prove a real Zoom meeting or hosted AWS route.
- Typechecking and targeted lint pass. Compatibility, mock-import isolation and
  the production-core gate pass. The operation inventory has 228 implemented
  but activation-blocked operations, zero enabled, with 140 requiring
  provider-specific work. These counts are not provider activation evidence.
- One attempted gate invocation used a nonexistent script name. The actual
  `scripts/check-aws-production-clinical-core.mjs` was then run successfully;
  the failed command is not treated as a pass.

The full integrated suite, clinical production build and strict bundle scan
require fresh evidence on the published merged revision. Keep tracked source
and HEAD unchanged while those runs execute. CI, hosted AWS, real PostgreSQL
interleavings, provider acceptance and physical device verification remain
separate status levels.

## Remaining completion requirements

Claude's independent clinic privacy and V2 ClinicDataCenter lane is specified
in [the major handoff](claude-clinic-records-and-v2-privacy-2026-10-10.md). It
must not duplicate the existing V2 telehealth-consent implementation or widen
the personal export's clinic-record exclusions silently.

Codex still owns exact successor assembly and preserving-upgrade review,
clinic-host authenticated provider integration, independent cleanup authority,
AWS deployment and hosted acceptance. The owner still reviews consent wording,
clinic disclosure and retention, actual agreement coverage and activation
evidence. Hosted expiry/authority/key-retirement races, two-clinic isolation and
a two-participant provider visit remain required. No fictional review hash is
production approval.

The six original phases remain intact and incomplete: published target and
plan continuity; owned lab/document processing; privacy fulfillment;
knowledge and clinical safety qualification; Core store and provider
acceptance; matched release, rollback/recovery and physical verification.
PHI and production activation stay off, and paid mobile builds remain held.
