# Desktop onboarding authority across the actual routes — 16 October 2026

Source only. Nothing here changes AWS, Cognito or SQL; the new-clinic bootstrap, `/apply`, `/select-clinic` and the
operator console stay exactly as blocked as they were at `15339f18`.

The question: once the two-door onboarding lets anyone create an account, does every route family refuse — in
**that operation's own authority check** — an unapproved self-signed-up account, a suspended clinic, a removed
membership and an already-issued (stale) token? The answer is now a checked inventory rather than a sentence.

## 1. The checked inventory

`src/server/route-authority-inventory.ts` assigns every one of the 262 `src/app/api/**/route.ts` files to one of 18
authority families, and states for each family, under **both** authorities, what happens in each of the four cases:

| Result | Meaning | Cells |
| --- | --- | --- |
| `refused` | the operation's own check refuses; a named test shows it | 49 |
| `refused_disabled` | refused before any request in that mode (family unconverted or release blocked); a named test shows it | 36 |
| `gap` | admitted when it should not be; a named test pins it, and a decision owner is named | 1 |
| `token_lifetime` | admitted until the already-issued token expires, because nothing re-reads current rows | 12 |
| `not_applicable` | the case cannot arise (public page, consumer session, applicant door) | 20 |
| `unverified` | no source test was found either way; the reason says what would settle it. **Never counted as a pass.** | 26 |

`route-authority-inventory.test.ts` (149 cases) walks `src/app/api`. It fails on:

- a route without a family, a listed route that no longer exists, or a prefix that matches nothing;
- a refusal or gap that cites no evidence;
- evidence whose test file is missing or does not contain the cited `it()` title;
- any change to the gap list or the per-result counts.

The route families the review asked for, and where their authority actually lives:

| Asked for | Family | Legacy (deployed default) | `database_current` (not activated) |
| --- | --- | --- | --- |
| Compatibility fallback / charts / billing | `compatibility_rpc` (data-compatibility RPCs) | claims choose the clinic; SQL re-reads membership: unapproved and removed refused, **suspended clinic admitted (gap)** | setter binds current rows: all four refused |
| Identity / consent | `synthetic_identity_boundary`, plus the converted identity routes behind `compatibility_rpc` | claims; unapproved refused, others unverified | refused (unconverted) |
| Messages | `care_messages` | unapproved refused; suspended clinic and removed membership read by SQL but **unverified** (no legacy-specific test) | all four refused |
| Programs | `program_assignments` | refused (gated off) | all four refused |
| Export / corrections | `unconverted_claims_families` (privacy operations) | unapproved refused; others unverified | refused (unconverted) |
| Provider visits | `telehealth_visits`, `telehealth_calendar` | calendar: membership re-read on every request (all four refused); visits: suspended clinic unverified | all four refused |
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

Care messaging and telehealth visits under legacy for a suspended clinic; the Fullscript connection (keyed by the
clinic cookie with no membership re-read); the unconverted claims families one by one; the transitional tRPC host,
which lives outside this repository. Each is listed with its reason in the inventory.
