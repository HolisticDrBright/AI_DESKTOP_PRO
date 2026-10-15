# Workforce identity and consent under current database membership — 15 October 2026

Branch `claude/workforce-current-authority-20261015`, from `6a6ad360`. The code is commit `80c807c9`. This is source
and local tests only. Nothing was
deployed, registered or applied, and no AWS, Cognito, PHI or production setting changed. The deployed production
Lambda (`aws-production-clinical-lambda.ts`) still does not set `authorityMode`, so production still runs on the
legacy claim path, unchanged. The SQL setter the new path needs, `workforce-current-membership-context.sql`, is still
**unregistered**.

Owner decision (see `docs/workforce-membership-authority-decision-2026-10-15.md`): one login, then clinic-approved
membership. This change converts one complete high-risk route family to that authority. Every other workforce route
stays refused under the new mode.

## 1. The route family converted

Under `authorityMode: "database_current"`, the production identity API now answers these workforce routes from current
database rows. Before this change the six identity and consent routes answered 503 `membership_authority_not_configured`:

| Route | Operation | SQL authority (unchanged) |
| --- | --- | --- |
| `GET /clinical-core/workforce/posture` | membership read (new: returns `membership: {organizationId, role}`) | the current-membership setter |
| `POST /clinical-core/workforce/invitations` | `issue_connection_invitation` | setter, then `has_clinical_role` (owner/admin/practitioner) |
| `POST /clinical-core/workforce/consents/grant` | `record_consent_grant` | setter, then `has_clinical_role` |
| `POST /clinical-core/workforce/consents/revoke` | `revoke_consent_grant` | setter, then `has_clinical_role` |
| `GET /clinical-core/workforce/consent-artifact` | artifact read | setter, then row-level security (`is_active_member`). This route is outside the production pilot route list, so the pilot still answers 403 |
| `GET /clinical-core/workforce/consents/current` | current consent read | same as above: setter, then RLS; 403 in the pilot |
| `POST /clinical-core/workforce/data-compatibility` | (converted earlier) | setter, then per-function checks |

How a request is decided (`aws-identity-api.ts` `currentWorkforcePrincipal` and `currentMembershipIdentityConsent`;
`aws-identity-consent.ts` `createCurrentMembershipIdentityConsent` / `runCurrent`):

1. **Read from the token, and nothing else:**
   - It must be a workforce ID token from the pinned pool and client.
   - The account must be `173535830222`.
   - The `sub` must be a UUID, and `email_verified` must be true.
   - The token must not carry the synthetic attestation.
   - New: the token's `exp` must still be live.
   - New: there must be exactly one `x-alp-selected-organization-id` header, and it must equal the pilot clinic.
   - `custom:person_id`, `custom:organization_id`, any role or group claim, and any MFA-looking claim are ignored.
2. **One transaction.** It first runs `clinical_private.set_current_workforce_context(sub, selected clinic, purpose)`.
   That reads the identity, person, clinic and membership rows and locks them `FOR SHARE`. It returns the current
   person, clinic and role, and sets the transaction's context. A binding for any other clinic, or one that can't be
   read, is refused.
3. **The operation runs in that same transaction.** It uses the legacy route's own request validation, pilot consent
   scopes and SQL function. The audit actor and `created_by` / `recorded_by` are the person bound to the `sub`, never a
   claimed person. `set_request_context`, which trusts the claimed person and clinic, is never called.
4. **Refusals:**
   - 403 `production_boundary_refused`: no current membership or role.
   - 403 `identity_refused`: a token or clinic selection the handler rejects before the database.
   - 503 `database_unavailable`: an outage, or the setter isn't installed.
   - 503 `membership_authority_not_configured`: every other workforce route.
   - Nothing falls back to claims.

`CURRENT_MEMBERSHIP_WORKFORCE_ROUTES` (exported) is the handler's own list. A test pins it, so a route cannot join the
current authority unnoticed.

The legacy paths are behaviour-preserving. The adapter's SQL moved into shared functions with the same statements,
validation order and error mapping. `check:aws-identity-consent` and the existing identity, consent and production API
suites pass.

## 2. Failing-before and passing-after evidence

`src/server/clinical-core/workforce-current-identity-consent.database.test.ts` runs the real production handler and
adapters, over the assembled production schema plus the unregistered setter, in PGlite with fictional rows.

- **Base `6a6ad360`, with this test copied in:** all 13 tests that existed then fail.
  - Every converted route answered 503 `membership_authority_not_configured`.
  - The route-list tripwire was undefined.
- **After the fix:** 14/14 pass. The 14th, the rollback test, was added with the rollback file.

| Case | Asserted after the change |
| --- | --- |
| Approved one-login practitioner, no clinic claims | Posture, issue, grant and revoke succeed. Rows carry the DB person. Each operation runs one setter call; no `set_request_context`; legacy adapter never called |
| Forged claims (`custom:person_id` and `custom:organization_id` from another clinic, `custom:role=owner`, groups) | Ignored. The grant records the `sub`'s own person. A staff member claiming owner, or a foreign-clinic practitioner claiming this clinic, cannot issue |
| No membership, pending application, suspension, unlinked subject, disabled identity, suspended clinic | 403 before any write; invitation and grant counts unchanged |
| Wrong, missing or ambiguous clinic | Outside the pilot, a missing header, a comma-joined pair, or two differently-cased headers: 403 at the handler with **no database query**. A clinic the person is not in: 403 from current rows |
| Role change | Demoted to staff: posture still works (role `staff`); issue and grant refused. Demoted to `member`: refused entirely. Restored: works on the next request |
| Stale session | Expired or missing `exp`: 403 at the handler. A token signed in 30 days ago is admitted while the membership is current, and refused once it is suspended |
| Duplicate requests | A repeated idempotency key: one invitation. A second grant: 409. A second revoke: 409. Exactly two grant rows |
| Second device | Two sessions for the same subject are each decided per request. One suspension stops both; reactivation restores both |
| Two clinics (adapter level) | Practitioner in A and staff in B: each request selects its clinic; B's staff role cannot issue; A is unaffected |
| Outage | Database unreachable, or the setter missing: 503 `database_unavailable`, legacy never entered |
| Rollback (new file) | Removes only `clinical_private.set_current_workforce_context` and its grant. No other function, policy or row changes. Running it again fails loudly. After it, current-mode requests answer 503 |
| Authorization lost inside the operation | A suspension inside the transaction after binding: the write is refused and rolled back, with no row |
| MFA ambiguity | `amr` / `custom:mfa_verified` admits no applicant or outsider. Their absence refuses no current member |
| Unconverted workforce routes | Lab imports, lab review and patient labs answer 503 `membership_authority_not_configured`; non-pilot routes answer 403 `pilot_scope_refused`. No database query, and no legacy call |

**Gaps on the already-converted Desktop compatibility route.** A probe at the base commit showed that two
differently-cased selected-clinic headers, an expired `exp` and an empty `exp` were each admitted with 200. All three
are now 403. API Gateway's JWT authorizer validates expiry before the Lambda in a deployment, so the expiry check is
defence in depth.

**Two existing tests were updated, not weakened**, in `aws-production-clinical-api.test.ts`:
- The Desktop-compatibility fixture now carries a live `exp`.
- "Refuses other workforce routes rather than falling back to legacy claims" asserted 503 on posture, which is now
  converted. It now asserts the same 503 and no legacy call on the three unconverted pilot routes.

### Two-session lock qualification (real PostgreSQL)

PGlite has one connection, so it cannot race a revocation against an in-flight request.
`npm run qualify:workforce-current-authority-native -- --binary-directory /usr/lib/postgresql/16/bin --run-as postgres`
handles that:
- It starts a throwaway PostgreSQL 16.15 cluster with **no TCP listener** (a private Unix socket only).
- It loads the same schema and candidate, inserts fictional rows and drives two `psql` sessions.
- It removes its directory afterwards.

All checks passed:

- **Admitted first.** A suspension issued while session A holds the binding **waits on the lock**. A's grant commits.
  The suspension then commits, the next request is refused, and there is exactly one grant.
- **Suspended first.** A binding requested while an uncommitted suspension holds the membership row waits. It then
  re-reads the committed row and is refused, and no grant is written.
- **Control.** Under the legacy `set_request_context`, the same suspension commits at once. So the waits above measure
  the candidate's lock order, not the harness.

The run at the code commit `80c807c9`, from a clean source tree, is
`docs/evidence/2026-10-15-workforce-current-authority-native-80c807c9.json`.

This qualifies the **existing, unchanged** candidate's lock order. It is new evidence, not a before/after fix. It ran
on local PostgreSQL 16, not on Aurora through the RDS Data API. Whether Data API transactions hold the same row locks
across statements is a hosted question for Codex (§6).

## 3. Workforce route-to-authority matrix

This is a read-only source survey of the seven API templates under `infra/aws-clinical-core/`. It has **59** `/workforce/`
declarations and 48 unique keys. The count matches `workforce-route-inventory.test.ts`. All are `JWT` routes on a
workforce-pool authorizer; none is IAM, CUSTOM or NONE. I spot-checked the riskiest rows (marked ✓). The rest come
from the survey, which is a starting point, not a certification.

Codes:
- **C**: authority taken from `custom:person_id` / `custom:organization_id` claims.
- **H**: the `sub` plus the selected-clinic header.
- **R**: `set_request_context`, which checks that the identity and person are active, but **not** membership, clinic
  status or locks.
- **HCR**: the function calls `has_clinical_role`.
- **IAM**: RLS calls `is_active_member`.
- **A**: `assert_*_workforce`.
- **S**: the current-membership setter (locks rows `FOR SHARE`, same transaction).
- **G/V**: telehealth's separate HTTP calls to the identity API, outside the write's transaction.

| # | Template | Route (`/clinical-core/workforce/…`) | Authority today | Revocation | Status |
| --- | --- | --- | --- | --- | --- |
| 1–6 | identity (synthetic) | posture, invitations, consents/grant, consents/revoke, consent-artifact, consents/current | C; posture none ✓; writes R+HCR ✓; reads R+IAM | posture: token expiry only; others: next request | synthetic boundary |
| 7–10 | identity | labs/specimen-context, lab-imports, lab-imports/review, patient-labs | C, R+HCR | next request | synthetic |
| 11–14 | identity | messages, programs, calendar-connection, chat | C, R+HCR | next request | synthetic; 403 in production |
| 15 | identity | data-compatibility | C, R + per-function | next request | synthetic |
| 16–27 | identity | consult-links, consult-requests, intake-forms, intake-packets, disputes, content-revisions, note-templates, note-drafting-context, protocol-carts, outcome-ledger, outcome-report, consult-retention | C, R+A | next request | synthetic; 403 in production |
| 28, 30 | catalog | catalog/products, catalog/protocol-templates | synthetic: C (format only); production: H+S | production: in-flight fenced | production fails closed (SQL unregistered) |
| 29 | catalog | catalog/reference | H+S | in-flight fenced | route off by default |
| 31–34 | production candidate | posture, invitations, consents/grant, consents/revoke | legacy: C (+ pilot clinic); posture none ✓. **`database_current`: H+S (this change) ✓** | legacy: next request (posture: expiry). Current: in-flight fenced ✓ | 503 until activated; mode not selected |
| 35 | production candidate | labs/specimen-context | — | — | always 403: not in `PRODUCTION_PILOT_ROUTE_KEYS` ✓ |
| 36–38 | production candidate | lab-imports, lab-imports/review, patient-labs | legacy: C, R+HCR; `database_current`: **refused 503** ✓ | next request | 503 until activated |
| 39 | production candidate | data-compatibility | legacy: C, R + per-function; `database_current`: H+S | current: in-flight fenced | 503 until activated |
| 40 | production disabled | `ANY {proxy+}` | — | — | always 503 |
| 41–42 | qualification | programs (×2) | C + pinned clinic (successor: `auth_time` ≤ 15 min, subject allow-list), R+HCR | next request | BLOCKED, fictional only |
| 43–47 | telehealth | appointments/requests, actions, slots (GET/POST), payments | C (DynamoDB partition is the claimed clinic) + G ✓ | next request, race window | synthetic runtime |
| 48–59 | telehealth | visits, visits/consent, start, end, notes, notes/import, sign, transfer, transfer/complete, inventory, consent-artifact, consent/withdraw | C + V | next request, race window | synthetic; transfer depends on unregistered SQL |

**Workforce-token routes outside the 59:**
- `POST /campaigns/workforce` (`infra/campaigns/campaign-engine.json`) takes the practice and person **only from claims**,
  with no database membership check ✓ (`src/campaigns/http.ts`).
- Script-generated or source-only routes: recording, privacy operations, clinic records, Fullscript draft, and workforce
  applications (blocked).
- `notifications/settings` is in the handler's route table but has no template.

**Highest-risk claim-reliant families still to convert:**
1. **Telehealth (17 routes).** The clinic is the claim and the storage partition, and membership is checked in a separate
   HTTP call.
2. **Production labs (36–38) and the compatibility fallback's per-function checks.**
3. **Recording, clinical operations and programs.** Ownership checks were not fully verified.
4. **Campaigns:** pure claims.

## 4. Before `database_current` can be selected (pre-activation dependencies)

Found and left fail-closed, not fixed here:

1. **The Desktop client sends no selected clinic.** `src/adapters/aws-clinical-data.server.ts` `request()` sends no
   `x-alp-selected-organization-id` header. Under `database_current`, every Desktop data request would be refused with
   403, failing closed. The session already holds the active clinic in `AUTH_COOKIES.org`
   (`src/app/api/auth/org/route.ts`). Plumbing it as the header touches every `clinicalRpc` / `clinicalSelect` caller,
   which is a separate reviewed change.
2. **Telehealth's identity-API calls send no selected clinic** (`aws-telehealth-requests.ts` `identityApi`). Its
   membership guard and consent calls would be refused in the same way.
3. **No configuration selects the mode.** `aws-production-clinical-lambda.ts` never reads an authority mode. Selecting
   it is a reviewed code and configuration change, not an environment flip.
4. **MFA.** The handler does not rely on any token claim to prove that this sign-in completed MFA. It neither infers
   nor requires MFA, and an `amr`-style or custom MFA claim changes nothing. The guarantee must come from the pool's MFA setting
   (§6). The read-only Cognito applicant adapter at `6a6ad360` is unchanged, and a configured MFA method is still not
   proof of a challenge.
5. **`list_my_organizations` lists every clinic the person belongs to**, not only the selected one. It is the person's
   own list, but under the single-clinic pilot it still names the other clinics.

## 5. SQL: no new candidate was needed — the registration packet for the existing one

The family needed no new SQL. The existing unregistered setter and the unchanged clinical functions are enough. For
Codex's later review, not now:

- **Candidate:** `infra/aws-clinical-core/source-candidates/workforce-current-membership-context.sql`, SHA-256
  `dd53a3041fc5a6dc9827e112dfc74a5583768d3ecd4cc65c176f78dbb1d00f06`. It is additive and preserving: one
  `security definer` function with `search_path=''`, and no table, row or policy change.
- **Rollback (new, unregistered):** `infra/aws-clinical-core/source-candidates/workforce-current-membership-context-rollback.sql`,
  SHA-256 `02adfa04eaa0fec9d3f768822e119abc702caf7155de0a7254fd8074b2808d88`. It drops that one function, which
  removes its grant with it. Afterwards `database_current` requests answer 503; there is no fallback.
- **Ownership and lock order:**
  - The function is owned by the migration owner.
  - It reads identity → person → clinic → membership, each `FOR SHARE`, and holds the locks to commit.
  - A revocation, a demotion or an identity, person or clinic disable that holds `FOR UPDATE` on any of those rows must
    wait for admitted operations to finish, or make new bindings wait and then refuse.
  - Revocation writers must not take these locks in another order. A writer that touches two of these rows should
    follow the same order, to avoid deadlocks.
- **Grants:** `EXECUTE` to `clinical_core_api` only. It is revoked from `PUBLIC`, and the test asserts this.
- **Negative-test plan for the hosted run.** Use fictional accounts, repeated against Aurora through the Data API:
  - every case in §2;
  - the two-session races, holding the Data API transaction open across statements;
  - removal, demotion, and identity, person and clinic disable while a write is in flight;
  - two clinics on two devices;
  - database outage and a missing function;
  - a token whose clinic claims disagree with the database.

## 6. Ordered inputs for Codex (AWS and hosted qualification lane)

Nothing below is authorized by this change. Each step needs Brandon's approval and a reviewed change set.

1. Confirm that the production workforce pool `us-east-2_AZMa5gxSZ` requires MFA (`MfaConfiguration=ON`) and which
   methods it allows. The API cannot see this.
2. Confirm that the production clinical API's JWT authorizer validates `iss`, `aud` (client `67moqjql53ms7247tphe5ftpd8`)
   and expiry, and forwards `x-alp-selected-organization-id` to the Lambda unchanged.
3. On a fictional qualification database, register the setter (§5 digest) with its rollback, rehearse both, and record
   the ledger version. The clinical project stays as it is.
4. Run the §5 negative-test plan through the RDS Data API, including the two-session races. Report whether Data API
   transactions hold the `FOR SHARE` locks across statements.
5. Only after Claude lands the client header changes (§4.1, §4.2) and a reviewed mode selector (§4.3): run a hosted
   fictional sign-up → approval → posture → invitation → consent journey under `database_current`. Then remove the
   membership mid-session and observe the 403.

## 7. Decisions still open (Brandon, with counsel where noted)

- **Staff role.** The setter admits `staff`, so posture works for staff, while writes need owner, admin or practitioner.
  Is staff posture intended?
- **Session age.** Should a maximum `auth_time` age apply to clinical routes? The program successor uses 15 minutes;
  the identity family uses none. Current membership is checked on every request either way.
- **Clinic list.** Should `list_my_organizations` return only the selected clinic in the pilot?
- **Next family to convert.** Telehealth is recommended; campaigns' pure-claim route is the simplest.

## Local verification at `80c807c9`

- **Pass:** `npm run typecheck`.
- **Lint:** `npm run lint` exits 0. Its one warning, in the untouched `scripts/build-qualification-program-api.mjs`,
  was already there.
- **`npm run test:unit`:**
  - 604 files, 9,210 tests passed, 11 skipped.
  - The skips are existing conditional ones; none is in a changed file.
  - The run began before the rollback test existed. The changed test file was then re-run alone: 14/14.
- **Pass:**
  - `build:aws-production-clinical-api` and `build:aws-authenticated-api` (the two Lambda bundles that include this
    handler);
  - `check:aws-clinical-core`, `check:aws-authenticated-api`, `check:aws-production-clinical-api` and
    `check:aws-identity-consent`;
  - `test:migration-sql-bytes`.
- **Clinical production build:** `npm run build:clinical` and `check:clinical-bundle`. The return records the result.

## Status

| Item | Implemented | Locally verified | CI verified | Hosted verified | Device verified |
| --- | --- | --- | --- | --- | --- |
| Identity and consent family under current membership | yes | yes (14 PGlite handler cases; base 13/13 fail) | see the return | no | n/a |
| Single clinic header and live `exp` on the current principal | yes | yes (base probe: 200; now 403) | see the return | no | n/a |
| Setter rollback candidate (unregistered) | yes | yes (preservation and fail-closed test) | see the return | no | n/a |
| Two-session lock order of the existing setter | n/a (unchanged SQL) | yes (local PostgreSQL 16, three scenarios) | no (local binaries only) | no (Aurora / Data API) | n/a |
| Route-to-authority matrix | yes (this document) | spot-checked | n/a | no | n/a |
| Desktop and telehealth selected-clinic header | **no** (§4) | — | — | — | — |
