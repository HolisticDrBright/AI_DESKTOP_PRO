# Core boundary overnight, Desktop side (2026-10-15)

Branch `claude/core-boundary-overnight-20261015`. It starts from Codex's audit head
`agent/qualification-program-runtime-audit-20261015` @ `db41ec43`, which descends from the integration head `5e688053`.
Codex's candidate metadata is not edited: everything new here is a separate file, and the one change to an existing
production module, extracting `boundedProgramExecutor`, leaves that module's behaviour and its 21 tests unchanged.

Nothing here deployed anything, applied SQL, enabled a row, sent mail, used real patient data, or changed an AWS
resource or account setting. Every database result is from PGlite, every transport is fictional, and every identity is
invented.

## WP1: the integrated-head authority regression

**Failure, captured before any change.** Desktop CI run 38686513746 at `5e688053` failed in three files with
`identity_refused` and 403. Reproduced locally before any change:

- `outreach-clinical-path.test.ts` and `outreach-switches-off.test.ts`, run with `patient-notifications.database.test.ts`
  and nothing else: 2 failed of 36 (`expected 403 to be 200`). The patient-notifications file passed.
- `telehealth-booked-email.test.ts`: 6 failed in the sequential full run (595 of 596 files passed; 9103 passed and
  11 declared skips).

**Cause.** The merged telehealth handler's current-membership recheck (`requireCurrentWorkforceMembership`, from
`4e1234b5`) needs a bearer token and exactly one current membership row from the identity API's
`list_my_organizations`. The two outreach integration tests and the booked-email test were written before that check
existed. Their staff events carried no bearer and nothing answered the membership read. The guard was right, and the
fixtures were out of date.

**Repair: model a valid membership, never bypass the guard.**

- `eba8ab47`: in the two outreach tests, the staff event carries a fictional bearer. A strict fetch stub answers only
  the identity API's `list_my_organizations` with one practitioner row for the fixture clinic, and throws on any other
  URL. `outreach-switches-off` also asserts the recheck ran exactly once.
- `f3718188`: the booked-email test gains the same membership model and a new describe, "the current-membership
  recheck refuses before anything is scheduled or sent". Each refusal case asserts no write command, rows
  byte-identical, and no SES send:
  - no bearer: 403, and the identity API is never called;
  - 403 for each of zero memberships, another clinic only, duplicate rows, a revoked membership (the clinic is no longer
    listed), the role `member`, and the identity API answering 403;
  - the identity API answering 502: 503 `service_unavailable`, not a refusal claim;
  - the membership restored: 200 and exactly one email.

**After the repair.**

- The first-message triplet: 36 of 36 passed. `telehealth-booked-email.test.ts`: 17 of 17 passed.
- Focused telehealth and security suites: 21 files, 807 tests passed.

The earlier full-run skips reported for patient notifications and the clinical path did not reproduce in the
sequential baseline. Its only skips are the 11 declared ones: `bridge-roundtrip` (9) and the governed-catalog seed
adapter (2), both environment-gated. That points to the earlier contended run as the cause, but this is not proven.

## The synthetic program adapter's purchase destination (`8ff94e17`)

The production program adapter withholds `product.purchaseUrl`. The synthetic one (`program-assignments.ts`) did not:
its read and preview returned a stored `https://fictional-dispensary.example/p/fictional-mineral`. The failing-before
case is in `program-assignments.database.test.ts`.

`withheldDestinations` now nulls the destination on read and preview, while purchase is unreleased. Purchase stays on
its own disabled path; nothing else in the answer changes.

## WP2: one program family for the production-shaped qualification database (`53f57c04`)

See `docs/qualification-program-boundary-2026-10-15.md`. In brief:

- **SQL successor.** `qualification-program-boundary.sql` (BLOCKED, SHA-256 `0f07717d…4261a6`) and its rollback
  (`bfdf50b7…74da9e`) add a disabled qualification row and an empty designated-subject list. Three family functions
  open only when all of these hold:
  - the row names `current_database()`;
  - both production activation rows are off;
  - the context is the production-shaped one;
  - the subject is designated.
- **Adapter and handler.** `qualification-program-assignments.ts` and `qualification-program-api.ts` run the production
  request path behind qualification execution, with `PhiAllowed=false`, activation `blocked`, designated fictional
  subjects only, and a per-transaction function-digest binding that refuses an unknown or conflicting schema.
- **Tests.** 20 PGlite cases run on the actual 112 ledger. The rollback case reproduces the original mismatch.
- **What is not added.** No Lambda entry point, no template change, and no edit to
  `qualification-program-api-candidate.json`. The old synthetic table is not grafted onto the qualification database.

## The clinic review of a join request answers one refusal (`78a74081`)

Codex's clinic-approved onboarding candidate (`workforce-clinic-approved-onboarding.sql`, `6ed75111…3628`) answered a
review of a join request three ways:

| Caller | Parent's answer |
| --- | --- |
| Unknown id | `P0002 workforce_application_not_found` |
| Another clinic's owner | `42501 production_context_refused` |
| Same-clinic non-administrator | `42501 organization_admin_required` |

So one clinic's owner could tell that a request id existed in another clinic.

**Successor.** `workforce-join-review-uniform-refusal.sql` (BLOCKED, `7086b1a9…ee29`) redefines only
`review_workforce_join_request`. All three now answer `P0002 workforce_application_not_found` before anything about the
request is read back or locked. From the parent's authority check onward the two definitions are the same text, and
`create or replace` keeps the parent's grants.

**Rollback.** `…-rollback.sql` (`fc84894d…698c`) restores the parent body. Its function body is byte-identical to the
parent's.

**Tests.** `workforce-join-review-uniform-refusal.database.test.ts`: 7 cases on the 106 artifact plus the token lookup,
the parent and the invitation repair.

- The parent's three answers are recorded first.
- The successor:
  - gives one answer to five refused callers, with nothing written;
  - lets an administrator approve once; a replay returns the same decision and a reversal is refused;
  - refuses a demoted or a suspended administrator the same way;
  - never demotes an existing owner;
  - keeps the API role as the only caller;
  - is undone exactly by the rollback;
  - matches its pins.

## The reverse separation (`78a74081`)

`outreach-separation.test.ts` adds the other direction. The clinical senders are:

- the notice switches, policy, ledger and dispatcher;
- consult intake and its emails;
- the telehealth and identity handlers and Lambdas;
- their routes.

None of them reaches a campaign module, the marketing sign-up or a campaign API, and none names a campaign table,
setting or SES configuration set. So a list subscription cannot permit, widen or suppress a clinical message.

Checked by mutation: adding an import of `@/campaigns/public` to the consult email fails it.

## Verification at this head

The exact counts, and the exact-head CI result, are in the return packet. The status levels are kept separate:

- source implemented;
- locally verified;
- CI verified;
- hosted: none;
- device: none;
- PHI: none.

## For Codex, in order (no step here was performed)

1. Review the uniform-refusal successor beside Codex's own onboarding candidate. It changes only the refusal at the
   start of `review_workforce_join_request`. Apply it after the parent in any qualification or production upgrade that
   carries the parent, and never alone.
2. Review the qualification program boundary and follow its doc's six ordered prerequisites. It needs its four BLOCKED
   parents, a qualification-only preserving upgrade, a Lambda entry point with a Core-entitlement port, and a successor
   (not an edit) of `qualification-program-api-candidate.json`.
3. Re-run exact-head CI on any integration that carries these commits. A green suite is source evidence only.
