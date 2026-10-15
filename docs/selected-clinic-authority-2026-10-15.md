# The selected clinic, through Desktop and telehealth (2026-10-15)

**Source only.** `database_current` is not selected in any deployed configuration:

- Desktop defaults to `legacy_claims` (`CLINICAL_WORKFORCE_AUTHORITY_MODE` unset).
- The telehealth Lambda entry (`aws-telehealth-requests-lambda.ts`) does not set `workforceAuthority`.
- No AWS resource, Cognito setting, schema or provider was touched. No SQL or infrastructure candidate was added.
- Hosted, device, commercial and PHI verification are **unobserved**.

This continues `docs/workforce-current-identity-consent-2026-10-15.md`. That work made the identity API answer the
identity, consent and Desktop-compatibility routes from current membership rows. It requires exactly one
`x-alp-selected-organization-id` per request. This document covers the two callers that had to start sending that header:

- the Desktop clinical transport;
- the telehealth boundary's own identity-API calls.

## 1. Desktop: which clinic a request names

`src/adapters/selected-clinic.server.ts` decides the header. The clinic is the authenticated session's own selection
and nothing else.

- **Source.** The selection is the httpOnly `aidp_org` cookie plus a new httpOnly `aidp_org_sub`. The first is written
  only after a server-side membership check; the second records whose choice it was.
  - `aidp_org_sub` is `sha256("aidp-selected-clinic/1|" + sub)`, where `sub` is the Cognito subject of the ID token
    the choice was made with. It is never the subject itself.
  - A form, URL, request body, module-level variable or Cognito custom claim is never a source.
- **Scope.** `runLive` (all 203 `/api/live` route files that use it) and the clinical server components resolve the
  selection once per request, into an `AsyncLocalStorage` context. The transport reads that context. Two requests in
  one server process never see each other's choice; this is tested with interleaved requests.
- **Binding.** The transport recomputes the binding from the token it is about to send. A selection made by another
  account is refused, not reused.
- **Operation agreement.** Some operations name a clinic: an RPC's `_organization_id`, or a select's
  `organization_id=eq.`. That clinic must be the selection. Work prepared in one window cannot run under a clinic
  chosen in another.

| Selection state | Answer, before any request leaves the server |
| --- | --- |
| selected, bound to this token | one `x-alp-selected-organization-id`, the selected clinic (lower-case) |
| missing | 400 `invalid` "Choose your clinic in Settings before continuing." (`clinic_selection_missing`) |
| not a UUID | 400, `clinic_selection_malformed` |
| two `aidp_org` or two `aidp_org_sub` values | 400, `clinic_selection_duplicate` |
| no binding, or a binding that is not a digest | 400, `clinic_selection_unbound` |
| bound to another account's subject | 400, `clinic_selection_account_mismatch` |
| an operation names a different clinic | 409 `conflict` "Your clinic changed in another window. Reload to continue." |
| outside any request context | 400, `clinic_selection_unavailable` |

### Account and clinic switches

- **Sign-in (password and MFA).** Writes both cookies for the new subject, or **clears both** when the clinic lookup
  fails. Before this change, a failed lookup left the previous account's `aidp_org` in place.
- **Sign-out and session expiry.** Clear every `AUTH_COOKIES` entry, which now includes `aidp_org_sub`.
- **Clinic switch (`POST /api/auth/org`).** Asks the API about the clinic **being chosen**, under that clinic's own
  header. It writes both cookies only when the API lists the person as a current member. A clinic the person is not in
  is refused, and nothing is written.

### Redirects, logs and bundles

- The AWS clinical transport now sets `redirect: "error"`, because a redirect would carry the bearer and the clinic to
  another host. This also changes legacy behaviour: a redirect from the API, which never redirects, is now `unavailable`
  instead of being followed.
- The telehealth adapters already used `redirect: "manual"`.
- The live-route log line carries the code and a fixed detail only. A test asserts that no clinic, subject, token or
  binding reaches `console.*`.
- `scripts/check-clinical-bundle.mjs` now treats `aidp-selected-clinic/1` and `x-alp-selected-organization-id` as
  server-only markers.

### Legacy

Under `legacy_claims`, requests carry no new header and gain no new refusal. The one exception is `redirect: "error"`
above.

## 2. Route families

**Converted (they send the selection under `database_current`):**

- every `/api/live` route through `runLive`, and the server components that call adapters directly:
  - the patient pages and layout;
  - the patients list;
  - the calendar;
  - the encounter timeline;
  - the Settings data-source card;
- the auth routes, handled explicitly: login, MFA, org switch and org auto-select;
- `programs/catalog`, which now names the bound selection;
- the telehealth visit adapter (`telehealth.live.ts`) and the appointment-request queue (`telehealth-requests.live.ts`).

**Not converted.** These callers reach identity-API workforce routes that the API does not yet serve under
`database_current`. The API answers each of them 503 `membership_authority_not_configured` before reading a claim, so
they fail closed rather than fall back to a custom claim. Converting one means converting both sides together.

| Desktop caller | Route family |
| --- | --- |
| `recording-authority`, `-capture`, `-drafting`, `-transcription`, `-cleanup-review`, `-cleanup-execution` (`src/adapters/`) | `/clinical-core/workforce/encounter-recording/*` |
| `src/app/api/live/calendar-connection/workforce.ts` | `/clinical-core/workforce/calendar-connection` |
| `src/app/api/live/care-messages/route.ts` | `/clinical-core/workforce/messages` |
| `src/app/api/live/patient-notification-settings/route.ts` | `/clinical-core/workforce/notifications/settings` |
| `src/app/api/live/program-assignments/route.ts` | `/clinical-core/workforce/programs` |
| `src/server/clinical-core/ask-alp-workforce-client.ts` | `/clinical-core/workforce/chat` |
| `src/server/clinical-core/privacy-operations-client.ts` | `/clinical-core/workforce/privacy-operations` |
| `src/server/lab-attestation-upstream.ts` | `/clinical-core/workforce/lab-attestations*` |
| `src/server/consult/consultWorkforceApi.ts` (synthetic boundary only) | consult links, requests, records, retention, disputes |
| `src/server/campaign-api.ts` | the separate campaign API (its own authorizer; not clinical) |

`src/server/programs/program-catalog-observation.ts` already sent the header.

## 3. Findings, not fixed

1. **The first selection after sign-in cannot be made under `database_current`.**
   - The identity API answers `list_my_organizations` only for a request that already names a clinic.
   - So login, org auto-select and the first Settings list all refuse before any HTTP call, because no selection
     exists yet.
   - Fix needed (AWS side): a subject-only membership read that lists the signed-in subject's current clinics without
     a selection.
2. **The selection is per browser session, not per tab.**
   - A clinic switch in one tab changes the clinic of the next request from every tab.
   - Covered:
     - an operation that names its clinic gets 409;
     - a patient-scoped write is refused by the database for the wrong clinic.
   - Not covered: an organization-implicit write from a stale tab runs in the newly selected clinic.
   - Closing it needs a page-bound expected-clinic value that every client call sends back. Desktop has no shared
     client fetch helper to carry it today.

## 4. Telehealth: the boundary's identity caller

`src/server/clinical-core/aws-telehealth-requests.ts` gains `workforceAuthority?: "legacy_claims" | "database_current"`.

- `database_current` is refused at construction outside the production runtime, as is any other unknown value. A
  production handler still answers nothing until `phiAllowed`.
- **Actor.** Under `database_current` a workforce actor needs:
  - the configured issuer and audience;
  - an ID token and a UUID `sub`;
  - `email_verified`;
  - no synthetic attestation;
  - a live `exp` (checked here, not left to the gateway);
  - exactly one canonical (lower-case) UUID `x-alp-selected-organization-id`. Two, an empty one or an upper-case one is
    403.

  No custom claim is read. The clinic is the selection; the person and role are whatever the identity API's current
  rows say. The actor has no person id, so any person comparison fails closed.
- **Forwarding.** Every identity-API call the boundary makes carries that one header:
  - `list_my_organizations`;
  - `get_desktop_calendar`;
  - `get_telehealth_record_authority`;
  - the consent artifact;
  - the consent reads and writes.

  Every DynamoDB key and `_organization_id` names the same clinic. Neither an appointment nor a request body can
  choose it.
- **Consumer routes** are unchanged.

### The race between the authority read and the write

**Legacy design, as it stands.** A workforce write reads current membership through the identity API, then writes
DynamoDB or calls Zoom, Stripe or SES. These are separate calls, so a revocation committed between them does not stop
the write. The test `the separate-call design cannot fence it` shows the order: authority read, then membership
revoked, then the slot is published. The next request is refused, but that slot already exists.

**Under `database_current`**, the 11 writes are therefore **disabled**. They answer 503
`membership_fence_unavailable` before any identity call, table access, secret read or email. Desktop shows: "This
telehealth change is not available yet under clinic-membership sign-in. Reading visits still works."

The 6 reads first check current membership, before reading their table. A read authorized at time T returns what a
current member could read at T. Each identity-API call inside it is authorized again by the API's own transaction.

### Route matrix

All 17 workforce routes are tested in `aws-telehealth-current-membership.test.ts`. A source test also requires every
workforce route the handler declares to be in exactly one of `TELEHEALTH_WORKFORCE_READ_ROUTES` or
`TELEHEALTH_WORKFORCE_WRITE_ROUTES`.

| Route | Wrong clinic | No current membership | Suspended | Demoted | Consent withdrawn | Identity outage |
| --- | --- | --- | --- | --- | --- | --- |
| `GET …/requests` | 403 | 403 | 403 | 403 | n/a (not consent-gated) | 503 |
| `GET …/slots` | 403 | 403 | 403 | 403 | n/a | 503 |
| `GET …/visits` | 403 | 403 | 403 | 403 | n/a; the list shows `consentSigned` | 503 |
| `GET …/visits/consent-artifact` | 403 | 403 | 403 | 403 | n/a | 503 |
| `GET …/visits/notes` | 403 | 403 | 403 | 403 (and 403 for a staff demotion on a completed visit's retained record) | 200, shown as withdrawn (tested) | 503 |
| `GET …/visits/notes/inventory` | 403 | 403 | 403 | 403 (and the retained-record 403) | by construction, as above | 503 |
| the 11 writes (actions, slots, payments, consent, withdraw, start, end, note import, sign, transfer, transfer complete) | 503 `membership_fence_unavailable` before any call, in every column | | | | | |

How to read the matrix:

- "Wrong clinic" is tested two ways: the API refuses the selection, and the membership list omits it.
- "Suspended" and "no current membership" look the same on the wire: the API refuses both. The boundary cannot tell
  them apart, and it refuses both.
- Every read refusal happens before its table is read. Each test asserts one identity call carrying the selected
  clinic.

### The transactional design the writes need (not built)

A telehealth write can run under `database_current` only when a membership change and the write cannot interleave.
The recommended design:

1. **A DynamoDB membership fence.**
   - Add an item `ORG#<clinic> / MEMBER#<subject>` with a `version` attribute.
   - Every suspension, revocation or demotion bumps that item first, with a conditional update.
   - Only then is the PostgreSQL membership change committed. If the bump fails, the change is refused and retried, so
     the change is never committed unfenced.
2. **Fenced writes.** Every telehealth write becomes a `TransactWrite` with a `ConditionCheck` on the fence item. The
   check compares against the version the identity API returned in the same current-membership transaction that
   authorized the request. A write either committed before the bump, while membership was current, or it fails its
   condition.
3. **Provider calls.** Zoom, Stripe and SES cannot take a DynamoDB condition.
   - They run only under an intent record that was itself admitted by a fenced write, as the meeting lease already does.
   - After a later failed fence check, an idempotent compensation follows: end the meeting, refund, or skip the send.
   - This narrows the window but cannot remove it. The residual window has to be an explicit, accepted policy.
4. **Prerequisites (Codex and AWS):**
   - a fence item schema;
   - IAM for the membership writer to update the fence;
   - the identity API returning the fence version;
   - a two-session qualification: revoke between the read and the write, and the write is refused.

The alternative is to move the telehealth records into the clinical database, so the write shares the authority's
transaction. That is a larger migration.

## 5. Evidence

| Test file | At `0f927cde` | After |
| --- | --- | --- |
| `src/app/api/live/selected-clinic-route.test.ts`: the real lab-workspace, login and org routes | 9 failed, 1 passed (legacy unchanged) | 10 passed |
| `src/adapters/selected-clinic.server.test.ts`: resolver, mode flag, concurrent contexts, operation agreement, specimen read | import fails (module absent) | 6 passed |
| `src/adapters/telehealth.selected-clinic.test.ts`: both telehealth adapters, the disabled-write message, legacy | import fails (module absent) | 5 passed |
| `src/server/clinical-core/aws-telehealth-current-membership.test.ts` | 69 failed, 5 passed | 74 passed |

The 5 that pass at the base telehealth handler:

- two refusals it already made: an access token, and another issuer;
- the write-ordering refusal: no selection is still 403;
- legacy unchanged;
- the legacy race characterization.

Raw output of the base runs is kept in the session scratchpad, not in the repository.

Kept as they were:

- the outreach separation test (`src/integration/outreach-separation.test.ts`);
- every existing telehealth suite.

To keep the campaign path off the clinical adapters, the clinic resolution lives in `src/server/request-clinic.ts`
(not `session.ts`), and `liveGuard` moved to `src/app/api/live/route-guard.ts`. The test itself was not changed.
