# Clinic continuity negatives and the qualification issuer release map (17 October)

**Status: source only. One new candidate, BLOCKED.** Nothing was applied, registered, deployed or switched on. No AWS,
Cognito or authorizer change was made, and no template's deployed value was edited. Every row in every test is
fictional.

The evidence comes in three classes, never merged:

| Class | What it is |
| --- | --- |
| **PGlite** | In-process PostgreSQL on the real migration chains (106 production migrations; the 116-migration clinic-records artifact). One session. **PGlite is not Aurora**, and it cannot interleave two transactions. |
| **unit** | The campaign engine's fictional test harness and the BLOCKED pre-token trigger, in process. |
| **source** | The release map, checked line by line against the files it cites. |

No native two-session run was made for this package (§4.4 says why), and nothing here is hosted evidence.

## 1. The owner's decisions, kept distinct

1. **Ordinary suspension:** a session already valid at the suspension continues **read-only until its own token
   expires**. A refreshed or new token does not inherit that.
2. **Compromised login:** revoked at once (the emergency revocation).
3. **Consent in a suspended clinic:** new practitioner grants are blocked; **withdrawals remain possible**, and the
   patient's own withdrawal stays open (D2(B), `docs/suspended-clinic-custody-2026-10-16.md`).
4. **Authorized retention cleanup continues.**

Not inferred from these: clinic amendment, guardian access, reactivation. D3 (recording cleanup), D4 (legal holds) and
D5 (patient copies) stay the owner's; this package pins what the source does and lists the alternatives.

**The stack tested.** "The full chain" below is the one stack where all four decisions are represented at once:

- the emergency revocation, over its parents;
- the ordinary-suspension window;
- the consent-decision candidate;
- the grant-paths successor.

All are BLOCKED; none is applied anywhere.

## 2. Per-path classification

Labels: **COVERAGE** (the invariant holds; the test that shows it), **GAP** (a demonstrable source gap with a decided
contract: failing before, BLOCKED successor), **OPEN** (a demonstrable gap whose contract is not decided: `it.fails`),
**HELD** (current behaviour pinned for an owner decision).

| Path | SQL and route traced | Label | Evidence |
| --- | --- | --- | --- |
| Recording consent **withdrawal** in a suspended clinic, under the window | `clinical_private.withdraw_encounter_recording_consent` (`20260917070000`), a `clinical_data` write through `lock_recording_encounter` → `require_clinical_patient`; the recording family's callers | **OPEN (R1)** | Without the window it lands (control). With the full chain every entry refuses it: seven arguments `request_context_refused`; ten with a pre-suspension write `ordinary_suspension_write_held`; ten declared as a read fails as a read-only transaction; `consent_management` `production_context_refused`. It is the **only** API-callable writer of `recording_consent_withdrawals` (pinned against the schema), so nobody can withdraw a recording consent there. |
| Recording **cleanup** after withdrawal | `recording_cleanup_operator` (`20260917150000:131-151`) requires `o.status='active'`; cleanup intents are enqueued by the withdrawal (`20260917140000:82,99`) | **HELD (D3)** | The assigned operator's work list is refused (`recording_cleanup_operator_required`) in a suspended and an archived clinic, on the full chain. Nothing is deleted. |
| **Legal holds** | `place_recording_legal_hold` / `release_recording_legal_hold` (`20260917150000:153-180`), both through `recording_cleanup_operator` | **HELD (D4)** | Placing and releasing are both refused while suspended. A hold placed before the suspension survives it, unreleased. No practitioner has a hold path. |
| **Patient copies** of clinic-held records | the 116-migration clinic-records candidate: every action calls the deployed `care_connection_actor` (`20261006020000:60-78`), which requires `organizations.status='active'` | **HELD (D5)**, now executed (it was "read in source, not executed") | In a suspended or archived clinic the patient can neither ask for a copy nor read, `get` or list one **already delivered**. No member can list or begin a pending request. Delivered copies and items are kept. |
| The **patient's own** consent withdrawal through the care-connections route | `clinical_core.production_care_connection_request` (`20261006020000:127-259`), actions `consent` and `withdraw`, via `care_connection_actor` | **GAP → BLOCKED successor** | Failing before: 4 of 4 failed (deployed schema and full chain, suspended and archived), `care_connection_refused`. The route's own contract keeps "status and withdrawal" for an archived chart (pinned), and the identity API's consumer `revoke_consent_grant` already withdraws in a suspended clinic (pinned). §4 has the successor. |
| **Refreshed tokens**, `clinical_data` / `identity_link` | the window's `admit_request_context` | **COVERAGE** | A refreshed token is refused; the pre-suspension token reads, read-only; a sibling clinic is not held back. |
| **Refreshed tokens**, `consent_management` | not windowed by design (`docs/ordinary-suspension-window-2026-10-17.md` §2) | **HELD (R2)** | A refreshed token still reads the clinic's current consent state (the SQL of `GET /clinical-core/workforce/consents/current`) and withdraws. New grants are refused with or without evidence. |
| Refreshed tokens, **database observation** | row security on `patient_records`, `patient_connections`, `consent_grants` | pinned | The policies gate on the clinic claim and `is_active_member`, not purpose, clinic status or token time. Under `consent_management` a refreshed token's transaction could select the patient row; only the service's SQL choice per route prevents it (the same trust the seven values already need). |
| **Retention cleanup** | `list_privacy_export_cleanup_for_retention` under workforce `consent_management` | **COVERAGE** | Runs in a suspended and an archived clinic on the full chain; refused once its release is revoked or its identity disabled. |
| **Compromised login** inside the window | emergency revocation's identity lock | **COVERAGE** | Refused at once for reads, the current-consent read and withdrawal; a colleague is not. |
| **Campaign staff**, compromised login | `src/campaigns/http.ts:64-71`: the staff route reads the revocation signal | **COVERAGE** | Refused (403) whatever the token's `iat`; a broadcast it scheduled is held. Cites `docs/campaign-staff-revocation-2026-10-17.md`. |
| **Campaign staff**, ordinary suspension | the staff route reads `custom:organization_id`, `exp`, the signal and its own roles: never clinic status or `iat` | **HELD (R4)** | A pre-suspension token and a post-suspension refresh both write (export, edit, approve, grant a role), and a broadcast scheduled before the suspension sends after it. The BLOCKED pre-token trigger mints no clinic claim on a refresh in a suspended clinic, and the route then refuses that token (403). It is the one source lever for refreshes, and it is not deployed. |

## 3. Owner decisions, with exact alternatives

**R1. Recording-consent withdrawal in a suspended clinic once the window is applied.** Today, under the BLOCKED chain,
it is impossible by any path. That contradicts "withdrawals remain possible". It was not built, because both repairs
decide something already held:

- whether a write may pass the window (`docs/withdrawal-only-whole-route-2026-10-17.md` §5.1);
- whether practitioner withdrawals are time-bounded (`docs/ordinary-suspension-window-2026-10-17.md` §7.2).

> (A) **Window-bounded withdrawal.** A window successor admits exactly `withdraw_encounter_recording_consent`, for an
> active clinical member, with a token issued before the suspension and unexpired. A refreshed token is refused. This
> is the intersection of the two owner rules.
> (B) **Consent-management parity.** The recording withdrawal moves to `consent_management` with D2(B)'s actor check,
> like `revoke_consent_grant`. A refreshed token of an active clinical member can withdraw.
> (C) **Accept** that recording consents cannot be withdrawn in a suspended clinic under the window. This contradicts
> the stated rule and would need to be said explicitly.

The test is `it.fails` (`clinic-continuity-negatives.database.test.ts`). It turns the suite red the moment a successor
makes it pass, so the label cannot go stale.

**R2. `consent_management` for a refreshed token.** It reads every patient's consent state in the clinic by id, and
withdraws.

> (A) Bound workforce `consent_management` in a suspended clinic by the window's evidence rule, for reads and
>     withdrawals alike.
> (B) Leave it unbounded (the candidate as written).
> (C) Bound the reads only, and keep the withdrawal write open. The service would have to send evidence on consent
>     reads, and the entry would have to tell the two apart.

The retention sweep, privacy operators and recording cleanup share this purpose. Any option must keep them, by actor,
not by purpose.

**R3. The sync-screen withdrawal** under the window. It is already held (`docs/withdrawal-only-whole-route-2026-10-17.md`
§5.1). Unlike R1, it has a working alternative path (`revoke_consent_grant`).

**R4. Campaigns and an ordinary clinical suspension.**

> (A) Campaigns are unaffected: marketing is commercial data, separate by rule.
> (B) The window's rule reaches campaigns: read-only until the token's own expiry, refreshes refused, queued sends
>     held. This needs a suspension signal with the recorded transition time (like the revocation signal) and an `iat`
>     comparison in the staff route.
> (C) Staff access ends at the suspension, and sends pause.

The BLOCKED pre-token trigger covers refreshes for all three once it is configured. It does not make the pre-suspension
token read-only.

**D3, D4 and D5 stay open.** New fact for D5: a copy **already delivered** to the patient becomes unreadable while the
clinic is closed, because `care_connection_actor` gates `read_copy` too. The alternatives:

> (A) Keep refusing.
> (B) Let the owner read a delivered copy by its immutable owner binding, the way a paused or revoked link already
>     can, without clinic status.
> (C) Route copies through the custodial path of `docs/suspended-clinic-custody-2026-10-16.md` §6.3.

## 4. The BLOCKED successor: the patient's own withdrawal

`infra/aws-clinical-core/source-candidates/care-connections-patient-withdrawal-clinic-status.sql` and its preserving
rollback.

### 4.1 Why the contract is decided

- The owner: the patient's own withdrawal stays open (D2, both alternatives; D2(B) selected).
- The route's reviewed contract: "New grants refuse paused/revoked links, archived charts and account-deletion fences;
  status and withdrawal remain available" (`docs/care-connections-source-candidate.md`). The deployed SQL keeps that
  for an archived chart (pinned). It does not keep it for a closed clinic.

### 4.2 The change, and nothing more

For the consumer actions `consent` (own status) and `withdraw`, the actor is resolved with every identity check of
`care_connection_actor` except its clinic-status clause. Those checks are:

- the consumer pool and the `consent_management` purpose;
- the production environment and classification;
- an active, production-bound identity with this subject;
- an active person;
- an existing clinic.

Unchanged:

- `grant`, `claim`, `connection` and the workforce `issue`: a closed clinic still gets no new link, no new grant and no
  connection lookup;
- `care_connection_actor` itself (prosrc `9948892b…`), so the clinic-records dispatcher (D5) and invitation issuance
  keep refusing;
- signature, owner, `SECURITY DEFINER`, `search_path`, volatility and grants.

No lock is added. The check is inlined in the function body, not added as a helper, so the deployed service's
seven-function digest binding still covers the whole change.

### 4.3 The release unit

`care-connections-database-binding.ts` binds every body by digest. Bound to the deployed digests, the service refuses
every action (`service_unavailable`) once the successor is applied: it never runs a body it was not built for (tested).
Bound to the successor's digest `f1658585…`, it serves the patient's status and withdrawal in a suspended clinic (tested
through `createProductionCareConnections`). The successor ships only with a reviewed care-connections deployment that
carries that digest.

### 4.4 Evidence

| Kind | Result |
| --- | --- |
| Failing before (PGlite) | 4 failed, 0 passed (`…/scratchpad/agents/wp5-care-connections-failing-before.log`) |
| After (PGlite, `care-connections-patient-withdrawal.database.test.ts`) | 22/22 |

The 22 cases:

- the deployed gap pinned: the closed clinic refuses; the archived chart keeps status and withdrawal; the identity API
  route withdraws;
- the successor on the deployed schema and on the full chain:
  - status and withdrawal in a suspended and an archived clinic, with a receipt on retry and a conflict on a stale
    version;
  - no grant, link or lookup;
  - only the owner: another patient's connection, a disabled account and the wrong purpose are refused;
  - an active clinic unchanged;
  - `care_connection_actor` unchanged and private;
  - under the full chain the practitioner still cannot grant;
- the release unit, both bindings;
- pins;
- applies once; refuses a drifted parent, a drifted `care_connection_actor` and the synthetic schema;
- the rollback: byte for byte, rows kept, refuses twice, reapplies.

No native two-session run was made: the successor adds no lock and stops reading the clinic row for these two actions.
Two-session behaviour on Aurora is unobserved.

### 4.5 Identities

| Artifact | SHA-256 |
| --- | --- |
| `care-connections-patient-withdrawal-clinic-status.sql` | `0b5a6fc9cd75a8a4e3fe9e80f341c32db4c6f86b48ae6acb2987b63591540011` |
| `care-connections-patient-withdrawal-clinic-status-rollback.sql` | `28e78b681fd8d53032ce26e6ef6755fcbdddf851ae1677f79390bd155417cb89` |
| Parent `production_care_connection_request` prosrc (`20261006020000`) | `1a0712788bb5ad19b098bb288eb11df9fcfa9833ba4f1cda808b1585e92366ea` |
| Successor `production_care_connection_request` prosrc | `f1658585b2b3c66c4ba959c9aeff8242042be6159d30bf6202793c7b982a4b95` |
| `care_connection_actor` prosrc (required, unchanged) | `9948892ba79f9848ef66cf9e1cc403a38f55b8735f58b3535c760dfb2c6aed93` |

**Ordering.** Nothing else redefines either function, so it sits beside the workforce chain in any order. Roll it back
on its own.

## 5. The qualification issuer release map

`src/server/clinical-core/qualification-issuer-release-map.ts` (`qualification-issuer-release-map/1`), with its test.

**What the test checks against the source:**

- every cited `file:line` holds the cited text;
- the three program-API authorizer templates resolve `WorkforceJwtAuthorizer.JwtConfiguration.Issuer` from the pinned
  `WorkforceUserPoolId`;
- the telehealth and inventory constants match the map;
- **every Cognito pool id in tracked non-test source** is mapped, so a new pin anywhere fails until it is placed.

### 5.1 The pools

| Pool | Role | Plane | Client | MFA | Evidence |
| --- | --- | --- | --- | --- | --- |
| `us-east-2_AZMa5gxSZ` | workforce | production | `67moqjql53ms7247tphe5ftpd8` | unverified here | not part of qualification |
| `us-east-2_ueGlFRbNB` | workforce | shared synthetic staging | `4s7jgr4o8sqdq7cvo9gmq96e2h` | **OPTIONAL** | `docs/inventory-qualification-fleet.md:202` (read-only diagnostic, 2026-10-09; reported, not observed by me) |
| `us-east-2_nYngyyYGE` | consumer | shared synthetic staging | `72aksm2dm4nf03l8d9nrp2dbh0` | OPTIONAL | same |
| `us-east-2_zGOVBoeGT` | workforce | isolated qualification fixture | `1ffcdpnh0k45b3gc2hm9938ebl` | **ON** | `scripts/build-inventory-qualification-identities.mjs:27`; required by `telehealth-qualification-preflight.mjs:62` |
| `us-east-2_G2Hvf9wzJ` | consumer | isolated qualification fixture | `18q2q70rlsv8ti37knolpq7qsu` | OPTIONAL | same template |

**The older MFA-optional fictional workforce issuer** is `us-east-2_ueGlFRbNB`. The program-API authorizers on the
qualification API `6zt8e9qz04` still name it, while the telehealth candidate and the inventory fixtures on the same API
expect `us-east-2_zGOVBoeGT`.

### 5.2 Runners and authorizers

Each issuer is `https://cognito-idp.us-east-2.amazonaws.com/<pool>`.

| Entry | API | Workforce issuer, and where | MFA read? | Token times | Stack values read |
| --- | --- | --- | --- | --- | --- |
| `program-api/candidate`, `/successor`, `/restricted-credential` (templates) | `6zt8e9qz04` | `ueGlFRbNB`: `qualification-program-api-candidate.json:33`, `-successor.json:37`, `-restricted-credential.json:38`; builder `build-qualification-program-api.mjs:21` | no | `recordingWorkforceIdentity`: `exp > now`, `iat < exp`, `iat ≤ now+60 s`, `auth_time ≤ iat`, sign-in within 15 min (`recording-authority-api.ts:85-88`). Consumer: `ownedConsumerIdentity` (`owned-consumer-api.ts:201-203`) | declared Outputs `FunctionArn`, `QualificationExecution`, `PhiAllowed` |
| `program-api/preflight` | `6zt8e9qz04` | the template's pool (`preflight-qualification-program-api.mjs:52`), authorizer issuer compared (`:58`) | no | none (runs no request) | foundation Outputs `ApiId`, `DatabaseName`, `PhiAllowed`, `Activation`, `QualificationExecution`, `DataClassification`, `CodeBucket`, `AlarmTopicArn`, `DatabaseClusterArn`, `LogsKmsKeyArn`; billing Parameters `ConsumerPoolId`, `ConsumerClientId`, Outputs `Activation`, `ApiOrigin` |
| `program-api/update-preflight` | `6zt8e9qz04` | the template's pool (`preflight-qualification-program-api-update.mjs:52`), per-route authorizer (`:83`) | no | none | stack Parameters (pools, clients, `SourceCommit`, `QualificationIdentitySubjects`, …), Outputs `FunctionArn`, `PhiAllowed`, `QualificationExecution` |
| `telehealth/qualification-template` and its preflight | target | `zGOVBoeGT` (`telehealth-qualification-template.mjs:13-14`) | **yes**, `ON` (`telehealth-qualification-preflight.mjs:62`) | legacy claims path: `iss`, `aud`, `token_use` only, so `exp` is the authorizer's (`aws-telehealth-requests.ts:2857`); `database_current` adds `exp > now` (`:2876`) | foundation Outputs (`telehealth-qualification-preflight.mjs:50-55`) |
| `inventory/fixture-identities` | target | `zGOVBoeGT` (`inventory-qualification-fixtures.ts:11-12`) | **yes** (`inventory-qualification-identity-dependency.ts:105`) | `iat` and `auth_time` within `[now−120 s, now+30 s]`, `exp − iat ≤ 900 s` (`inventory-fixture-token.ts:47-51`) | candidate Parameters incl. `WorkforceIssuer` (`inventory-qualification-target.ts:129`) |
| `clinic-records/runner` | target | per-run binding, compared with the authorizer (`clinic-records-qualification-target.mjs:141`) | review hash only (`WorkforceMfaReviewSha256`, `:43`) | tokens classified by `auth_time`: fresh ≤ 4 min, aged, stale > 15 min (`clinic-records-qualification-runner.mjs:65-71,88`) | foundation Parameters and Outputs, candidate Parameters, Lambda env `SOURCE_COMMIT` (`:82-83`) |
| `care/observer` (messaging, connections) | target | per-run binding, compared with the authorizer (`care-messaging-qualification-observer.mjs:233`) | no | inspector only | Outputs incl. `SourceCommit`, `QualificationExecution` (`:183-185`), Parameters exact |
| `shared-manifest/candidate-stacks` (recording, privacy, storage, lab, voice) | target | stack parameter `WorkforceIssuer` (`build-aws-recording-authority.mjs:96`), **never compared** | no | recording family: 15-min `auth_time` | `SourceCommit` only (`qualification-target-manifest.ts:215,222`) |
| `fullscript/qualification` | target | per-run target, compared with the authorizer (`qualification-deployment-execution.ts:109`) | **yes**, `ON` (`qualification-deployment-resources.ts:75`) | sign-in after observed changes | live, per request |
| `token-binding/pre-token-trigger` (BLOCKED) | none | `ueGlFRbNB` (`aws-workforce-token-binding.ts:15-16`) | cannot see MFA | rechecks on `TokenGeneration_RefreshTokens` (`:28`) | none |
| `workforce-applications/api` | none | `ueGlFRbNB` (`aws-workforce-applications-api.ts:16`, `aws-workforce-applicant-identity.ts:7`) | no (applicant plane) | `iss`, `aud`, `token_use` | none |
| `synthetic-care/release` | `wxv734oi12` | `ueGlFRbNB` (`synthetic-care-release.mjs:16`) | no | synthetic attestation | staging stack (not qualification) |
| `production/clinical-api` | production | `AZMa5gxSZ` (`aws-production-clinical-api.ts:38`, `aws-identity-api.ts:298`) | no | `iat`/`exp` for the BLOCKED window, lifetime 300 s to 1 day (`ordinary-suspension-window.ts:40`) | none |

### 5.3 The rule

`assertQualificationIssuerPlan` takes a plan:

- the API;
- the runner entries;
- per-run bindings;
- observed authorizers.

It returns the one workforce pool, issuer and audience, or refuses:

| Refusal | When |
| --- | --- |
| `mixed_workforce_issuer` | two entries expect different workforce pools |
| `authorizer_issuer_mismatch` | an observed authorizer's issuer or audience differs from its runner's |
| `authorizer_unobserved` | a runner never compares the issuer and no observation is supplied: unknown is not "the same" |
| `workforce_issuer_unbound` | an entry's issuer is not given at all |
| `issuer_unknown` | the pool, region or client is not known |
| `issuer_not_workforce_pool` | a consumer pool in the workforce slot |
| `production_issuer_refused` | the production pool |
| `workforce_mfa_not_required` | the plan's single workforce pool has optional MFA (the fleet requirement, `docs/inventory-qualification-fleet.md:202`) |
| `api_mismatch` | an entry belongs to another API |
| `release_map_entry_unknown` | an entry the map does not hold |

**Evidence:** `qualification-issuer-release-map.test.ts` 11/11. The source as pinned today is refused as
`mixed_workforce_issuer`. The program API alone is refused as `workforce_mfa_not_required`. The isolated fixtures alone
are admitted.

## 6. Hosted holds (file:line)

1. **Program-API authorizers name the older MFA-optional issuer:**
   - `infra/aws-clinical-core/qualification-program-api-candidate.json:33`;
   - `infra/aws-clinical-core/qualification-program-api-successor.json:37`;
   - `infra/aws-clinical-core/qualification-program-api-restricted-credential.json:38`;
   - the builder `scripts/build-qualification-program-api.mjs:21`;
   - the preflights `scripts/preflight-qualification-program-api.mjs:52` and
     `scripts/preflight-qualification-program-api-update.mjs:52`.
2. **One qualification target cannot serve both families.** The telehealth template requires the target manifest's
   subjects to be its `zGOVBoeGT` subjects (`scripts/telehealth-qualification-template.mjs:18-22,45-46`). The program
   API's update preflight requires its own designated subjects (`scripts/preflight-qualification-program-api-update.mjs:24-28`).
   Subjects are pool-local, so this is the mixed issuer again.
3. **Shared-manifest candidate stacks:** the deployed `WorkforceIssuer` is unobserved
   (`scripts/build-aws-recording-authority.mjs:96`; `src/server/clinical-core/qualification-target-manifest.ts:215,222`).
4. **The pre-token trigger** accepts only `ueGlFRbNB` for qualification (`src/server/clinical-core/aws-workforce-token-binding.ts:15-16`).
5. **Applicant API** pinned to `ueGlFRbNB` (`src/server/clinical-core/aws-workforce-applications-api.ts:16`).

None was changed here.

## 7. Ordered Codex steps (not run)

1. Review the BLOCKED successor (§4). Confirm the parent prosrc `1a071278…` on the target ledger and both file hashes.
2. On **isolated fictional qualification Aurora** only:
   - apply the successor;
   - repeat the 22 PGlite cases' fictional journeys;
   - run two sessions: a withdrawal racing a suspension, in both orders, expecting the withdrawal to land in both;
   - roll back, and confirm the parent byte for byte and every consent row kept.
3. Build a care-connections deployment carrying the successor's digest `f1658585…`. Confirm with a fictional patient in
   a suspended fictional clinic:
   - status and withdrawal answer 200;
   - grant, claim and connection answer 403;
   - the old deployment answers 503, never a silent success.
4. Choose **one** workforce issuer for the qualification API `6zt8e9qz04`, and run `assertQualificationIssuerPlan` over
   the runners the run will use:
   - with the observed `JwtConfiguration` of every authorizer it touches;
   - for the shared-manifest stacks, by reading their authorizers;
   - record the refusal if it refuses: do not edit a binding to pass.
5. Read `ueGlFRbNB`'s `MfaConfiguration` yourself. The OPTIONAL value is reported from 2026-10-09, not observed in this
   session.
6. If the program API is to move to `zGOVBoeGT`: change the three templates, the builder, both preflights and the
   designated subjects as one reviewed source change, with new fictional subjects in that pool. Never by editing a
   deployed parameter.
7. Bring R1, R2 and R4, and D3 to D5, to Brandon with the alternatives in §3. Nothing here activates the window, the
   consent candidates or campaigns.

## 8. Files

**New in this package:**

- `infra/aws-clinical-core/source-candidates/care-connections-patient-withdrawal-clinic-status.sql` and its `-rollback.sql`;
- the tests (all fictional):
  - `src/server/clinical-core/care-connections-patient-withdrawal.database.test.ts` (22);
  - `src/server/clinical-core/clinic-continuity-negatives.database.test.ts` (11, plus 1 `it.fails`; its failing-before
    first pass was 1 failed, 11 passed);
  - `src/server/clinical-core/clinic-records-closed-clinic.database.test.ts` (4);
  - `src/integration/campaign-ordinary-suspension.test.ts` (4);
  - `src/server/clinical-core/qualification-issuer-release-map.test.ts` (11);
- the release map module, `src/server/clinical-core/qualification-issuer-release-map.ts`;
- this document.

**Not edited:**

- `src/campaigns/*` and `staff-revocation-signal*`;
- Fullscript and V2;
- any existing candidate, template, authorizer or Cognito value.
