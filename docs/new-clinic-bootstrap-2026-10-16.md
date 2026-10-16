# New-clinic bootstrap: immediate access to a clinic you create (source, disabled), 16 October 2026

Branch `claude/new-clinic-bootstrap-20261016`. Base: `agent/onboarding-refusal-map-20261015` at
`5873ae26149ef1d38c2c2b44b614156009f781e5`. Exact-head CI on that base,
[38828712715](https://github.com/HolisticDrBright/AI_DESKTOP_PRO/actions/runs/38828712715), succeeded. The base's
onboarding refusal mapping is complete and was not redone.

## Status

- **Immediate record access is not implemented in any live system, and nothing can reach it.**
- The currently applied path, the approval-authority successor, still holds every new clinic. The bootstrap is a
  separate, BLOCKED SQL candidate.
- **It is disabled at every layer pending the production security, agreement, privacy and PHI reviews:**
  - `WORKFORCE_CLINIC_BOOTSTRAP_RELEASE` is `blocked`, so its routes refuse before reading an account or a row;
  - `PLATFORM_OPERATOR_SIGN_IN_RELEASE` is `blocked`;
  - the SQL candidate is unregistered, and even once applied it refuses until its owner-only release row is switched on;
  - no Lambda entrypoint, host, Desktop surface or operator pool exists.
- **Nothing was applied, registered, deployed or configured.** No ledger entry, Cognito pool, AWS setting, secret or
  PHI was touched.

## What Brandon decided, and how it is designed

| Decision | Design |
| --- | --- |
| A practitioner who creates a **new** clinic can create and open patient records in it immediately after completing sign-up | One transaction makes the verified subject the **active owner** of a new, empty clinic. The current-membership setter admits them to that clinic at once. |
| …and never records belonging to another clinic | The call names no existing clinic, so it cannot join, read or attach to one. The new clinic starts with no patients, staff or records. Every clinical read runs under the setter's selected clinic. |
| Existing-clinic applicants still require clinic approval | Unchanged. A join request waits for the clinic's owner or admin. A clinic proposal reviewed by a platform operator is still held. |
| Platform operators use a separate MFA-protected login | `platform-operator-authenticator.ts` requires its own pool and client, distinct from every workforce and consumer pool. Cognito must report that pool with MFA **required**. The operator account must be TOTP-preferred and unchanged since a sign-in made within the last 15 minutes. A workforce token is refused even when its subject is in the registry. |

"Completing sign-up" means a confirmed address **and** an active MFA method, both read from the identity provider's
current account on every request (the applicant API's existing check). The database then requires the service to attest
`verified_email_and_mfa`, and refuses any other value.

## 1. The SQL candidate (BLOCKED, unregistered)

[workforce-new-clinic-bootstrap.sql](../infra/aws-clinical-core/source-candidates/workforce-new-clinic-bootstrap.sql)
and its rollback,
[workforce-new-clinic-bootstrap-rollback.sql](../infra/aws-clinical-core/source-candidates/workforce-new-clinic-bootstrap-rollback.sql).

| File | SHA-256 |
| --- | --- |
| candidate | `9d02c85e8b62232b8df71d5c68d1dfa1f0db7fd1f52b0cae52e4ee704a9c13c5` |
| rollback | `d0702843c5019f96687aa037a6cceb0c8a3b73886f822e4d2b93e91540499d6d` |

Its parents are the onboarding chain, applied in this order:

1. token-binding lookup
2. onboarding
3. invitation repair
4. uniform refusal
5. setter
6. approval-authority successor (`534d6c8b…`)

**Tables:**

- **Release row.** A singleton, `enabled = false`. Only the table owner can write it.
- **`workforce_clinic_bootstraps`.** One row per bootstrap, with a unique index on the subject.
- **`workforce_clinic_bootstrap_events`.** Append-only.

No API role can read or write any of them.

**Functions, each granted to exactly one role:**

| Function | Role | What it does |
| --- | --- | --- |
| `bootstrap_workforce_clinic(request, subject, emailDigest, name, assurance)` | `clinical_workforce_application` | Creates the clinic and the active owner, or answers the stored result for a retry |
| `workforce_clinic_bootstrap_for_subject(subject)` | `clinical_workforce_application` | The applicant's own clinic: ids, state and access, nothing about anyone else |
| `suspend_bootstrapped_workforce_clinic(clinic, operator, reason)` | `clinical_workforce_operator` | Revocation: suspends the clinic and its owner membership, with a reason |

**Refusals, all by name:**

| Name | When |
| --- | --- |
| `workforce_clinic_bootstrap_not_released` | the release row is off |
| `workforce_bootstrap_assurance_required` | the service did not attest `verified_email_and_mfa` |
| `workforce_bootstrap_conflict` | the same request id with another subject, address or name |
| `workforce_clinic_bootstrap_exists` | a second clinic for one account |
| `workforce_request_pending` | an operator proposal for a new clinic is still pending |
| `workforce_binding_conflict` | the address belongs to another account |
| `workforce_operator_refused` | a registered operator tried to bootstrap |

**The rollback** drops every door and switches the release row off. It keeps every recorded row and every clinic in its
state: rolling back the door is not a decision about the clinics that came through it.

## 2. The properties, and the tests that hold them

PGlite runs the database test (`src/server/clinical-core/workforce-new-clinic-bootstrap.database.test.ts`) on the
assembled 106-migration production schema plus the parents: **16 cases**. True two-session overlap needs a real server,
so `scripts/qualify-workforce-bootstrap-native.mjs` runs on a disposable local PostgreSQL 16 cluster: **5 scenarios, 20
checks**.

| Property | Evidence |
| --- | --- |
| **Before (failing-before):** on the applied path, an operator-approved new clinic grants nothing, and no bootstrap door exists | database test, "before the bootstrap candidate" |
| Off until the owner switches it on; no API role can switch it | database test |
| Each door is callable by exactly its role; no API role can touch the tables | database test (grant matrix) |
| **Fresh-clinic isolation:** an active owner, admitted to the new clinic only. Clinical role there, zero patient rows there; clinic A still sees only its own patient. One membership, no patients. | database test |
| A member of clinic A who creates a clinic keeps exactly their clinic-A access; the two stay separate | database test |
| Existing-clinic applicants still wait; the door takes no clinic argument | database test |
| Assurance must be attested; any other value creates nothing | database test; route test (no MFA method is a 403) |
| **Retries:** a lost-reply retry converges on its request id and answers 200 with the same clinic | database test; route test |
| **Account switches:** the same request id under another account is a conflict; the route sends the current account, never the old one | database test; route test |
| One clinic per account; a second tab is refused by name | database test; native **B** (the second session waits, then is refused) |
| **Concurrent sign-ups:** one account racing itself gets one clinic (native **A**); two accounts with the same name never wait for each other and get two clinics, each admitted only to their own (native **C**) | native A, C; database test |
| Pending proposal, address of another account, registered operator: refused | database test; route test |
| **Revocation:** an operator suspension ends access for the owner **and** staff. A replay answers `not_available` and restores nothing. A new request id is refused. The record is append-only. | database test |
| A suspension waits for an owner's admitted request, then the next request is refused | native **D** |
| An owner request issued during an uncommitted suspension waits, then is refused | native **E** |
| The operator is never the owner; an unknown clinic is not found | database test |
| Switching the release off refuses new clinics and leaves existing ones as they are | database test |
| Rollback removes the doors and keeps rows and clinics | database test |
| The browser names no clinic, person, role, subject, flag or assurance (each is a 400 with nothing sent) | route test |
| Unclassified failures answer 503 with no SQL text | route test |
| **Operator sign-in.** Must be separate (shared pool or client refused). Refused cases: a workforce token, an access token, another client, a stale or expired sign-in, MFA optional or off, SMS-only or SMS-preferred, no MFA, disabled, changed since sign-in, unverified, federated. Blocked before any token is read. | `platform-operator-authenticator.test.ts` |

## 3. Server source (blocked)

- **Store and service.** `src/server/clinical-core/workforce-clinic-bootstrap.ts`: the store over the applicant role,
  the service (it refuses a mismatched answer), the operator's suspension service, and the refusal map.
- **Routes.** `src/server/clinical-core/aws-workforce-applications-api.ts` gains
  `GET`/`POST /clinical-core/workforce/clinic-bootstrap`.
  - They are refused (503 `workforce_clinic_bootstrap_not_released`) unless a bootstrap store is supplied **and**
    released.
  - That check comes before the abuse counter, the account read or any query.
  - Once released, they reuse the applicant API's existing checks: token, current account, confirmed address, MFA
    method.
- **Operator sign-in.** `src/server/clinical-core/platform-operator-authenticator.ts`. It supplies `verifiedOperatorSubject`
  to the proposal review and to the suspension service. The registry check remains inside each operator SQL function.
- **Not built.** No Desktop surface for the bootstrap or for operators. The `/apply` page still offers the held
  proposal.

## 4. Decisions still Brandon's

1. **What must exist before a bootstrapped clinic holds real patient data.** Agreements or a BAA accepted, identity or
   licence verification, payment? The candidate admits the owner at once once it is released. Any such requirement must
   be decided, and added to the bootstrap transaction, before release.
2. **One bootstrapped clinic per account.** This is what the candidate enforces. A second clinic would go through the
   operator proposal.
3. **Suspension reasons, and whether a suspended clinic can ever be reinstated.** No reinstatement is defined.
4. **Who creates the operator pool and registers operators,** and who reviews that registry.
5. **Whether `remove_org_member` stays.** This carries over from the onboarding decisions.

## 5. Source-interface request to Codex

The production data client (`rds-data-database.ts`, Codex's file, not edited) needs to classify the bootstrap refusal
names into `ClinicalCoreDatabaseRejection` with `reason` set to the name. Until then they arrive unclassified, and the
routes answer `503 workforce_application_unavailable`. The names:

- `workforce_clinic_bootstrap_not_released`
- `workforce_bootstrap_assurance_required`
- `workforce_bootstrap_invalid`
- `workforce_bootstrap_conflict`
- `workforce_clinic_bootstrap_exists`
- `workforce_request_pending`
- `workforce_bootstrap_suspension_invalid`
- `workforce_clinic_bootstrap_not_found`

## 6. Ordered work for Codex (none performed)

1. Classify the names in §5.
2. In the qualification database only, with fictional rows, apply the onboarding chain and then this candidate. Record
   it at the version `apply_migration` stamps, keep the rollback beside it, and drill the rollback.
3. Create the operator user pool and client, separate from the workforce and consumer pools: MFA **required**, TOTP
   only, no federation. Create a scoped `DescribeUserPool` + `AdminGetUser` reader for it. Register operator subjects
   only through a reviewed owner-run change.
4. Re-run `scripts/qualify-workforce-bootstrap-native.mjs` against the qualification engine's PostgreSQL version.
   Confirm that RDS Data API transactions hold the setter's and the suspension's row locks across statements.
5. **Only after the security, agreement, privacy and PHI reviews:**
   - mount the routes behind the applicant API's JWT authorizer;
   - change `WORKFORCE_CLINIC_BOOTSTRAP_RELEASE` and `PLATFORM_OPERATOR_SIGN_IN_RELEASE` by reviewed changes;
   - switch the release row on as the owner.
6. Fictional hosted tests for each of these:
   - sign-up, confirmation, MFA setup, then bootstrap and the first patient record;
   - a second account trying to read that clinic;
   - a lost-reply retry;
   - two tabs;
   - two accounts racing with the same name;
   - an account switch between attempt and retry;
   - MFA removal, then a refusal;
   - an operator suspension during an open request, then a refusal;
   - a workforce token at an operator route.

## 7. Status by level

| Item | Implemented | Locally verified | CI verified | Hosted | PHI-approved |
| --- | --- | --- | --- | --- | --- |
| Bootstrap SQL candidate + rollback | yes, BLOCKED | 16 database cases; native 5 scenarios / 20 checks (PostgreSQL 16.15) | see the hand-back | unobserved | no |
| Bootstrap routes and service | yes, blocked | route and service tests | see the hand-back | unobserved | no |
| Separate MFA operator sign-in | yes, blocked; no pool exists | authenticator tests | see the hand-back | unobserved | no |
| Operator suspension service | yes, blocked; no surface | service test + database cases | see the hand-back | unobserved | no |
| Desktop surface | **no** | — | — | — | — |
