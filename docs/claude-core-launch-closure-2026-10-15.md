# Core launch and program-delivery closure, Desktop side (2026-10-15)

The $19.99 Core is education-only. Lab-derived plans, AI supplement directions, purchase links, production Ask ALP,
peptides and longevity programs stay withheld. Everything here is source, with fictional data only:

- no deployment, no SQL registered or applied, no AWS, Cognito, Stripe or Fullscript change;
- no feature activated, no real patient data, no paid build;
- nothing merged to `main`.

Every candidate stays BLOCKED. A refusal, a skip, a source assertion or a fictional fixture here is not hosted or PHI
evidence.

| Repository | Base | Branch |
| --- | --- | --- |
| AI_DESKTOP_PRO | `agent/telehealth-membership-guard-20261015` @ `2883f2122415df14f21227a66473cfca1f173659` (carries the PPS head `4451c26`) | `claude/core-launch-closure-20261015` |
| AI_LONGEVITY_PRO_V2 | `agent/v2-telehealth-membership-pair-20261015` @ `0aa4ce8f` (carries the PPS head `76efc348`) | `claude/core-launch-closure-20261015` |

The V2 half, with the WP1 journey audit and the wording drafts, is
`expo/docs/claude-core-launch-closure-2026-10-15.md` in AI_LONGEVITY_PRO_V2.

## WP2 — clinic membership: an invitation never changes an existing membership

The clinic-approved onboarding design is Codex's (`agent/workforce-clinic-approved-membership-20261015`,
`docs/workforce-membership-authority-decision-2026-10-15.md` there). It was reviewed here, not duplicated. It keeps
the existing invitation function, and that function had a defect.

`clinical_core.add_org_member`, as `20260826161000_production_workforce_email_digest_repair.sql` last defined it,
upserted on (organization, person) and overwrote the role. An admin who re-invited an existing owner as `member`
demoted them, past `set_org_member_role`'s owner guards (only a NEW owner invitation is checked). Any active member's
role could be changed by an invitation, with no audit of it as a role change. A suspended member was reinstated by
being invited again.

`infra/aws-clinical-core/production-candidates/workforce-invitation-role-repair.sql` (BLOCKED) redefines only that
function, identical except for the conflict clause: an existing membership refuses with `membership_exists`. Its
rollback restores the 161000 definition. `src/server/clinical-core/workforce-invitation-role-repair.database.test.ts`
(5 cases) runs on the 106-migration artifact. It shows the original demoting an owner, through the rollback inside a
transaction it then undoes, and the candidate refusing, and it covers a pending invitation and a suspended member.
The candidate is independent of Codex's two candidates and can be applied before, after or without them.

Review findings on Codex's candidate, recorded in the V2 return for Codex:

- MFA rests on the pool configuration alone. `MfaConfiguration: ON` is asserted by `infrastructure.test.ts`; the
  applicant boundary's current-account read could also require a software-token MFA setting.
- `review_workforce_join_request` answers `workforce_application_not_found` for an unknown id and
  `organization_admin_required` for another clinic's, which tells one clinic's admin that a request id exists.

## WP3 — the priced successor to the program-step purchase

`infra/aws-clinical-core/production-candidates/program-step-purchase-priced.sql` (BLOCKED) and its rollback.

- **Price.** `clinical_private.program_step_price_configured(enrollment, organization)` is true only for an active,
  `invoice_required` program offer with a positive `price_cents` and a three-letter currency. Prices for separately
  purchased programs are not decided, so today every step refuses with `program_price_unset`.
- **Order of checks.** `clinical_core.program_step_purchase_priced_check(jsonb)` requires both the priced activation
  and the consumer boundary's. It takes the predecessor's purchaser and reason first (owner, enrollment, step,
  revisions, catalog, current review), and only then the price. Another owner's step is refused as before, without
  learning whether a price exists.
- **No way round.** EXECUTE on the unpriced `program_step_purchase_check` is revoked from `clinical_core_api`, so the
  price cannot be skipped by calling the older function.
- **Adapter.** `src/server/fullscript/program-step-purchase.ts` takes activation evidence
  `program-step-purchase-activation/2`, naming the boundary and priced candidate digests, and calls the priced check.
  Anything else is the disabled activation.
- **Contract.** `src/contracts/programStepPurchase.ts` (byte-mirrored, pinned in both suites) adds
  `program_price_unset`. The database classifier (`rds-data-database.ts`) knows it.

`src/server/fullscript/program-step-purchase.database.test.ts` (19 cases) covers:

- the predecessor's verdict with no price;
- no price, a complimentary offer, a zero price and a draft offer;
- the price removed between issue and redemption;
- another owner's step refused first;
- the boundary off;
- the API role unable to call the unpriced check or to flip the activation;
- the rollback.

The seeded offer is labelled `FICTIONAL PRICE FOR TESTS ONLY` and priced at 1 cent; no price was chosen. Booking a
consultation is not a purchase and is unaffected.

## WP4 — My courses: withdrawn access closes the lesson

`src/lib/learner/learnerController.ts`:

- **Withdrawn access.** A save refused as `not_active` or `not_owner` closes the lesson and course and re-reads access,
  so the list shows the course as it now stands. Before, the lesson and "Mark complete" stayed.
- **Lapsed access.** `send` checks access before sending, so a retry after access lapsed sends nothing. Before, the
  earlier completion was resent.
- **Unreadable lessons.** `goTo` ignores a lesson outside the readable outline, so it is never opened or sent as a
  place.

Three cases in `learnerController.test.ts` fail before and pass after. The Outline already rendered only the parsed
outline, which was already correct.

## Gates, at `5ff16c04`

| Gate | Result |
| --- | --- |
| Typecheck (`tsc --noEmit -p .`) | clean |
| Lint (`eslint --max-warnings=0`, the 8 script files changed since `2883f212`) | 0 problems |
| Unit (`npm run test:unit`, embedded-database tests included) | 556 files; 8,794 passed, 11 skipped by declaration |
| Failing before | `learnerController.test.ts`: 3 of 13 failed with `learnerController.ts` as at `2883f212`. The invitation repair's original behaviour is shown inside its own test. The priced candidate's 19 cases are coverage of a new candidate |

The browser battery was not re-run on this branch: no page, route or stub changed. Exact-head CI is in the return
message.

## Candidate digests (committed LF bytes)

| File | SHA-256 |
| --- | --- |
| `program-step-purchase-priced.sql` | `ab387d5f5576bf39e2553ea6c4acd8a0a5dfb176a4a4782503fa979eec2ad143` |
| `program-step-purchase-priced-rollback.sql` | `4b44f32f05f4d9928b46aac1d7f0e45212000de761796a58e079d3737b5e3a06` |
| `workforce-invitation-role-repair.sql` | `e21e78205a5dbb06b20ab5f800132357c00c92ec80c25ce38722b998caaadf03` |
| `workforce-invitation-role-repair-rollback.sql` | `c148a18b246313927e38093383265541bd1fe55b080a96481a9982194eeb931a` |
| `src/contracts/programStepPurchase.ts` (mirror) | `0b1f34aeb7b8ed731fbd8f7b490660ef038d1b89198e5bfc8415eb6225385e7f` |
| `program-step-purchase.sql` (predecessor, unchanged) | `ad66f389221ca77681bc94a0f75b9d6ab45d9656e3431cce22e5cd026de042de` |

## For Codex, in order

1. Review and, if accepted, register `workforce-invitation-role-repair.sql` with its rollback. It touches only
   `add_org_member`.
2. Consider the two findings on the clinic-approved onboarding candidate: an MFA check in the applicant's
   current-account read, and one refusal for unknown and foreign request ids.
3. Review `program-step-purchase-priced.sql` after `program-step-purchase.sql` and the consumer boundary. It needs
   both activations, and both are disabled.
4. The consumer program read must name the care connection an enrollment was assigned through, or no step binding can
   be built (V2's `programConnectionFor` answers `null`).
5. Hosted, on fictional identities:
   - the priced check against real PostgreSQL privileges;
   - the invitation repair on a hosted copy of the schema;
   - learner access revocation through the deployed route.
