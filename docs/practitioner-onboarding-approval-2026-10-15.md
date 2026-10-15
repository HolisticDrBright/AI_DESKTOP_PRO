# Practitioner onboarding and clinic approval — source return, 15 October 2026

Branch `claude/practitioner-onboarding-approval-20261015`. Base: `agent/clinic-messaging-integration-20261015` at
`c4358a01f46477fbd6ba75e9834d50aa28555f35`. Exact-head CI on that base was
[38814278047](https://github.com/HolisticDrBright/AI_DESKTOP_PRO/actions/runs/38814278047): success.

## The boundary this work kept

This was source work only:

- **Nothing was applied, registered or deployed.** No SQL, no ledger entry, no Cognito, no AWS setting, no secret, no
  provider release, no paid mobile build.
- **Registration is still off.** `WORKFORCE_SELF_SIGNUP_READY` is still `false`, and the app's registration route still
  refuses before it contacts Cognito.
- **Direct Cognito self-sign-up is unchanged.** It stays enabled, as Brandon decided.
- **Nothing new is enabled.**
  - The new SQL candidate is BLOCKED and unregistered.
  - The two new service handlers are blocked in source.
  - The Desktop's new admin family is refused unless a deployment pairs it with a service.
  - The applicant page says "unavailable" when there is no applicant service to ask.
- **Codex's branch at `41dd7f44`** (the qualification-program proxy) is not merged and not applied, and none of its
  files are touched. `src/server/clinical-core/rds-data-database.ts` and the credential files are not edited either.
- **Core stays education-only.** That means:
  - no lab-derived supplement directions;
  - no purchase links;
  - no paid programs and no peptide or longevity tiers;
  - no production Ask ALP;
  - no PHI and no real-patient data.

**What the green tests do and don't prove.** Green source tests are local evidence. They are not hosted verification,
device verification, commercial readiness or PHI approval. Every one of those is **unobserved** below.

The design this implements is
[one login with clinic-approved membership](workforce-membership-authority-decision-2026-10-15.md):

- Signing up, confirming an email, setting up MFA or supplying Cognito attributes never grants patient access.
- A clinic owner or admin approves a join request.
- A separately authorized platform operator reviews a new-clinic proposal, and that review itself grants nothing.

## 1. The approval authority: a BLOCKED, preserving SQL successor

The onboarding parent ([workforce-clinic-approved-onboarding.sql](../infra/aws-clinical-core/source-candidates/workforce-clinic-approved-onboarding.sql))
and its uniform-refusal successor could not enforce five things inside the deciding transaction. The failing-before
block in the database test shows each of them on the parents:

1. **Decisions carried no reason.**
2. **An admin approved by request id alone.** There was no way for the admin to name the applicant.
3. **The admin's authority was read without a lock.** A demotion could commit between the check and the write. The
   native two-session control, scenario G, shows this happening on the parent.
4. **Any well-formed string counted as a platform operator.**
5. **An approved proposal created an *active* owner.** The new clinic's patient access began at review time, and the
   current-membership setter would admit that owner at once.

[workforce-onboarding-approval-authority.sql](../infra/aws-clinical-core/source-candidates/workforce-onboarding-approval-authority.sql)
fixes all five. Its rollback is
[workforce-onboarding-approval-authority-rollback.sql](../infra/aws-clinical-core/source-candidates/workforce-onboarding-approval-authority-rollback.sql).
Both are UNREGISTERED and BLOCKED.

| File | SHA-256 |
| --- | --- |
| successor | `534d6c8baa9781a76f34421b39ddac8de0612bca5b4e729d4af70be644ab8ffb` |
| rollback | `28590e2678da6c10b87da85696a75a6792bb44e2774a9aa11cf313454b34f70c` |

It is applied after these parents, in order:

| Parent | SHA-256 |
| --- | --- |
| token-binding lookup | `4098e175…` |
| onboarding | `6ed75111…` |
| invitation repair | `e21e7820…` |
| uniform refusal | `7086b1a9…` |

The setter, `workforce-current-membership-context.sql` (`ff89c1a2…`), is what the clinic-admin functions run after.

**What it adds.**

- **Reasons.** Every decision and every revocation carries a reason from a closed vocabulary:

  | Decision | Reasons |
  | --- | --- |
  | approve a join | `identity_confirmed_by_clinic` |
  | decline a join | `not_known_to_clinic`, `credentials_not_verified`, `clinic_not_accepting`, `duplicate_request` |
  | approve a proposal | `clinic_proposal_verified` |
  | decline a proposal | `clinic_proposal_incomplete`, `clinic_proposal_declined`, `duplicate_request` |
  | revoke a membership | `left_clinic`, `credentials_lapsed`, `access_no_longer_needed`, `security_concern` |

  The reason is stored on the request and in its append-only event, and revocations go to an append-only ledger. There
  is no free text, because a narrative is where an address or a health detail ends up.
- **Naming the applicant.** An approval carries the SHA-256 of the applicant's email address as the admin knows it. It
  must equal the digest of the applicant's verified account, or it fails with `workforce_review_applicant_mismatch`. The
  database never stores the address, and the admin's queue never shows who applied.
- **Duplicate identities.** A second account holding an address already bound to another subject is refused by
  name (`workforce_binding_conflict`) before the directory's unique constraint would refuse it without one. No second
  person is created.
- **The admin's lock.** The admin's own active owner or admin membership in the selected clinic, and the clinic row,
  are locked `FOR SHARE` for the rest of the decision. A competing demotion either waits for the decision or is seen by
  it.
- **An operator registry.** `clinical_private.workforce_platform_operators` can be written only by its owner. An
  operator must be registered and active. An operator is never the applicant: not the same subject, and not a
  workforce account holding the applicant's verified address.
- **An approval that grants nothing.** An approved clinic proposal creates the clinic with its owner membership
  `pending`, under an activation hold. `activate_my_memberships` respects the hold. The setter and `has_clinical_role`
  both require an active membership, so nobody gains patient access. **Releasing a hold is not defined**; that is
  decision 1 below.
- **Reads.** The selected clinic's join queue (`list_workforce_join_requests`) returns ids, dates and decisions only.
  The operator's proposal queue (`list_workforce_clinic_proposals`) returns names and decisions, never subjects or
  digests. The applicant's own status now includes `decisionReason` and `clinicalAccess`:
  - `available` means exactly what the setter would admit now;
  - `held_for_clinic_activation` means a proposal is approved but its clinic isn't active;
  - `not_available` means the approval no longer gives access.
- **Revocation with a reason.** `revoke_workforce_membership` is `remove_org_member` with its authority, lock, owner
  and self rules unchanged, plus a reason. `remove_org_member` itself stays granted, because the Desktop team screen
  calls it (decision 3).
- **Retries and races.** A retried decision answers the stored decision with `duplicate: true`. An opposite decision
  is `workforce_review_conflict`. A replayed approval after a revocation does not restore the membership.
- **One door each.** EXECUTE on the two parent review functions is revoked, so the reasoned functions are the only
  way to decide.

**The rollback** restores the parents' function bodies and grants exactly; the test compares `pg_get_functiondef`. It
keeps every recorded decision: the reason columns, the revocation ledger and the operator registry stay, inert and
without grants. **It refuses to run while any clinic is still held**, because the parent's self-activation would then
let a held owner activate themselves.

## 2. Three interfaces, three roles

| Interface | Role | Source | Status |
| --- | --- | --- | --- |
| Applicant: submit, read, withdraw own requests | `clinical_workforce_application` | `src/server/clinical-core/aws-workforce-applications-api.ts` | blocked (`WORKFORCE_APPLICATION_API_RELEASE`); qualification pool only |
| Clinic admin: queue, approve, decline, revoke | `clinical_core_api` after the current-membership setter | `workforce-join-review.ts`, `workforce-join-review-api.ts` | blocked (`WORKFORCE_JOIN_REVIEW_API_RELEASE`); `not_released` until the setter and the three pinned function bodies are present |
| Platform operator: proposals | `clinical_workforce_operator` | `workforce-clinic-proposal-review.ts` | blocked; **no surface**, because operator sign-in is undecided (decision 2) |

A grant matrix test holds each function to exactly its role. No API role can read or write the operator registry, the
holds, the revocation ledger or the request table.

**The browser never supplies authority.** It never supplies a person id, a role, a clinic authority, an email (except
the address an admin types to approve, which leaves the service only as its digest) or a production flag.
`src/server/onboarding-routes.test.ts` sends each of these and asserts a 400 with nothing sent.

## 3. The applicant journey (Desktop `/apply`)

`src/lib/applicant-journey.ts` derives every state from a server answer; `src/components/onboarding/ApplicantJourney.tsx`
renders it.

| State | Which answer supports it |
| --- | --- |
| signed out | no session |
| unavailable | no applicant service configured (`application_service_not_configured`) or `workforce_application_not_released` |
| failed | the service did not answer, or the answer failed the contract; **never shown as "no application"** |
| rate limited | `workforce_application_rate_limited` |
| account refused | `workforce_applicant_refused`: a changed, disabled or switched account, deliberately uniform |
| account unconfirmed | `workforce_applicant_email_unverified`, from the current Cognito account |
| MFA incomplete | `workforce_applicant_mfa_required`, from the current Cognito account; covers a method removed after sign-in |
| not submitted | own rows, none pending or approved |
| join pending / proposal pending | own pending row, by kind |
| rejected / withdrawn | latest own row, with the closed reason; "Unknown" when the service gives none |
| approved, not yet authorized | an approved row where any one of the three answers below is missing. The reasons are: clinic activation held, membership not current, access unknown (a parent service that does not report access), this Desktop not on clinic-membership sign-in, or the clinic not in this session |
| clinical access available | three answers at once: the database says `available`; this Desktop runs `database_current`; the clinic is among the session's own subject-only clinics |

**Unconfirmed accounts at sign-in.** Sign-in keeps its single uniform failure for an unconfirmed account. Answering
"unconfirmed" there would tell anyone with the right password that the account exists. Confirming from this app is
unavailable while registration is closed, and the page says so.

**Finding a clinic.** There is no clinic search. A clinic gives the applicant its code, and the applicant gives the
clinic their request reference and the email address on their account. A refused submission still never reveals
whether a clinic code exists; the existing test for this is unchanged. So the page words that refusal the same as an
outage.

**Retries.** A submission keeps one request id per attempt until the service gives a definite answer. A lost reply is
resent as the same request, and the browser test asserts both posts are identical. A second request while one is
pending is answered as such, with the pending id. Withdrawal is answered from the applicant's own rows: unknown,
already withdrawn, or already decided.

## 4. Approval coverage

| Case | Evidence |
| --- | --- |
| Reasons; digest required for approval; mismatch refused | approval-authority database test, 28 cases |
| Duplicate identity: a second account holding an already-bound address is refused by name, with no second person | same |
| Unknown, foreign-clinic, non-admin, proposal-via-admin all one `not_found` | same |
| Self-approval, admin and operator | same |
| A rejection grants nothing | same |
| Idempotent retries and conflicts, both decision orders | same, sequential |
| Concurrent approvers, both orders, waiting on locks | native two-session PostgreSQL 16 script, scenarios A–C |
| Demotion or suspension after reading the queue | approval-authority database test |
| Demotion inside the deciding transaction | same |
| Demotion racing an in-flight decision, both orders | native scenarios D and E |
| Control: the parent lets the demotion commit mid-decision | native scenario G |
| Revocation: reasoned, audited, idempotent; replay doesn't restore | approval-authority database test, `workforce-join-review.database.test.ts` |
| Revocation racing an in-flight request | native scenario F |
| Operator: registry, disabled, self by subject or email | approval-authority database test |
| Operator: an approval answer that is not held is refused | `workforce-join-review.database.test.ts` |
| An approved proposal gives zero access, even with a legacy claim context | approval-authority database test |
| Audit | reason on the request, reason in the append-only event, revocation ledger, `membership.suspended` audit event |

## 5. Existing accounts and multiple clinics

**Reconciliation.** `src/server/clinical-core/workforce-account-reconciliation.ts` is read-only. Its input is a Cognito
user export the operator already holds: subject, enabled, status, email digest and legacy claims. It reads the database
once, inside `set transaction read only`. For each subject it reports, without changing anything:

- `binding_ambiguous`;
- `multiple_active_clinics`;
- `disabled_account_with_membership`;
- `disabled_identity`;
- `stale_legacy_claim`;
- `revoked_membership`;
- `held_clinic`;
- `unbound`;
- `unconfirmed_account`.

A database it cannot read makes every subject `unknown`. Its test checks that a table fingerprint is unchanged and that
only reads were issued.

**Two clinics, one login.** Two sessions bound to clinics A and B each act in their own selection. No selection
outlives its transaction, and nothing is global. The setter's own test and `workforce-join-review.database.test.ts`
cover the same at the admin interface.

**Old tokens.** The current-membership path never reads the token's clinic, so an already-issued token loses access at
the next request after a reasoned revocation or a demotion to `member`.

**Routes still trusting claims.** `src/server/clinical-core/workforce-claim-consumers.test.ts` classifies every one of
the 28 server sources that read `custom:person_id` or `custom:organization_id`:

| Class | Count | Sources or meaning |
| --- | --- | --- |
| current-membership mode | 3 | identity API, production compatibility API, telehealth requests |
| ignores the claims | 1 | |
| refuses the claims | 1 | the applicant API |
| blocked minting | 1 | the pre-token candidate |
| claim-only, failing closed | 3 | privacy operations, encounter recording, governed catalog: an account without legacy claims is refused, and the Desktop refuses the first two families under `database_current` |
| consumer domain | 8 | |
| qualification tooling | 10 | |
| this read-only reconciliation | 1 | |

## 6. Abuse, privacy and accessibility

**The shared boundary.** [`src/server/public-abuse-boundary.ts`](../src/server/public-abuse-boundary.ts) sets a fixed
policy for six surfaces: sign-up start, confirm and code resend; application submit and withdraw; and status polling.
It counts digests only, over an injected atomic counter, and it fails closed when active. It is **inactive**, because
no reviewed counter service exists. The applicant API and the Desktop applicant and registration routes ask it, and the
per-process throttles remain.

**Bounds.**

| Surface | Bound |
| --- | --- |
| requests | 2 KB |
| upstream answers | 64 KB |
| status entries | 50 |
| queue entries | 50 |

Every answer is `no-store`. The status and queue projections are strict: an unknown field fails the answer.

**Logs.** The route and API tests spy on every console method and assert none is called on any path, including
failures carrying an address. No route logs a body, an address, a code, a proposed clinic name or a health detail.

**Accessibility.** The browser spec drives everything by keyboard: the radio group, Enter to submit, the withdraw
confirmation, and admin approve and remove. Every control is found by role and label. Status and alert regions are
live, the state heading takes focus after each answer, and every pending state is busy. Each recovery message says
what is known; a lost reply, for example, says the decision may or may not have been recorded. No axe tooling is
installed, so contrast and full screen-reader behavior are **unobserved**.

## 7. An unapproved account has zero clinical access

`src/server/unapproved-account-zero-access.test.ts` uses a signed-in account whose token has no clinic or person claim
and no clinic selection. It calls the real routes for:

- the chart;
- messages;
- programs;
- the billing workspace;
- export (privacy operations);
- telehealth start;
- encounter recording;
- join review.

Results:

- **Under `database_current`**, with every converted family paired, every route refuses and nothing leaves the
  process.
- **Under the legacy sign-in**, every route refuses, and nothing that leaves names a clinic.
- **At the database**, a direct sign-up, a pending applicant and a rejected one are admitted to no clinic, and no
  person exists for them.

The same matrix, minus join review (which isn't there), also passes on the base `c4358a01`. The new code opened no path.

## 8. Source-interface request to Codex

`rds-data-database.ts` does not classify any onboarding refusal name. Through the production data client, every
applicant and admin refusal therefore arrives unclassified and reads as `service_unavailable`. That is honest and fails
closed, but it is imprecise. The adapter maps the names once they arrive as `ClinicalCoreDatabaseRejection` with
`reason` set to the name; the mapping is in `JOIN_REVIEW_SQL_REFUSALS` in `workforce-join-review.ts`. The names:

- `workforce_review_invalid`
- `workforce_revocation_invalid`
- `workforce_application_not_found`
- `membership_not_found`
- `workforce_review_conflict`
- `workforce_review_applicant_mismatch`
- `workforce_self_approval_refused`
- `self_suspension_refused`
- `workforce_already_member`
- `workforce_clinic_unavailable`
- `workforce_binding_conflict`
- `organization_admin_required`
- `owner_role_required`
- `last_owner_protected`
- `workforce_operator_refused`

The applicant API sidesteps this by answering from the applicant's own rows. I did not edit the file.

## 9. Decisions that are Brandon's

1. **What activates an approved new clinic, and who records it.** Agreements or a BAA, verification? Until that is
   decided, an approved proposal stays held and no release path exists.
2. **How a platform operator signs in, and who adds a subject to the operator registry.** A separate pool, MFA, a
   named person? This is a new privileged actor. Until it is decided, the operator interface has no route and no
   surface.
3. **Whether `remove_org_member`, the unreasoned removal the team screen uses, is withdrawn** in favour of the reasoned
   revocation.
4. **How clinics hand out their clinic code**, since there is no directory by design.
5. **The applicant API's pool.** The candidate pins the qualification pool. A production applicant path needs the
   production pool decision and its immutable-attribute consequences (see the blocker doc).
6. **The shared abuse counter service and the edge bot protection**, both of which need review.

## 10. Status by level

| Item | Implemented | Locally verified | CI verified | Hosted | Device | PHI-approved |
| --- | --- | --- | --- | --- | --- | --- |
| Approval-authority SQL successor + rollback | yes, BLOCKED | 28 database cases; on the parents alone 20 fail, 4 skip and 4 pass (the 4 passes are the parent-defect cases); native two-session races: 7 scenarios, 31 checks | see the hand-back | unobserved | n/a | no |
| Clinic-admin interface (service, handler, Desktop route, card) | yes, blocked or gated off | 12 database cases, 6 route cases, browser spec | see the hand-back | unobserved | n/a | no |
| Platform-operator interface | yes, blocked, no surface | 3 database cases | see the hand-back | unobserved | n/a | no |
| Applicant API changes | yes, blocked | 27 cases, 5 failing before | see the hand-back | unobserved | n/a | no |
| Desktop applicant journey | yes; unavailable without a service | 7 state cases, 6 route cases, browser spec | see the hand-back | unobserved | unobserved | no |
| Read-only reconciliation, two-clinic sessions, old-token removal | yes | 7 database cases | see the hand-back | unobserved | n/a | no |
| Claim-reader inventory | yes | 2 cases | see the hand-back | n/a | n/a | n/a |
| Zero access for an unapproved account | proof | 2 cases (also on base) + database case | see the hand-back | unobserved | n/a | no |
| Shared abuse boundary | yes, **inactive** | 4 cases | see the hand-back | unobserved | n/a | n/a |

## 11. Ordered hosted work for Codex (none of it performed)

1. **Classification.** Add the onboarding refusal names (§8) to the production data client's classifier, with
   `reason` set to the name.
2. **Qualification SQL.** In the qualification database only, with fictional rows, apply in order:
   1. token-binding lookup;
   2. onboarding;
   3. invitation repair;
   4. uniform refusal;
   5. the current-membership setter;
   6. this successor.

   Record each in the ledger at the version `apply_migration` stamps. Keep the rollback beside it, and drill it
   against an empty hold table.
3. **Roles.** Create database users or secrets for:
   - `clinical_workforce_application`, used by the applicant API connection;
   - `clinical_workforce_operator`, used only once decision 2 is made.

   Grant the clinic-admin functions to `clinical_core_api` only. Confirm nothing else holds EXECUTE or table access.
4. **Cognito.** For the applicant API, a scoped `cognito-idp:AdminGetUser` on the qualification pool only. No attribute,
   trigger or client change.
5. **Hosts.** Mount the applicant API and the join-review API behind API Gateway JWT authorizers. Change each release
   constant only by a reviewed change, and set the Desktop's `WORKFORCE_APPLICATIONS_API_ORIGIN`,
   `WORKFORCE_JOIN_REVIEW_API_ORIGIN` and `CLINICAL_CURRENT_MEMBERSHIP_FAMILIES=workforce_join_review` only together
   with them.
6. **Fictional hosted tests**, two sessions where it matters:
   - sign-up, confirmation, MFA setup;
   - MFA method removal, which should read as MFA incomplete;
   - an account switch, which should be refused;
   - submit, then a lost-reply resend, which converges;
   - a second request, answered as pending;
   - withdraw;
   - a clinic admin approving by address and declining with a reason;
   - two admins at once, in both orders;
   - a demotion during review;
   - revocation during an in-flight request, then the next request refused;
   - an operator approving a proposal, then zero access for the proposer;
   - two clinics in two tabs;
   - a direct Cognito sign-up reaching nothing clinical;
   - a database outage, which should refuse.
7. **Reconciliation.** Run the read-only reconciliation against a fictional Cognito export, then against the
   production export **read-only**, before any trigger or backfill.
8. **Abuse controls.** A reviewed shared counter service and edge bot protection, then activate the boundary.

Each step is still separate from PHI, the commercial launch and real-patient testing.
