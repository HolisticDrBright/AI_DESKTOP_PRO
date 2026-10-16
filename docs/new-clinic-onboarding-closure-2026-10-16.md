# New-clinic onboarding closure: release packet (source, disabled), 16 October 2026

**Source only, every switch blocked.** Nothing here was applied, registered, deployed or configured:
- no SQL ran against any hosted database;
- no Cognito pool, client, operator account or registry entry was created;
- no AWS setting, secret, billing value, PHI flag or mobile build changed;
- no real patient information was used.

Every record in every test is fictional.

Brandon's eventual goal is immediate access to the records of a newly created clinic, and only that clinic. This work
does **not** authorize that. The agreement, identity/licence, security, privacy and PHI reviews come first, and their
gates are Brandon's to set (§8).

## 1. Source pair, commits and parent order

- **Base:** `claude/new-clinic-bootstrap-20261016` at `cacd5d6db8ffe80e913af6cd96caca970417fd26`. The remote head was
  confirmed before branching.
- **Branch:** `claude/new-clinic-onboarding-closure-20261016`. It is pushed and not merged to `main`.

| Commit | What |
| --- | --- |
| `c7f669a9` | Bootstrap candidate: the same-address race is refused by name; native scenarios F and G |
| `ad18dd7a` | WP1: two doors on `/apply`; the new-clinic route over the blocked bootstrap |
| `29b714ab` | WP2: the clinic step after sign-in; `/select-clinic` |
| `17ba7561` | WP3: the blocked operator console, its listing candidate, the separate operator sign-in |
| `653397b2` | WP4: adversarial coverage (MFA removal, applicant/operator separation, native scenario H) |
| `5ddb154c` | WP4: the browser journey for the new screens |
| packet commit | This document, the bootstrap design-doc update and the index row. Its exact-head CI is reported in the hand-back; a file cannot hold its own CI result. |

**V2 pair:** unchanged. This lane touches no V2 code. The V2 launch index still pins Desktop
`c4358a01f46477fbd6ba75e9834d50aa28555f35`, and the new-clinic lane is not part of that pair.

### Candidate chain (SQL, all BLOCKED and unregistered)

They apply over the 106-migration production artifact in this order. SHA-256 is taken over LF bytes.

| # | File | SHA-256 |
| --- | --- | --- |
| 1 | `source-candidates/workforce-token-binding-lookup.sql` | `4098e1757b38fd1a0893185e765f1a9d5b74baf90da11f495ec957ff8e9fe165` |
| 2 | `source-candidates/workforce-clinic-approved-onboarding.sql` | `6ed75111bb58c11ad3741b2d96d200d4af7f018735224354454b23ddaacf3628` |
| 3 | `production-candidates/workforce-invitation-role-repair.sql` | `e21e78205a5dbb06b20ab5f800132357c00c92ec80c25ce38722b998caaadf03` |
| 4 | `source-candidates/workforce-join-review-uniform-refusal.sql` | `7086b1a90db8cac47120a9d2be54f91f966b24e264351d3a247be838c872ee29` |
| 5 | `source-candidates/workforce-current-membership-context.sql` | `ff89c1a2d5b934a3a49437099d14b34e5dffed400ae332f26eea2c311a891342` |
| 6 | `source-candidates/workforce-onboarding-approval-authority.sql` | `534d6c8baa9781a76f34421b39ddac8de0612bca5b4e729d4af70be644ab8ffb` |
| 7 | `source-candidates/workforce-new-clinic-bootstrap.sql` (parent 6, pinned by hash) | `82efb74c41fe8da9934538332398101cfb25e73006d59fa306746f637f1d8eb1` |
| 8 | `source-candidates/workforce-bootstrap-operator-listing.sql` (**new**; parent 7, pinned by hash) | `5a7af23d78387eab099e2c749b87edc52234b61eca8893cc54bf37d38639351b` |

| Rollback | SHA-256 | Order |
| --- | --- | --- |
| `workforce-bootstrap-operator-listing-rollback.sql` | `65bf4f9406dbad117df779653cdf29c5c01c181a8bfd96cd752356aff407c164` | first |
| `workforce-new-clinic-bootstrap-rollback.sql` | `d0702843c5019f96687aa037a6cceb0c8a3b73886f822e4d2b93e91540499d6d` | second |

The sibling used for the first-clinic choice is `source-candidates/workforce-membership-discovery.sql`
(`18d802626f1939d3a45fb44bdc658da5052851147c6867af9409dc4bf36763d2`). It is applied in the database test beside the
chain, but it is not part of the chain.

The adapters pin these hashes:
- `workforce-clinic-bootstrap.ts` pins candidate 7 and its rollback;
- `platform-operator-console.ts` pins candidate 8 and its rollback.
The database test checks each pin.

## 2. Feature switches (all off)

| Switch | Where | Holds |
| --- | --- | --- |
| `DESKTOP_CLINIC_BOOTSTRAP_RELEASE = 'blocked'` (**new**) | `src/server/clinic-bootstrap-release.ts` | `/api/onboarding/clinic-bootstrap` GET and POST, before any session read |
| `WORKFORCE_CLINIC_BOOTSTRAP_RELEASE = 'blocked'` | `workforce-clinic-bootstrap.ts` | the applicant API's bootstrap routes and the suspension service |
| `DESKTOP_PLATFORM_OPERATOR_CONSOLE_RELEASE = 'blocked'` (**new**) | `src/server/platform-operator-release.ts` | `/api/operator/*` (session, proposals, clinics), before any cookie or body |
| `PLATFORM_OPERATOR_CONSOLE_RELEASE = 'blocked'` (**new**) | `platform-operator-console.ts` | the operator API's four routes, before any header |
| `PLATFORM_OPERATOR_SIGN_IN_RELEASE = 'blocked'` | `platform-operator-authenticator.ts` | the operator token check, before any token is read |
| `WORKFORCE_CLINIC_PROPOSAL_REVIEW_RELEASE = 'blocked'` | `workforce-clinic-proposal-review.ts` | proposal review |
| `WORKFORCE_APPLICATION_API_RELEASE` / activation `blocked` | applicant API configuration | the whole applicant API |
| `clinical_private.workforce_clinic_bootstrap_release.enabled = false` | SQL candidate 7 | the bootstrap itself; only the table owner can switch it |
| `CLINICAL_WORKFORCE_AUTHORITY_MODE` unset (legacy) | deployment | the clinic step and subject-only discovery apply only under `database_current` |
| PHI | deployment | `/apply` shows the fictional-records notice unless the runtime is `production-clinical` **and** `PHI_ALLOWED=true` (fail-closed) |

## 3. What was built

### WP1: two doors on `/apply`

The page offers **"Create a new clinic"** and **"Request to join an existing clinic"**.

**Create** goes to `/api/onboarding/clinic-bootstrap` (`src/contracts/workforceClinicBootstrap.ts`). The browser sends
`{requestId, clinicLabel}` and nothing else:
- a clinic, role, subject, address, assurance or flag in the body is a 400, and nothing is sent;
- upstream, only the session token goes, through `src/server/workforce-applicant-upstream.ts` (execute-api origin
  only, bounded JSON);
- an answer that is not this request's is refused.

The states, all derived in `src/lib/clinic-bootstrap-journey.ts`:
- **Prerequisites:** email unverified, or MFA not set up.
- **Pending:** a join pending, or a proposal pending. A pending proposal blocks creation, as the database does.
- **Ready:** shown only when the database says access is available, this Desktop signs in by current membership, and
  the clinic is in this session's discovery. "Open your clinic" goes through the ordinary switch.
- **Created, not authorized:** one reason each for membership not current, legacy sign-in, and not in session.
- **Suspended:** with its recorded reason, and the sentence "This app has no way to reinstate a clinic."
- **Lost or unconfirmed reply:** the same request id is kept, so a resend converges and never makes a second clinic.
- **Named refusals:** exists, conflict (which starts a fresh attempt), pending proposal, MFA, email, refused, closed,
  rate limited, cross-site, signed out, not configured.

**Join** is the existing clinic-code request, unchanged. It still waits for the clinic's approval. The held operator
proposal remains the way to ask for a new clinic while the create door is closed, and for a second clinic. It is
reached under "Create a new clinic".

### WP2: first clinic and account switching

Under `database_current`, password and MFA sign-in report a `clinicStep` from the account's subject-only discovery:

| Step | Discovery | Then |
| --- | --- | --- |
| `selected` | one clinic | it is selected; go to the requested page |
| `choose` | several clinics | `/select-clinic` |
| `onboard` | none (pending memberships are not access) | `/apply` |
| `unknown` | read failed | `/select-clinic`, which shows the failure apart from "none" |

The selection cookie is rewritten for the signing-in account every time.

`/select-clinic` (`src/lib/clinic-chooser.ts`):
- never pre-chooses one of several clinics;
- lists pending memberships apart from the choices;
- checks the choice again on the server (`/api/auth/org`) and binds it to the account;
- tells other tabs to drop their state.

The legacy default reports no step and is unchanged.

### WP3: the operator console (blocked)

**SQL candidate 8.** An active registered operator reads the 50 newest bootstrapped clinics and each recorded decision:
created, or suspended with a closed reason. The deciding operator is shown only as a 16-hex fingerprint
(`aidp-operator/1`), plus `byCaller`. It returns no owner subject, address, person or membership, and writes nothing.

**Operator API** (`createPlatformOperatorConsoleApi`), four routes:
- `GET /clinical-core/platform-operator/clinic-proposals`
- `POST …/clinic-proposals/decision`
- `GET …/bootstrapped-clinics`
- `POST …/bootstrapped-clinics/suspension`

The operator is verified **once per request** by `createPlatformOperatorAuthenticator`: the operator pool's own
client, an ID token, a sign-in within 15 minutes, pool MFA `ON`, and TOTP preferred. Only then does it read the body.
A practitioner token is refused before any transaction. A selected clinic or a query is a 400. A body with an unknown
field is refused before the operator is looked up. There is no reinstatement route.

**Desktop:**
- **`/api/operator/session`:** password, then a TOTP challenge, against `PLATFORM_OPERATOR_COGNITO_CLIENT_ID`. The
  client is refused if it equals the workforce or consumer client. No MFA, MFA setup, SMS and wrong credentials are all
  refused the same way.
  - The operator ID token is kept for 15 minutes in `aidp_op`, an httpOnly, SameSite=strict cookie scoped to
    `/api/operator`.
  - No refresh token is kept. No practitioner cookie is read or written.
- **`/api/operator/clinic-proposals` and `/api/operator/bootstrapped-clinics`:**
  - send only `aidp_op`, never `aidp_at`, to `PLATFORM_OPERATOR_API_ORIGIN` (execute-api; refused if it equals the
    applicant or workforce API);
  - bodies are strict, answers are validated, and an approval that is not held is never shown;
  - a refused operator's cookie is cleared.
- **`/operator`:** the page renders nothing private. It offers the separate sign-in and the proposal queue (approval
  held and confirmed; decline with a closed reason). For bootstrapped clinics it shows their recorded decisions and a
  suspension with a closed reason and confirmation, and says plainly: "No reinstatement process is defined." A failed
  list is distinct from an empty one. Middleware admits exactly `/operator`, as it does `/courses`.

## 4. Refusal names

**New-clinic route** (`CLINIC_BOOTSTRAP_REFUSALS`):
- `workforce_clinic_bootstrap_not_released`
- `workforce_applicant_refused`
- `workforce_applicant_mfa_required`
- `workforce_applicant_email_unverified`
- `workforce_clinic_bootstrap_conflict`
- `workforce_clinic_bootstrap_exists`
- `workforce_application_already_pending`
- `workforce_application_rate_limited`
- `workforce_application_unavailable`
- `identity_unavailable`
- `request_invalid`
- `application_service_not_configured`
- `reauth_required`
- `identity_refused`

Anything else is `workforce_application_unavailable`.

**Operator routes** (`PLATFORM_OPERATOR_REFUSALS`):
- `platform_operator_not_released`
- `platform_operator_sign_in_not_released`
- `platform_operator_refused`
- `operator_sign_in_required`
- `request_invalid`
- `not_found`
- `conflict`
- `operator_self_approval_refused`
- `platform_operator_unavailable`
- `operator_service_not_configured`
- `identity_refused`
- `platform_operator_rate_limited`

**SQL names** the production data client must classify (§7.1):
- `workforce_clinic_bootstrap_not_released`
- `workforce_bootstrap_assurance_required`
- `workforce_bootstrap_invalid`
- `workforce_bootstrap_conflict`
- `workforce_clinic_bootstrap_exists`
- `workforce_request_pending`
- `workforce_binding_conflict`
- `workforce_operator_refused`
- `workforce_self_approval_refused`
- `workforce_bootstrap_suspension_invalid`
- `workforce_clinic_bootstrap_not_found`

## 5. Evidence: defects, failing-before and coverage

| # | Finding at the base | Repair | Before, then after |
| --- | --- | --- | --- |
| 1 | Two accounts with the same address bootstrapping at once: the loser surfaced PostgreSQL's unique-violation text, unclassified, so it answered 503. The safety property held (one clinic, one binding). | `c7f669a9` catches that one constraint and raises `workforce_binding_conflict` | native F: 2 of its 6 checks fail before; all pass after |
| 2 | Sign-in never said where to go: an account with no clinic, or several, landed on the app with nothing selected and no prompt | `29b714ab` adds the clinic step and `/select-clinic` | at `c7f669a9`: 5 of 6 `clinic-step-journey` cases fail (all on the missing step), and `afterSignInPath` does not exist; all pass after |

**New capability, not repairs.** These tests fail before only because the module did not exist:
- the Desktop new-clinic route (33);
- journey state (7);
- the chooser (3);
- operator console reads (2);
- the operator API (8);
- Desktop operator routes and sign-in (15).

**Coverage**, passing before and after:
- **Second tab:** after a real `/api/auth/org` switch, a write under the old clinic is refused unsent (409, "Your clinic
  changed in another window").
- **Suspended clinic:** it leaves discovery, cannot be chosen, and the next sign-in selects what is left. In the
  database, a suspended bootstrapped clinic leaves its owner's and staff's discovery.
- **Second account:** it never inherits the first account's selection, even with the token swapped under the cookie.
- **Two accounts with the same name:** two separate clinics, each discovering only its own (database; native C).
- **MFA removed after creation:** status and retry are refused by name, and no row is read (applicant API).
- **Applicant and operator in one browser:** each door sends only its own token.
- **Concurrent operator decisions:** two operators suspend the same clinic at once. The second waits on the clinic, then
  gets the first suspension back as a duplicate, and exactly one event is recorded (native **H**).
- The existing cases still pass:
  - lost-reply retry (native A, database, route, browser);
  - two tabs (native B);
  - suspension against an admitted request (native D and E);
  - proposal against bootstrap (native G);
  - another clinic's records (database: admitted to the new clinic only, zero patient rows; first-clinic selection
    refuses a clinic outside discovery; the bootstrap body cannot name a clinic).

**Native two-session qualification** (`scripts/qualify-workforce-bootstrap-native.mjs`): PostgreSQL 16.15, a throwaway
cluster on a private Unix socket. **8 scenarios, 35 checks, all pass.** It is run at the packet head and reported in the
hand-back.

**Local gates on the source tree.** Every one exited 0:
- `tsc --noEmit`, and eslint on every file the branch changed.
- The full unit suite (`TZ=America/Los_Angeles vitest run`): **638 files passed; 9729 tests passed, 11 skipped**.
- Inventory checks:
  - `check:aws-desktop-operation-inventory` (228 operations, all blocked);
  - `check:mock-imports`;
  - `check:aws-identity-consent` and `check:aws-authenticated-api`;
  - `test:e2e-order-config` and `test:lint-root-matcher`.
- Build: a clean `build:clinical`, then `check:clinical-bundle` (351 client chunks, no synthetic identity, none of the
  21 server-only markers).
- `check:stub-reset`: 142 mutable bindings, all covered.
- The onboarding browser suites (`E2E_ONBOARDING=1`, the CI job's posture): `new-clinic-onboarding` and
  `practitioner-onboarding`, **18 passed**.
- `test:e2e:order`, forward and reverse on fresh `next dev` servers: **PASS**. The same 328 tests passed in both orders,
  0 failed, and 121 were skipped by declaration and not counted. There were 0 worker restarts. It was run with
  `E2E_DEV_HEAP_MB=8192`, the most this 16 GiB container allows with the required reserve.

## 6. Status by level

| Item | Implemented | Locally verified | CI verified | Hosted verified | PHI-approved |
| --- | --- | --- | --- | --- | --- |
| Two doors on `/apply`, new-clinic route | yes, blocked | route 33, journey 7, browser | see hand-back | no | no |
| Clinic step, `/select-clinic` | yes (applies only under `database_current`) | journey 6, chooser 3, browser | see hand-back | no | no |
| Bootstrap SQL candidate + rollback | yes, BLOCKED | database 23 cases; native 8 scenarios / 35 checks | see hand-back | no | no |
| Operator listing candidate + rollback | yes, BLOCKED | database (6 of the 23) | see hand-back | no | no |
| Operator API | yes, blocked | 8 with the real authenticator | see hand-back | no | no |
| Desktop operator sign-in, routes, `/operator` | yes, blocked | 15 + browser | see hand-back | no | no |
| Operator pool, client, registry | **not created** | — | — | — | — |

## 7. Ordered source interfaces for Codex to connect or test in AWS (none performed)

1. **Classify the SQL names in §4** in `rds-data-database.ts` (Codex's file, not edited here), as
   `ClinicalCoreDatabaseRejection` with `reason` set. Until then they arrive unclassified and answer 503.
2. **Qualification database only, fictional rows:**
   - apply candidates 1–8, plus the discovery sibling where `database_current` discovery is wanted;
   - record each at the version `apply_migration` stamps;
   - drill the rollbacks in order: the listing first, then the bootstrap.
3. **Native harness:** re-run `scripts/qualify-workforce-bootstrap-native.mjs` against the qualification engine's
   PostgreSQL version. Confirm that RDS Data API transactions hold the setter's, the suspension's and the second
   operator's row locks across statements (D, E, H).
4. **Applicant API:** mount `GET`/`POST /clinical-core/workforce/clinic-bootstrap` on the applicant API behind the
   workforce JWT authorizer, with the bootstrap store on `clinical_workforce_application`. Give the Desktop
   `WORKFORCE_APPLICATIONS_API_ORIGIN`.
5. **Operator identity:**
   - create the operator user pool and client, separate from the workforce and consumer pools: MFA required, TOTP only,
     no federation, no self sign-up, `USER_PASSWORD_AUTH` on that client only;
   - create a scoped `DescribeUserPool` + `AdminGetUser` reader;
   - give the Desktop `PLATFORM_OPERATOR_COGNITO_CLIENT_ID`;
   - register operator subjects only by a reviewed, owner-run change.
6. **Operator API host:**
   - mount the four `/clinical-core/platform-operator/*` routes with `createPlatformOperatorConsoleApi`, the real
     authenticator and a `clinical_workforce_operator` connection;
   - give it an execute-api origin of its own (the Desktop's `PLATFORM_OPERATOR_API_ORIGIN`).
7. **Discovery:** for the clinic step, the identity API's `GET /clinical-core/workforce/memberships/current` must be live
   for the deployment that sets `CLINICAL_WORKFORCE_AUTHORITY_MODE=database_current`.
8. **Only after the reviews in §8,** by reviewed changes, switch on:
   - `DESKTOP_CLINIC_BOOTSTRAP_RELEASE`
   - `WORKFORCE_CLINIC_BOOTSTRAP_RELEASE`
   - `PLATFORM_OPERATOR_SIGN_IN_RELEASE`
   - `PLATFORM_OPERATOR_CONSOLE_RELEASE`
   - `DESKTOP_PLATFORM_OPERATOR_CONSOLE_RELEASE`
   - `WORKFORCE_CLINIC_PROPOSAL_REVIEW_RELEASE`
   - the release row, as its owner
9. **Hosted fictional tests**, each recorded:
   - sign-up, confirmation, MFA, create, first fictional record;
   - a second account trying the new clinic;
   - a lost-reply retry;
   - two tabs;
   - two accounts with one name;
   - an account switch between attempt and retry;
   - MFA removal;
   - a suspension during an open request;
   - a practitioner token at an operator route;
   - an operator signed in longer than 15 minutes;
   - two operators suspending one clinic.

## 8. Questions that are Brandon's (not chosen here)

1. **Before a created clinic holds real data:** what must exist? Agreement/BAA acceptance, identity or licence
   verification, payment? The candidate admits the owner at once once released. Any gate must go into the bootstrap
   transaction before release.
2. **MFA after creation.** The applicant routes re-read the account's MFA on every request. Clinical access through
   current membership does not: it relies on the workforce pool requiring MFA at sign-in, and an existing token or
   refresh session continues until it expires. Should clinical requests re-check current MFA? The hosted pool's MFA
   setting is unobserved.
3. **Suspension reasons, and reinstatement.** Are the four reasons right? No reinstatement is defined, and the console
   says so.
4. **Who creates the operator pool, who registers operators, and who reviews that registry.**
5. **A pending join and a new clinic at once.** The database allows it, and so does the page. Keep it?
6. **A second clinic.** Is a second clinic always through the held proposal? This is the current design.
7. **`/operator` without a practitioner session.** It is reachable signed out, and the page itself holds nothing.
   Confirm.
8. **Clinic names.** They are 3–120 characters and not unique across accounts. Is that acceptable?
9. **Wording.** The fictional-records notice and the not-released texts are drafts for Brandon and counsel. No
   production wording is proposed for a PHI-approved runtime.

**Residual, documented and not fixed:** the submit path locks on the raw subject, while the bootstrap locks on
`lower(subject)`. These are equivalent for Cognito's lowercase subjects, so the mismatch is latent.

## 9. Graphify (append-ready; the shared map was not updated from here)

```
- 2026-10-16 Desktop new-clinic onboarding closure (branch claude/new-clinic-onboarding-closure-20261016, from
  claude/new-clinic-bootstrap-20261016 cacd5d6d; V2 pair unchanged, Desktop c4358a01 in the V2 kit): /apply offers
  "Create a new clinic" (workforce-clinic-bootstrap/1 via blocked /api/onboarding/clinic-bootstrap; request id + name
  only; lost-reply retry by id; named refusals; ready only with database + current-membership sign-in + session) and
  "Request to join an existing clinic" (unchanged, clinic approval); sign-in clinicStep selected/choose/onboard/unknown
  under database_current with /select-clinic; blocked platform operator console (operator listing SQL candidate
  5a7af23d over bootstrap 82efb74c; operator API with the separate MFA authenticator; Desktop operator sign-in on its own
  client, aidp_op scoped to /api/operator, 15 minutes; /operator with closed reasons, recorded decisions, no
  reinstatement). Native two-session qualification 8 scenarios / 35 checks (PostgreSQL 16.15). Every release blocked;
  no pool, operator, SQL apply or PHI. Hosted, Cognito and policy unobserved.
```
