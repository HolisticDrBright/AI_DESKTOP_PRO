# Clinic authority fences (2026-10-15)

Branch `claude/clinic-authority-fences-20261015`, from Desktop `aa5a668e` with Codex's `826b7db1` merged first
(`d1a1c333`, no conflicts). It closes the three findings left open by
[`selected-clinic-authority-2026-10-15.md`](selected-clinic-authority-2026-10-15.md) and audits the caller families that
document listed as not converted. The V2 half (the Android lab-photo picker) is on V2
`claude/lab-photo-picker-20261015`; its return is `expo/docs/claude-clinic-authority-lab-photo-return-2026-10-15.md`.

Everything here is source. The `database_current` authority is not selected anywhere. No SQL is registered or applied,
no AWS resource exists for it, and the telehealth Lambda configures no fence table, so its 11 writes still answer
`membership_fence_unavailable`.

| Commit | Package | What |
| --- | --- | --- |
| `9b27cb3a` | WP1 | First clinic selection: subject-only membership discovery |
| `27f22373` | WP2 | Stale-tab clinic fence |
| `ae6ff517` | WP3 | Telehealth writes under the membership fence (`membership-fence/1`) |
| `a41a81ac` | WP4 | The unconverted caller families refuse under clinic-membership sign-in |
| `23de1d1a` | WP6 | Two more server-only bundle markers |

## Status by level

"Unobserved" means nobody has run it. It does not mean it passed.

| Package | Implemented | Locally verified | CI verified | Hosted verified | Device verified | PHI-approved |
| --- | --- | --- | --- | --- | --- | --- |
| WP1 first clinic selection | yes | yes (22 tests) | see the V2 return | unobserved | n/a | no |
| WP2 stale-tab fence | yes | yes (13 tests) | see the V2 return | unobserved | unobserved (browser) | no |
| WP3 telehealth membership fence | yes, disabled | yes (79 tests) | see the V2 return | unobserved | n/a | no |
| WP4 caller families | yes | yes (16 tests) | see the V2 return | unobserved | n/a | no |
| WP5 Android lab photos (V2) | yes | yes (4 + 2 tests) | see the V2 return | n/a | unobserved | no |

## 1. First clinic selection (WP1)

Before this, nothing could be selected first under `database_current`: `list_my_organizations` answers only for a
request that already names a clinic.

- **The read.** `GET /clinical-core/workforce/memberships/current` takes the verified subject only: no selected clinic,
  no body, no query; any of them is 400. It runs the BLOCKED candidate
  `clinical_private.discover_current_workforce_memberships(_subject)`, which needs exactly one active, production-bound
  workforce identity and an active person. It returns:
  - `clinics`: active memberships with a clinical role in active production clinics;
  - `pending`: memberships still awaiting approval, with no role, because pending is not access.

  It reads no patient, record or clinical row and sets no request context. An unknown, disabled or consumer identity is
  refused, never answered as "no clinics". Under the pilot, both lists are filtered to the pilot clinic.
- **Desktop.** `src/server/clinic-choices.ts`:
  - sign-in selects a clinic only when exactly one is active, and never chooses among several;
  - the Settings switcher lists clinics and pending memberships apart ("Awaiting approval: …");
  - a switch to a pending clinic is 403 `clinic_membership_pending`;
  - a switch is written only for a clinic in the discovered list. A clinic the caller names is never used to ask.

  Legacy keeps `list_my_organizations` and first-membership selection.
- **Tests.** `src/app/api/auth/first-clinic-selection.test.ts` (9) covers:
  - first sign-in; no memberships; pending; several clinics;
  - revocation between sign-in and switch;
  - an account switch in the same browser.

  `workforce-membership-discovery.database.test.ts` (13) runs the real handler and adapter over PGlite.

## 2. Stale-tab clinic fence (WP2)

The selection is per browser session, so a switch in one tab changed the clinic of the next request from every other
tab. An operation that names no clinic would then run in the newly selected one.

- Every page rendered under a selection carries a binding token: `"v1." + base64url(sha256("aidp-expected-clinic/1|" +
  subject + "|" + clinic))`, truncated to 32 characters. It is a fingerprint, not a credential.
- `src/lib/clinic-binding.ts` (browser) sends it as `x-aidp-expected-clinic` on every same-origin `/api/live/` call. A
  tab with no rendered page adopts the binding of its first answer. An answer bound to another clinic becomes the 409
  clinic-changed refusal instead of being shown.
- `runLive` compares it with the session's current, account-bound selection before any adapter call. A mismatch,
  including a different account on the same clinic or two expected values, is 409 `clinic_selection_changed`: "Your
  clinic changed in another window. Reload to continue."
- **Authority stays on the server.** Local storage is never read, and the browser value is only compared, never used to
  choose. The missing, malformed, duplicate and other-account refusals of the selection itself are unchanged and come
  first. Legacy ignores the header.
- **Tests.**
  - `stale-tab-clinic-fence.test.ts` (8): two tabs, a switch during an in-flight request, an account change, an
    implicit-clinic write (`resolve_review_queue_item`), and the preserved refusals.
  - `clinic-binding.test.ts` (5): the browser half.

## 3. Telehealth write authority: the membership fence (WP3)

### Mechanism (`src/server/clinical-core/membership-fence.ts`)

**Fence items.** A DynamoDB item per workforce subject (`WORKFORCE_SUBJECT#<sub>`) and per clinic (`CLINIC#<org>`),
sort key `MEMBERSHIP_FENCE`, in a table of its own. Each holds `fenceProtocol`, `fenceVersion` and `pendingChanges`
(a string set of in-flight change ids).

**The membership change** (`aws-production-desktop.ts`), for `set_org_member_role` and `remove_org_member`, in order:

1. Inside the change's open transaction, the database names the member's workforce subjects
   (`clinical_private.membership_fence_subjects`, for the caller's own clinic only).
2. The writer **begins** the fence for each: the change id joins `pendingChanges` and the version moves. An unconfirmed
   begin refuses the change before it runs.
3. The acknowledgement goes to the database (`clinical.membership_fence_ack`).
4. The RPC runs and the transaction commits or rolls back.
5. **Only then** the fence settles: the id leaves the set and the version moves again. Settling before the commit would
   let a write see a settled fence while the change it covers was still about to commit.

Under `database_current`, without a fence writer, both RPCs are refused (`membership_fence_unavailable`). Legacy
unchanged unless a writer is supplied.

**A telehealth write** (`aws-telehealth-requests.ts`, only when `membershipFenceTable` is configured):

1. Both fences are read, strongly consistent, **before** current membership. A fence with a change in flight is 409
   `membership_changed`, and nothing else is called.
2. Current membership comes from the identity API's posture, under its own current-membership transaction. It must
   show a clinical role in the selected clinic and names the caller's person, which the write is recorded as. Posture
   now returns `personId` for this.
3. Every table write becomes one `TransactWrite` that also holds both fence conditions: still absent, or still settled
   at the version read. Reads pass through. Closing this invocation's own writer, and releasing a fully undone
   operation, are the only unfenced writes.

**Why both race orders hold.**

- A change that began before step 1 either still shows as in flight, or has committed, and step 2 then sees it.
- A change that begins after step 1 moves the version, so the next table write fails as a whole.
- A write that commits therefore committed while the membership it was admitted under was current: before the change
  began, which was before the database change committed.

### Provider calls

Zoom, Stripe and the scheduler cannot take a DynamoDB condition. So:

- every provider call runs only after a fenced write that admitted it (the operation's dispatch mark, or the visit's
  meeting lease);
- a call dispatched under the fence carries an undo;
- after a later fence failure, the undo runs outside the fence.

| Write | Provider effect after the last fenced write | If the membership changes before commit |
| --- | --- | --- |
| schedule a request | Zoom meeting created | the meeting is deleted |
| reschedule | Zoom meeting moved | it is put back to the time the request still records |
| schedule / reschedule | reminders replaced | the new revision is deleted and the replaced one recreated (a fresh client token). Reminders of an uncommitted revision could never send: `reminderRefusal` requires the committed generation |
| charge | Stripe PaymentIntent | succeeded: refunded in full under `telehealth-compensate-refund:<request>:<operation>`; still cancellable: cancelled under `telehealth-compensate-cancel:…`; `processing`: not undoable yet |
| cancel | meeting and reminders deleted | irreversible: the operation stays pending |
| refund | Stripe refund | irreversible: the operation stays pending |
| start a visit | meeting created under the lease | the existing lease logic deletes an unbound meeting; a bound one stays with the visit for the next authorized start. No SDK session or host token leaves |
| end a visit | meeting ended | reduces authority: not undone; the visit stays `ending` |
| import the AI note | summary read | nothing is stored or returned |
| transfer | chart admission signed | the admission is returned only after its fenced save |
| slots, consent, withdraw, sign, transfer complete | none (identity-API writes run in its own current-membership transaction) | the one write either committed before the change or failed |

A request operation is released only when every effect it dispatched was undone, or there was none. It is then
refused as `membership_changed` with `sideEffects: "compensated"` (or `"none"`). An irreversible or unconfirmed effect
leaves it pending, exactly as a post-effect commit failure does today. A retry of the same operation answers the same
refusal and calls no provider. A new operation id is admitted on its own.

**Residual window, stated as policy.** A provider call can start in the instant after its dispatch mark committed and
a change began. It then runs, and is undone. It is never kept, and it never becomes an authorized visit or a kept
charge. Accepting that window is an owner decision (below).

### The guard candidate (BLOCKED, unregistered)

`infra/aws-clinical-core/source-candidates/workforce-membership-fence-guard.sql` (SHA-256
`d3bb86387a75da63a7742530acb571e0e1a8625c52343fd32db2a726596ff5ec`) and its rollback (SHA-256
`9f5ddc402a2b2984767a2267541228449ecd5b11aae95a0d67227e2b2e403280`).

It refuses (`membership_fence_required`) every authority-reducing change to the rows the current-membership check reads,
unless the transaction carries the acknowledgement naming that subject or clinic:

- a membership that is active;
- a workforce identity that is active;
- a person who is active;
- a clinic that is active.

The acknowledgement is an attestation, not proof: PostgreSQL cannot read DynamoDB. What the guard does guarantee is that
no path which never began the fence can commit unfenced, including:

- an operator's ad-hoc UPDATE;
- the deployed `add_org_member` re-invite, which can demote an active member.

New invitations, approving a pending member and edits to non-active rows need no acknowledgement. The rollback removes
only the guard. The telehealth writes must be disabled before it runs.

### Tests

- `aws-telehealth-membership-fence.test.ts` (69), over the real handler, the real fence writer and the conditional
  store:
  - every one of the 11 writes runs with both fences held;
  - every write is refused when the revocation completed first, while it is in flight, and when it begins after the
    fence read;
  - every write after a revocation that follows the first commit;
  - the undo of a created meeting, a moved meeting with replaced reminders, a succeeded or cancellable charge;
  - a charge that cannot be undone stays pending; a visit start's meeting is deleted;
  - retry and a new operation; a stuck change; a clinic change; a malformed fence; bad postures; configuration.
- `workforce-membership-fence-guard.database.test.ts` (10, PGlite):
  - the writer's begin, commit and settle order, including a refused change;
  - refusal without a writer, or with an unconfirmed begin;
  - the guard on every row kind, the exact acknowledgement, what it leaves alone;
  - the pinned digest, the rollback and re-apply.

## 4. The remaining caller families (WP4)

`src/server/clinic-authority-families.ts`, with `src/server/clinic-authority-families.test.ts` (16). Every family's
server still takes the clinic from token custom claims, or is an identity-API route that `database_current` does not
serve. So under `database_current` each caller refuses before the token leaves the process. None was switched on.

| Family | Decision | What the caller answers |
| --- | --- | --- |
| encounter recording (authority, capture, drafting, transcription, cleanup review, cleanup execution) | refused | `AdapterError("unavailable")`, detail `membership_authority_not_configured` |
| calendar connection | refused | `CalendarWorkforceError(503)` |
| care messages | refused | 503 `membership_authority_not_configured` |
| patient notification settings | refused | 503 `membership_authority_not_configured` |
| program assignments | refused | 503 `membership_authority_not_configured` |
| Ask ALP workforce configuration | refused | `AdapterError("unavailable")` |
| privacy operations | refused | `membership_authority_not_configured` |
| lab attestation | refused | `lab_attestation_disabled`, decided with no request |
| consult (links, requests, records, retention, disputes, outcomes, carts, templates, intake) | refused | `ConsultWorkforceError(503, membership_authority_not_configured)` |
| synthetic boundary posture and invitations (found by the scan) | refused | `synthetic_clinical_core_unavailable` |
| campaign API | intentionally independent | its own authorizer; it never names or reads a clinic |
| the AWS clinical transport, telehealth visits and requests, program catalog observation | converted (earlier) | they send the selected clinic |

A source scan classifies every file that names a `/clinical-core/workforce/` route as converted, refused or not a Desktop
caller. A new caller fails until it is classified.

> **Later the same day:** care messages and program assignments are no longer simply refused. They are *gated*:
> converted in source on both sides and still refused unless the deployment pairs the family with a current-membership
> service. See `docs/program-messaging-membership-2026-10-15.md`.

## 5. Evidence

Failing-before runs copied the new tests (and any new pure module or test support they import) into a clean worktree at
the stated commit, then removed them. Raw output is in the session scratchpad, not the repository.

| Test file(s) | At | Before | After |
| --- | --- | --- | --- |
| `first-clinic-selection.test.ts` | `d1a1c333` | 6 of 9 fail | 9 pass |
| `workforce-membership-discovery.database.test.ts` | `d1a1c333` | cannot load (candidate and adapter absent) | 13 pass |
| `stale-tab-clinic-fence.test.ts` | `9b27cb3a` | 6 of 8 fail (the 2 that pass: preserved refusals, legacy) | 8 pass |
| `clinic-binding.test.ts` | `9b27cb3a` | module absent | 5 pass |
| `aws-telehealth-membership-fence.test.ts` + guard database test | `27f22373` | 70 of 79 fail (passing: the route list, unfenced-disabled, the Lambda check, and 6 guard cases on the copied candidate) | 79 pass |
| `clinic-authority-families.test.ts` | `ae6ff517` | 13 of 16 fail (passing: legacy, campaign independence, the file list) | 16 pass |

Local gates at `23de1d1a`:

- `tsc`, `eslint` on every changed file.
- The `src` suite: 9,366 passed, 2 skipped. The one date test that needs `TZ=America/Los_Angeles` (which `test:unit`
  sets) passes under it.
- The operation inventory: 228 operations, regenerated for shifted line numbers.
- `build:clinical` from an empty `.next`, then `check:clinical-bundle`: 342 client chunks, 21 server-only markers, none
  present.
- The CI script list: see the V2 return.

## 6. AWS packet for Codex

None of this has been performed. In order:

1. **SQL** (BLOCKED, unregistered, each with its rollback), on top of the unregistered current-membership setter
   (`workforce-current-membership-context.sql`):
   - `workforce-membership-discovery.sql` (SHA-256 `18d80262…36763d2`; rollback `13aa8e04…7d092d`);
   - `workforce-membership-fence-guard.sql` (`d3bb8638…96ff5ec`; rollback `9f5ddc40…e403280`).

   Register the guard only together with the fence writer. With the guard and no writer, every role change or
   suspension is refused.
2. **The fence table:**
   - string `pk` and `sk`;
   - on-demand, point-in-time recovery, the clinical KMS key, deletion protection;
   - no TTL: a fence item is never expired.
3. **IAM:**
   - the identity Lambda (production clinical API) gets `dynamodb:UpdateItem` on that table's items with leading keys
     `WORKFORCE_SUBJECT#*` and `CLINIC#*`, and nothing else on it;
   - the telehealth Lambda gets `dynamodb:GetItem` and `dynamodb:ConditionCheckItem` on the fence table only.
4. **Wiring:**
   - pass `createMembershipFenceWriter(send, table)` to `createAwsProductionDesktopAdapter(database, undefined,
     { membershipFence })` in `aws-production-clinical-lambda.ts`;
   - set `membershipFenceTable` in the telehealth handler's configuration.

   Neither is wired now, deliberately.
5. **API routes.** The production API template has 9 workforce routes. Missing for this block:
   - `GET /clinical-core/workforce/memberships/current` (first clinic selection);
   - `GET /clinical-core/workforce/consent-artifact` and `GET /clinical-core/workforce/consents/current`, which the
     telehealth visit writes read. They are also absent from the pilot allow-list.

   Header pass-through: `x-alp-selected-organization-id` from Desktop and telehealth.
6. **Identity parameters.** The pilot clinic id, the workforce issuer and audience as already configured. Under the
   pilot, posture answers only for the pilot clinic.
7. **Hosted revocation-race cases** (two sessions, a real table and database):
   - revoke while a slot publish waits after its posture read: refused, no slot;
   - revoke after a schedule's meeting creation: meeting deleted, request unlocked, 409;
   - revoke after a test-mode charge: refunded under the fixed key, request unlocked;
   - a stuck begin (writer killed between begin and settle): writes refused until an operator settles it;
   - the guard refusing an ad-hoc suspension without the acknowledgement;
   - a successful two-tab switch: the stale tab gets 409;
   - first sign-in with one, several and only pending memberships.
8. **Operator runbook.** To deactivate a clinic, identity or person: begin the fence for that clinic or subject, set the
   acknowledgement in the same transaction, commit, then settle.

## 7. Owner decisions

1. Accept the provider residual window: a provider call that starts just as a change begins runs and is then undone,
   never kept.
2. With the guard registered, an unfenced emergency suspension is refused. Accept that, or name a break-glass that
   begins the fence first.
3. A stuck fence keeps that member's (or clinic's) telehealth writes refused until an operator settles it. Accept, or
   name the alerting.
4. Charges that are still `processing` when a membership changes stay pending for reconciliation.
5. Whether telehealth visits are in the pilot scope, which needs the consent-artifact and current-consent routes
   (item 5 above).

## 8. Not done here

- Android pending-result recovery after the picker's activity is destroyed (`getPendingResultAsync`). It was not used
  before and is not added; noted in the V2 return.
- The legacy `legacy_claims` telehealth writes keep their unfenced race, as documented before.
- The families in section 4 are refused, not converted. Each needs its service converted together with its caller.
