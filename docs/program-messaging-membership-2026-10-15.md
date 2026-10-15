# Messages and assigned programs under clinic-membership sign-in — 15 October 2026

Branch `claude/program-messaging-membership-20261015`, from `42a57928`. This is source and local tests only.

What was not done:

- Nothing was deployed, registered or applied.
- No AWS, Cognito, SQL ledger, secret, provider, PHI or production setting changed.
- `database_current` is not selected by any configuration.
- The current-membership setter, first-clinic discovery and the membership-fence guard are still **unregistered**.
- Telehealth writes stay disabled.
- Codex's `agent/qualification-program-clinic-fences-20261015` was not touched. Neither were
  `rds-data-database.ts` and the credential candidate or operator files.

Core stays education-only. Lab-derived supplement directions, purchase links, paid programs, production Ask ALP, PHI and
real patient data stay withheld.

## Status by level

| Item | Implemented | Locally verified | CI verified | Hosted verified | Device verified | PHI-approved |
| --- | --- | --- | --- | --- | --- | --- |
| Messages, service: production messaging API under `database_current` | yes, unactivated (`CARE_MESSAGING_WORKFORCE_AUTHORITY`) | 16 database cases | see the V2 return | unobserved | n/a | no |
| Messages, Desktop: gated route, stale-tab fence, clinic echo, panel states | yes, **off** unless `CLINICAL_CURRENT_MEMBERSHIP_FAMILIES` names it | 16 route cases + 3 browser cases | see the V2 return | unobserved | unobserved (real tabs) | no |
| Programs, service: practitioner actions from current membership | yes, source only; **no deployed host** | 13 database cases | see the V2 return | unobserved | n/a | no |
| Programs, Desktop: same gate and fence | yes, **off** | in the 16 route cases | see the V2 return | unobserved | unobserved | no |
| Programs through the qualification API | **blocked**: needs a new grant (§4) | — | — | — | — | — |
| Mounted journey, Desktop to service to patient app | source fixture | 7 cases | see the V2 return | unobserved | n/a | no |

## 1. What the two families were, and what they are now

At `42a57928`, `/api/live/care-messages` and `/api/live/program-assignments` both answered 503
`membership_authority_not_configured` under `database_current`, before sending a token. Their services decide the
clinic in one of two ways, depending on the boundary:

- **Token claims.** The production care messaging API (`recordingWorkforceIdentity` reads `custom:person_id` and
  `custom:organization_id`) and the qualification program API work this way.
- **Synthetic only.** The identity API's synthetic boundary serves the messages and programs routes there, and refuses
  them in production.

Both production SQL families read only the transaction's `clinical.claim.*` context, which is the same context
`set_current_workforce_context` writes from current rows, and check `has_clinical_role`. So both can run on the current
membership in one transaction with **no new SQL**.

| | Before | Now (source) |
| --- | --- | --- |
| Desktop caller | refused under `database_current` | **gated**: still refused unless the deployment names the family; then fence, then the session's own clinic, then only an answer that names it |
| Messaging service | claims | `database_current` path: subject plus one selected clinic, then the setter, then the unchanged message function |
| Program service | claims (qualification), not wired (production) | current-membership adapter and route handler, not mounted anywhere |
| Patient app routes | owner token plus current connection | unchanged |

## 2. Messages (WP1)

**Service** (`production-care-messaging-api.ts`, `production-care-messaging.ts`, `care-messaging-deployment.ts`,
`current-membership-workforce.ts`):

- **Mode.** `CARE_MESSAGING_WORKFORCE_AUTHORITY=database_current` selects the path. Any other value except unset or
  `legacy_claims` refuses the deployment (503).
- **What the token supplies.** Only:
  - the configured workforce issuer and audience;
  - an ID token with a UUID `sub` and a verified email, and no synthetic attestation;
  - the family's own freshness: a live `exp`, a plausible `iat`, and `auth_time` within 15 minutes.

  The person, clinic, role, production and group claims are ignored. A stale token gets 401 `reauth_required`.
- **The clinic.** The request carries exactly one `x-alp-selected-organization-id`, equal to the clinic the API serves.
  A missing, duplicated, differently-cased or other clinic gets 403 `identity_refused` with **no database transaction**.
- **One transaction:**
  1. It checks the setter's reviewed body:
     - SECURITY DEFINER;
     - `search_path=''`;
     - callable by `clinical_core_api` and not by PUBLIC;
     - the prosrc SHA-256 is `572a22c0…1521186`, pinned in `CURRENT_MEMBERSHIP_SETTER_BODY_SHA256` and held to the
       candidate by a test.

     While the setter is unregistered, or if its body changes, the answer is 503 and no message function runs.
  2. It binds the current membership with `set_current_workforce_context`, which locks the rows `FOR SHARE`.
  3. It runs the unchanged `production_care_message_request` with its own checks: `has_clinical_role`, verified
     connection, messaging consent, idempotency and consent withdrawal. `set_request_context` is never called.
- **Receipts and settlement** stay the patient app's own: 403 on the workforce route.
- **The answer** names the clinic it was decided in (`x-alp-selected-organization-id`). Consumer routes are unchanged.

**Desktop** (`clinic-authority-families.ts`, `current-membership-route.ts`, the two routes, both panels):

- **The gate.** `care_messages` and `program_assignments` move from *unconverted* to *gated*. Under `database_current`
  they still answer 503 `membership_authority_not_configured` before the token leaves, unless
  `CLINICAL_CURRENT_MEMBERSHIP_FAMILIES` names the family. A list containing anything unrecognised names none. Naming a
  family is a pairing with that service's own `database_current` configuration, not a switch for clearing an error.
- **When served:**
  - The stale-tab fence runs first: 409 `clinic_selection_changed`, before the body is read.
  - Only the session's account-bound selection is sent. A missing, malformed, duplicated or other account's selection
    gets 403 `clinic_selection_required`.
  - An answer is accepted only when it names that clinic. Otherwise it is 503 `membership_authority_not_configured`,
    so a claim-path service cannot pass as current membership.
- **Unchanged:** same-origin, the bounded body and reply, `no-store`, and the pass-through of the service's
  401/403/409/429. A body cannot name a clinic: the contracts are strict.
- **The panels** now name each refusal:
  - a clinic changed in another window;
  - choose your clinic;
  - not available yet under clinic-membership sign-in.

  None of these appears as an empty inbox, "access refused" or "version not published". A reply refused because the
  clinic changed tells the practitioner to check whether it was stored before sending again.

## 3. Assigned programs (WP2)

`current-membership-program-assignments.ts` and `current-membership-program-api.ts`:

- **Scope.** The six workforce actions (`assign`, `status`, `release`, `connections`, `programs`, `preview`) are
  decided by the current membership in the selected clinic.
- **A separate entry point.** It sits beside the production adapter, whose claim context and consumer path are
  unchanged, so Codex's edits to `boundedProgramExecutor` are not touched. A patient's action is never taken on a
  practitioner's membership.
- **Before any request.** It needs the same activation evidence and consumer-boundary evidence as the production
  adapter.
- **One transaction.** The setter check, then the binding, then `production_program_bounded_request` (the BLOCKED
  boundary, which withholds every destination). The destination lock is applied again on `read` and `preview`.
- **The route handler.** `createCurrentMembershipProgramApi` is the route a host would mount. It takes only the verified
  subject, requires exactly the configured clinic, and names the clinic in its answer. **Nothing mounts it.**

The patient app adopts, checks in and advances only:

- the exact assignment, digest, revision and plan review it was shown;
- for its own owner;
- on a current, verified connection.

These rules are the SQL's own and are tested here through the real adapter. A supplement step whose governed catalog
cannot vouch for it stays held, with no destination. Its completion is refused while lessons and progress continue.
No order URL, price, checkout or paid entitlement is inferred anywhere.

**Found and recorded, not changed.** A held step's completion surfaces as 403, not 409. `rds-data-database.ts`
classifies `program_item_held` as `operation_refused`, and the production adapter maps that to `identity_refused`.
Both files are Codex's to change if the patient app should say "held" rather than "refused" (§7).

## 4. What is blocked, and the choice needed

- **Programs through the qualification API.**
  - Codex's restricted login `clinical_program_qualification_api` can call only two reviewed proxies:
    `clinical_program_qualification.set_request_context` and `.bounded_request`.
  - The current-membership path needs the setter, which is granted only to `clinical_core_api`.
  - Serving qualification programs under `database_current` therefore needs a **new grant**: a third reviewed proxy (for
    example `clinical_program_qualification.set_current_workforce_context`, delegating to the setter) plus its
    binding-check entry.
  - That is a policy and access change. It was not made, and the qualification path stays on claims.

  *Source-interface request to Codex:* add the proxy and its `QUALIFICATION_PROGRAM_FUNCTIONS` row, or decide that
  qualification programs stay claim-bound.
- **Where the production program route lives.** No production program host exists. The production identity API's pilot
  route list excludes `/workforce/programs`, and adding it there is a pilot-scope decision. Mount
  `createCurrentMembershipProgramApi` in a dedicated host, or add the route to the pilot. Owner and Codex.

## 5. The mounted journey (WP3)

`src/server/patient-practitioner-journey.database.test.ts` runs:

- the real Desktop routes (session, selection, fence and gate);
- the messaging deployment handler and the program route handler;
- the patient-app adapters and the shared contracts;
- one database: the assembled schema, both lab candidates, the BLOCKED program candidate and boundary, and the setter.

Only the cookies, the request headers, the network hop (with API Gateway's JWT check) and the clock are simulated.

| Case | What is asserted |
| --- | --- |
| End to end | The patient messages and the practitioner lists, reads and replies. The patient's second device re-reads both. The practitioner previews (no destination) and assigns. The patient reviews (supplement held), adopts and completes a lesson; after two days on the clock, advances. The practitioner sees phase 2. Every API request named exactly the selected clinic |
| Disconnect racing a reply, reply first | Stored. After the disconnect neither side can read the conversation |
| Disconnect first | 403, no message |
| Clinic switch racing a reply, reply first | Stored in its clinic. The stale tab then gets 409 with no request. The switched tab asks in its own clinic, which this API does not serve: 403 |
| Switch first | 409 before the request leaves the Desktop; nothing stored |
| Late answer | The answer names its binding; one asked in another clinic carries none for this tab. The browser half is `clinic-binding.test.ts` |
| Membership revoked racing an assignment | Revoked inside the transaction: 403, nothing assigned. Revoked before: 403 on messages and programs. Restored: works |

Background and resume on the patient side are V2's own (`program-screen-journey.test.tsx`, unchanged and passing).
This is a source fixture. **It is not hosted acceptance.**

## 6. Evidence

Failing-before runs copied the new tests into a clean worktree at `42a57928`, then removed them. For the routes and the
journey, the new standalone modules they import were copied too. Raw output is in the session scratchpad.

| Test file | Before | After |
| --- | --- | --- |
| `care-messaging-current-membership.database.test.ts` + `current-membership-routes.test.ts` | 23 of 32 fail | 32 pass |
| `current-membership-program-assignments.database.test.ts` | cannot load (adapter absent) | 13 pass |
| `patient-practitioner-journey.database.test.ts` | 7 of 7 fail | 7 pass |
| `e2e/care-messages.spec.ts` (3 new browser cases) | new | 8 of 8 pass (local Chromium, the CI job's environment) |

The 9 that pass before:

- the refusal default (2);
- a forged-body refusal (2, which the base also refused);
- an unnamed-clinic answer (2, which the base refused for everything);
- the legacy route;
- the expired sign-in;
- the patient-app route.

The local gates are in the V2 return, with the exact commands.

## 7. Ordered hosted work for Codex (none of it performed)

1. **Register the current-membership setter** (`workforce-current-membership-context.sql`, rollback beside it), in the
   order already given for the identity family. Messages and programs need no other SQL.
2. **Messaging, in qualification, with fictional subjects:**
   1. Set `CARE_MESSAGING_WORKFORCE_AUTHORITY=database_current` on the care messaging Lambda.
   2. Confirm the setter check passes as the API role.
   3. Run the hosted cases below.
   4. Only then pair the Desktop with `CLINICAL_CURRENT_MEMBERSHIP_FAMILIES=care_messages`.
3. **Programs:** the decision in §4, then the hosted cases.
4. **Hosted cases**, with two sessions and fictional subjects:
   - one selected clinic: list, read and reply, with the reply's sender being the database person;
   - a second clinic selected in another tab: 403, no transaction;
   - a membership suspended between two replies, and one suspended during a reply (lock order, as in the identity
     family's two-session qualification);
   - pending and removed memberships;
   - consent withdrawal and connection replacement racing a reply, both orders;
   - a retried reply after a dropped response: the duplicate has the same message id;
   - the setter unregistered or changed: 503;
   - the echo header reaching the Desktop through API Gateway;
   - for programs: assign, preview (no destination) and release under the current membership, the patient's
     adopt/complete/advance, and a cross-clinic attempt.
5. **Whether RDS Data API transactions hold the setter's row locks across statements** is still the open hosted
   question from the identity family.
6. **The held-step status** (§3): keep 403 or classify `program_item_held` as a conflict, in `rds-data-database.ts` and
   the production adapter.
