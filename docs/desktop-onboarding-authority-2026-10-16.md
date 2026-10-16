# Desktop onboarding authority across the actual routes — 16 October 2026

Source only. Nothing here changes AWS, Cognito or SQL; the new-clinic bootstrap, `/apply`, `/select-clinic` and the
operator console stay exactly as blocked as they were at `15339f18`.

The question: once the two-door onboarding lets anyone create an account, does every route family refuse — in
**that operation's own authority check** — an unapproved self-signed-up account, a suspended clinic, a removed
membership and an already-issued (stale) token? The answer is now a checked inventory rather than a sentence.

## 1. The checked inventory

`src/server/route-authority-inventory.ts` assigns every one of the 262 `src/app/api/**/route.ts` files to one of 19
authority families, and states for each family, under **both** authorities, what happens in each of the four cases.
Counts are as of the next source pass (§6); the overnight counts were 49 / 36 / 1 / 12 / 20 / 26 over 18 families.

| Result | Meaning | Cells |
| --- | --- | --- |
| `refused` | the operation's own check refuses; a named test shows it | 57 |
| `refused_disabled` | refused before any request in that mode (family unconverted or release blocked); a named test shows it | 48 |
| `gap` | admitted when it should not be; a named test pins it, and a decision owner is named | 4 |
| `token_lifetime` | admitted until the already-issued token expires, because nothing re-reads current rows | 18 |
| `not_applicable` | the case cannot arise (public page, consumer session, applicant door) | 20 |
| `unverified` | no source test was found either way; the reason says what would settle it. **Never counted as a pass.** | 5 |

`route-authority-inventory.test.ts` (157 cases) walks `src/app/api`. It fails on:

- a route without a family, a listed route that no longer exists, or a prefix that matches nothing;
- a refusal or gap that cites no evidence;
- evidence whose test file is missing or does not contain the cited `it()` title;
- any change to the gap list, the unverified list or the per-result counts.

The route families the review asked for, and where their authority actually lives:

| Asked for | Family | Legacy (deployed default) | `database_current` (not activated) |
| --- | --- | --- | --- |
| Compatibility fallback / charts / billing | `compatibility_rpc` (data-compatibility RPCs) | claims choose the clinic; SQL re-reads membership: unapproved and removed refused, **suspended clinic admitted (gap)** | setter binds current rows: all four refused |
| Identity / consent | `synthetic_identity_boundary`, plus the converted identity routes behind `compatibility_rpc` | invitations re-read the membership (removed refused); **suspended clinic still issues (gap)**; posture answers from the token until it expires | refused (unconverted) |
| Messages | `care_messages` | unapproved, removed and suspended refused, sibling clinic refused | all four refused |
| Programs | `program_assignments` | refused (gated off) | all four refused |
| Export / corrections | `unconverted_claims_families` (privacy operations) | decided by the operator assignment, not membership; recording refuses a removed member; **suspended clinic admitted (gap)**; removal not pinned in every subfamily (unverified) | refused (unconverted) |
| Provider visits | `telehealth_visits`, `telehealth_calendar` | calendar: membership re-read on every request (all four refused); visits: **suspended clinic admitted (gap)** | all four refused |
| Lab upload / original document | `transitional_lab_documents` | the transitional host decides by token alone; **all four unverified** (host outside this repository) | refused before the token leaves (repaired, §6) |
| Payment / provider | `fullscript_connection`, `telehealth_calendar` (payments) | Fullscript re-reads the account's clinics each request and binds the token's email (all four refused); payments re-read membership | all four refused |
| Sign-in / clinic choice | `sign_in_and_clinic_choice` | an account with no clinic gets none; a suspended clinic is not offered | discovery from current rows; outage selects nothing |

## 2. Defect repaired: a configured clinic for a session that chose none

`resolveOrgId` (`src/adapters/config.ts`, 170 call sites) fell back to `CLINICAL_ORG_ID` / `NEXT_PUBLIC_DEV_ORG_ID`
whenever a session had no selected clinic, **in any runtime**. Only a comment said not to set it in a deployment;
`src/server/commerce/workforce-identity.ts` even documented it as "admitted only inside the contract-fixture
boundary", which the code did not do. So an unapproved account, or a session whose selection was cleared after a
failed membership read, could be handed a clinic by configuration — exactly "a failure chooses a clinic".

- **Failing before:** `src/adapters/config.org-fallback.test.ts` — 4 failed / 3 passed (no fixture; NEXT_PUBLIC
  variant; fixture flag in a deployed runtime; fixture flag against a hosted backend).
- **Repair:** the env clinic is admitted only when `isContractFixtureAllowed()` holds — the same boundary the env demo
  credentials already used (`session.server.ts`). A session's own selection always wins. The one mock adapter that
  imported `config.ts` for `USE_LIVE_API` now imports it from `mode.ts`, so `config.ts` stays server-only.
- **After:** 7/7, and the commerce identity test now states the boundary it relies on. The order battery and the CI
  fixture jobs run inside the boundary (`CLINICAL_CONTRACT_FIXTURE=1`, loopback backend, non-deployed), so they keep
  their clinic.

## 3. Gap found, not closed: a suspended clinic under legacy claims

`src/server/clinical-core/legacy-claims-clinic-status.database.test.ts` runs the real 106-migration schema as
`clinical_core_api` after `set_request_context`, exactly as the legacy path does:

- an unapproved account (identity, no membership) is refused; a suspended membership is refused on the next
  request whatever the old token claims;
- **a suspended or archived clinic**: `list_my_organizations` hides it, so sign-in will not select it, but a session
  that already selected it keeps writing — `create_patient_profile` succeeds.

The mechanism: `clinical_private.assert_production_context` (64 call sites) compares the claimed clinic with the
argument, and `has_clinical_role` / `is_active_member` read only the membership row. Nothing on the legacy path reads
`clinical_core.organizations.status` except care messaging and the clinic list. Under `database_current` the
current-membership setter does read it.

Closing it is one SQL successor that changes every legacy family at once (for example, `has_clinical_role` and
`is_active_member` requiring `organizations.status = 'active'`), and it collides with obligations a suspended clinic
may still owe (privacy copies, retention). That is a decision, not a test to flip:

- **Option A** — a BLOCKED successor gating the legacy role checks on clinic status, with a preserving rollback and a
  review of which families a suspended clinic must keep (privacy fulfilment).
- **Option B** — keep legacy as is and require `database_current` (already refuses suspended clinics) before any clinic
  can be suspended in a deployment that serves real clinics.

The test pins the gap so whoever closes it updates the test and the inventory together.

## 4. What stays as it was

- Bootstrap BLOCKED (`DESKTOP_CLINIC_BOOTSTRAP_RELEASE`); operator console BLOCKED; the operator cookie scoped to
  `/api/operator`; TOTP and fresh sign-in fail closed (`platform-operator-routes.test.ts`).
- Join-existing approval only; no auto-join. No production fallback reads Cognito custom claims on the Desktop: the
  only claim it decodes is `sub`, to bind the selection to the account (`selected-clinic.server.ts`); program media
  compares claims to a designated subject, which narrows, never widens.
- The owner's preference for real-patient records immediately after creating a clinic is not permission: PHI,
  provider, HIPAA, retention and security reviews come first.

## 5. Unverified cells worth closing next (source)

Superseded by §6: of the 26, 21 now carry path-specific evidence and 5 remain, each with what would settle it.

## 6. Next source pass (`claude/desktop-next-source-20261016`)

Every cell below was settled by a test of **that path**, not by a source scan or a neighbouring route.

| Cells | Now | Evidence |
| --- | --- | --- |
| Fullscript ×8 | refused | `src/app/api/live/fullscript/clinic-authority.test.ts`: each route re-reads the account's clinics, binds the token's email, and the OAuth callback completes only in the starter's session (15 cases; 12 failed before) |
| care messages, legacy suspended and removed | refused | `care-messaging-restricted-credential.database.test.ts`, sibling-clinic case |
| telehealth visits, legacy suspended | **gap** | the calendar the visit routes authorize from still answers in a suspended clinic; closed by the successor |
| transitional scribe ×8 | refused_disabled | `src/server/legacy-backend-routes.test.ts`: every entry point refuses on a deployment and with an AWS recording origin, before any request |
| lab documents, `database_current` ×4 | refused_disabled (**repaired**) | same file: the token reached the transitional host; failing before 1 failed / 5 passed |
| lab documents, legacy ×4 | **unverified** | the transitional host decides by token alone and lives outside this repository; the Desktop sends no clinic (pinned). The unapproved-account cell moved from `refused` to `unverified`: its cited test exercises `resolveOrgId`, which these routes never call |
| governed catalog ×5 | token_lifetime | `governed-catalog-authority.database.test.ts`: the synthetic host has no clinic or membership table and admits until expiry; the production host refuses suspended, archived, removed and foreign on the next read |
| unconverted families, legacy suspended | **gap** | `unconverted-families-clinic-status.database.test.ts`: encounter recording still writes in a suspended clinic, refused by the successor; privacy operations follow the assignment |
| unconverted families, legacy removed | **unverified** | pinned refused for recording participants, recording cleanup, lab attestation review and clinic records; privacy operations follow the assignment; the reason names the subfamilies still unpinned |
| synthetic boundary, legacy suspended | **gap** | `synthetic-identity-boundary-authority.database.test.ts`: invitations still issue in a suspended synthetic clinic; the production successor does not reach that schema |
| synthetic boundary, legacy removed | token_lifetime | the same file: invitations refuse a removed member; posture answers from the token alone |

The suspended-clinic decision (§3) now has a BLOCKED successor:
`infra/aws-clinical-core/source-candidates/legacy-claims-clinic-status.sql`. It refuses every workforce `clinical_data`
and `identity_link` request into a clinic that is not active, inside the operation's transaction (`FOR SHARE` on the
clinic row), and leaves consent management, consumer requests and the operator-assigned privacy and cleanup paths
running. Applying it closes the compatibility, telehealth-visit and recording gaps. It does not reach the synthetic
schema. Whether to apply it, or to require `database_current` first, stays Brandon's decision with Codex.
