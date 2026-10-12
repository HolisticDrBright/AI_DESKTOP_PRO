# Course delivery and native media source integration

This branch joins Claude's course-delivery source head
`d94f1de52d4dc465d2f6e4f693eb42111e8b80b6` with Codex's native-media
source head `c488f2ce593fc2e74cf5256f05234907226cd9eb`. Both inputs are
preserved as merge parents; neither source branch is rewritten.

The merge is source-only. Its course learner host still needs an independently
reviewed production identity and database installation. Its media host and
four media SQL candidates remain blocked, and original-author preview is not
learner media access. No migration, provider configuration, price, webhook,
mobile build, PHI setting or deployment changes here.

## Verification and limits

- The course parent has exact CI success 38218884875; the V2 course mirror
  parent `4d0cb2502298267d479417a75030edd56f023611` has exact CI success
  38213415625.
- The media parent `c488f2ce` fixed a failed Linux browser withdrawal test.
  Exact CI 38273014456 completed successfully in all 11 jobs, including the
  Linux browser job that failed on predecessor `894d4182`.
- In the combined checkout, typecheck and lint passed; 17 actual browser
  media cases passed; and 87 targeted course SQL and media SQL tests passed.
- The clinical production build passed with 253 generated pages. Its strict
  bundle scan passed 327 client chunks.
- The full unit suite passed 525 files and 8,343 tests, with 11 existing
  skips. The eight separately gated fictional purchase-to-learning browser
  cases passed with the fixture enabled. The first browser command omitted its
  `E2E_LIVE` gate and skipped all eight cases; that skipped run is not used as
  evidence. The combined exact CI remains required.
- Mock-import, AWS compatibility and operation-inventory gates passed. The
  reporting repair from `3b3ed85c` was applied as a separate commit after the
  merge. Its three regression tests pass. The CLI now labels 140 as historical
  provider dependency flags and states that current provider completion is
  unverified by this source gate.

The next functional increment is a learner-authorized, exact-published-version
media read with immutable caption/transcript text snapshots. Neither the
course branch's held-media notice nor the native author's preview URL should
be treated as that increment. A paid course continues to grant education
access only, separate from V2 Core, clinic enrollment, health sharing,
supplements and clinical protocol adoption.
