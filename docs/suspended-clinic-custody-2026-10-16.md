# Suspended-clinic custody and access: decision packet (16 October)

**Status: design and BLOCKED source candidates.** Nothing here is approved, applied, registered or deployed. It does
not authorize PHI, production clinical activation, or any change to the reviewed
`legacy-claims-clinic-status.sql` (its file bytes and its rollback are pinned by two test files, its definition hashes by a third). Every row in every test
is fictional. PGlite and a throwaway local PostgreSQL 16 are the engines; neither is hosted Aurora evidence.

This is for Brandon and security counsel. It records the conflict between two owner directions and proposes a path. It
does not choose the semantics.

## 1. The two directions, and where they collide

The two owner directions (16 October):

1. Keep lawful practitioner access to patient records available. This includes the concern about **existing sessions
   after a clinic suspension**.
2. Block **new practitioner consent decisions** for a suspended clinic, while authorized cleanup processes existing
   withdrawals.

Direction 2 is now source (§5). Direction 1 conflicts with the BLOCKED status successor. That successor refuses every
workforce clinical read and write in a clinic that is not active, existing sessions included. A suspension is also the
only lever the source has against some compromised credentials (§3). "Keep existing sessions working after a
suspension" would therefore keep a stolen session working at exactly the moment someone decided to stop it.

The two requirements are distinct, and both apply:

- [HHS](https://www.hhs.gov/hipaa/for-professionals/faq/may-a-business-associate-of-a-hipaa-covered-entity-block-or-terminate-access/index.html):
  a business associate must keep the covered entity's ePHI available to it.
- The [Security Rule](https://www.hhs.gov/hipaa/for-professionals/security/laws-regulations/index.html): access controls
  limit ePHI to authorized persons.

Availability is owed to the covered entity, and it does not have to be delivered through the login that is under
suspicion. §6 proposes continuity paths that do not trust that login.

**The decision text for Brandon and counsel (exact):**

> D1. When a clinic is suspended or archived, a practitioner session already open in it:
>   (A) ends at its next request (the BLOCKED successor), and the covered entity's continued access to its patient
>       records is provided only by the custodial paths in §6, none of which uses a credential of the suspended clinic; or
>   (B) continues for a bounded time, which cannot tell a compromised credential from a legitimate one.
> Recommendation: (A), with §6 built before any clinic serving real patients can be suspended.
>
> D2. In a suspended or archived clinic, a practitioner recording a patient's **withdrawal** on the patient's behalf:
>   (A) is refused, like a new grant (workforce-consent-decision-clinic-status.sql as written; the patient's own
>       withdrawal stays open); or
>   (B) stays open, because it only narrows processing (a one-line change to that candidate, before review).
>
> D3. Recording cleanup of an already-withdrawn recording consent, in a suspended or archived clinic:
>   (A) stays refused (today's deployed behaviour, §4); or
>   (B) runs, but only after legal holds can be placed for a closed clinic by someone other than its own members (D4).
>
> D4. Who may place a legal hold on a closed clinic's records. Today, nobody can (§4).
>
> D5. A patient's request for copies of clinic-held records while the clinic is closed. The clinic-records candidate
> refuses it, because its actor check reads clinic status. Who fulfils it, and through which path in §6?

## 2. What the source actually defines

Traced from source on this branch. Each claim below is cited to its file.

| Term | Definition in source | Who sets it |
| --- | --- | --- |
| **suspended** (clinic) | `organizations.status` is `'suspended'`. The check is `('active','suspended','archived')`, in `20260812010000`. | `suspend_bootstrapped_workforce_clinic` only (BLOCKED `workforce-new-clinic-bootstrap.sql`). It requires an active platform operator, refuses self-approval, and works on bootstrapped clinics only. It also suspends the owner's membership. |
| **archived** (clinic) | `organizations.status` is `'archived'`. Every check treats it exactly like suspended (`status <> 'active'`). | **No writer exists.** There is no close-clinic operation in SQL, TypeScript or the routes. |
| reinstatement | — | **No writer exists.** The reinstate route answers 404 by test (`workforce-new-clinic-bootstrap.database.test.ts`). |
| ordinary account revocation | `organization_memberships.status` is `'suspended'`. There is no `removed` or `revoked` value. | `remove_org_member` (deployed): owner or admin only, refuses self-suspension, protects the last owner. The BLOCKED `revoke_workforce_membership` adds a reason. |
| emergency credential compromise | **Not defined.** There is no compromise flag, no session-revocation table, and no workforce disable path. | `identities.status` is `'disabled'`, written only by consumer identity deletion (`20260919020000`). Logout revokes only the current refresh token (`src/adapters/auth.server.ts`). |
| clinic closure | **Not defined** beyond `archived`, which has no writer. | — |

Two properties drive the matrix:

- **The database identity row is the immediate kill switch.** `set_request_context` (legacy) and the
  current-membership setter both refuse an identity that is not `active`, on the very next request, in every clinic
  and for every purpose (tested, §5). Cognito tokens already issued stay valid at API Gateway until they expire, and
  revoking a refresh token does not change that. No source writer disables a workforce identity.
- **Only one member-level lever exists, and it cannot reach the last owner.** `remove_org_member` refuses to suspend
  the sole owner. A compromised sole-owner credential can therefore be stopped only by suspending the clinic, which
  exists only for bootstrapped clinics. Direction 1 would leave even that stop unable to end the session.

## 3. The matrix

**Legacy claims (the deployed default).** A clinic is suspended or archived. Each cell gives the outcome at three
stages: deployed / with the status successor / with both successors. Evidence is in
`src/server/clinical-core/suspended-clinic-custody.database.test.ts` unless another file is named.

| Actor | Patient-record reads | New clinical writes | Consent decisions | Exports (patient copies) | Privacy fulfilment |
| --- | --- | --- | --- | --- | --- |
| **(a) a practitioner session open before the suspension** | gap / refused / refused | gap / refused / refused | gap / **gap** / refused | refused at all three stages: the clinic-records candidate's `care_connection_actor` requires an active clinic (read in source, not executed here) | not this actor's path |
| **(b) a new sign-in** | No clinic to select: `list_my_organizations` drops a non-active clinic, so the Desktop sends none. A token that already names the clinic behaves as (a). | as reads | as reads | as reads | — |
| **(c) a verified replacement credential** | No source path rebinds a person to a new subject (identities are unique per person and pool). Simulated by a direct rebind: the old subject is refused at once everywhere, and the new subject behaves as (a). | as reads | as reads | as reads | — |
| **(d) clinic owner or admin** | as (a): the gate is the clinic's status, not the role | as (a) | as (a) | as (a) | — |
| **(d′) platform operator** | no patient-record path exists at all | — | — | — | — |
| **(d″) assigned privacy operator** | — | — | — | — | runs at all three stages: decided by the assignment, not membership or clinic status (`unconverted-families-clinic-status.database.test.ts`) |
| **(e) retention service** | — | — | never calls the decision functions | export cleanup runs at all three stages; refused when its release is revoked or its identity is disabled | — |
| **(e′) recording cleanup operator** | — | — | — | **refused at all three stages by its own deployed check** (`recording_cleanup_operator` requires an active clinic), and so is placing a legal hold: **finding (§4)** | — |
| the patient (consumer) | own records: no candidate changes them | — | own grant and withdrawal run at all three stages | owned privacy export runs (consumer pool) | — |

**`database_current` (not activated).** The current-membership setter refuses all three purposes in a non-active
clinic (`workforce_membership_refused`), consent management included, before any operation runs
(`workforce-current-identity-consent.database.test.ts`, `legacy-claims-clinic-status.database.test.ts`). Privacy
operations, recording cleanup and the other unconverted families are refused at the Desktop before any token leaves
(`clinic-authority-families.ts`).

**Other events, both modes.**

- **Ordinary revocation (membership suspended):** refused on the next request for reads (row-level security uses
  `is_active_member`), writes and consent decisions. The token stays usable only until it expires, and nothing it
  reaches answers.
- **Compromise:** there is no source mechanism today. The levers that exist are membership removal (not for a sole owner)
  and clinic suspension (bootstrapped clinics only).
- **Closure:** behaves as suspension in every check, but nothing can set it.

**Custody (tested at every stage).** Neither candidate deletes or rewrites anything:

- patient records, consent history and audit events survive the suspension;
- reinstating the row (a direct write, since no writer exists) restores access.

## 4. Finding: cleanup of an already-withdrawn consent stops in a closed clinic

Direction 2 assumes authorized cleanup keeps running. It does for the retention service and assigned privacy
operators. It does **not** for the one cleanup that processes withdrawn consents asynchronously:

- **What stops.** Recording cleanup (`consent_revoked` intents). `clinical_private.recording_cleanup_operator`
  (`20260917150000`) requires `o.status='active'` along with an active membership and an operator assignment. In a
  closed clinic it refuses listing and **placing a legal hold** (both tested). Admission, runs and attempts call the
  same check (read in source).
- **Since when.** This is deployed behaviour, unchanged by either candidate (pinned in the custody test).
- **Why it is not repaired here.** Allowing deletion in a closed clinic while nobody can place a hold there would
  remove the only brake on an irreversible storage deletion, at the moment the clinic is under suspension. A repair
  must come with D4:
  1. a hold path for a closed clinic that its own members do not control;
  2. then cleanup limited to `consent_revoked` intents with no hold, by the assigned operator, with the clinic row
     share-locked;
  3. a separate BLOCKED successor pinned to the recording-cleanup parents.

  That is D3(B). It is not built.

**Correction to earlier documents.** The status successor's own header (byte-pinned, so not edited) and the
inventory's earlier decision text said:

- that erasure recovery, the care-data lifecycle and recording cleanup run under workforce `consent_management`;
- that those paths must keep deleting in a closed clinic.

In source:

- erasure recovery and the care-data lifecycle run in the **consumer** pool;
- recording cleanup already refuses itself in a closed clinic.

`docs/desktop-onboarding-authority-2026-10-16.md` §3 said only care messaging and the clinic list read clinic status
on the legacy path. `care_connection_actor` and `recording_cleanup_operator` read it too. The inventory text and that
document are corrected in this change.

## 5. What was built (WP2), source only

`infra/aws-clinical-core/source-candidates/workforce-consent-decision-clinic-status.sql`, BLOCKED, with its rollback:

- **The boundary.** It gates the workforce branch of `record_consent_grant` and `revoke_consent_grant`. That branch is
  the only place that knows the actor is a practitioner exercising a clinical role, so it can tell a decision from
  cleanup. The status successor's entry point (`set_request_context`) cannot, because both arrive as workforce
  `consent_management`.
- **The rule.** The connection's clinic must be active, read and share-locked in the operation's transaction.
- **The refusal.** The existing `consent_actor_refused`, which a non-member already receives. It reveals nothing
  about the clinic.
- **Unchanged.** The patient's own decisions, consent reads, the retention service, privacy operators, recording
  cleanup, and `legacy-claims-clinic-status.sql`.
- **Pinning.** Parent prosrc SHA-256 is `75d010fc…` (grant) and `0bb066f2…` (revoke). The successor is `89ebfcfc…`
  (grant) and `fafbcf48…` (revoke); the helper is `b0831b02…`. The full values are in the file and the test.
- **Guards.** It refuses a synthetic-staging schema and a drifted parent, applies once, and does not expose its
  helper to the API role.

### Evidence

| Check | Result |
| --- | --- |
| Failing before (stage 3 without the candidate) | 8 failed, 37 passed |
| Passing after | 49/49 |
| Native, `npm run qualify:consent-decision-native` | 5 scenarios, 19 checks, all passing |

The native evidence is `docs/evidence/2026-10-16-consent-decision-native-02e8c703.json`. Its scenarios:

- the status successor alone admits a practitioner decision before and after a suspension (the residual);
- an admitted decision holds off the suspension, and the next decision is refused;
- a decision waiting on a pending archival is refused, and so is its retry;
- the patient's own withdrawal and the retention sweep are not held back;
- a sibling clinic is not held back.

The synthetic schema has a separate BLOCKED successor (WP5), `synthetic-invitation-clinic-status.sql`. It refuses an
invitation issue or claim in a closed synthetic clinic. Its evidence: 16 PGlite cases, 5 native scenarios with 17
checks (`docs/evidence/2026-10-16-synthetic-invitation-native-3189977a.json`), and failing before at 4 failed, 3 passed.

## 6. A continuity path that does not trust the suspect login (design)

The aim is that the covered entity keeps access to its records while the credential, or the clinic, under suspicion
gets none. The path has four parts, in order of preference.

### 6.1 End the credential, not the clinic

Add a reviewed **workforce identity disable**:

- two people, a closed reason vocabulary, an append-only event, and the membership-fence acknowledgement;
- it sets `identities.status='disabled'`, which every request already checks on its next call (tested);
- with it, Cognito `AdminUserGlobalSignOut` then `AdminDisableUser` on the workforce pool, with IAM scoped to that
  pool.

The clinic stays active, other practitioners keep working, and the sole-owner case is covered. This needs a BLOCKED
SQL successor, an operator route behind the separate MFA sign-in, and an IAM change.

### 6.2 Verified replacement credential

The rebind:

- an operator verifies the person out of band;
- a new Cognito user enrolls MFA;
- an audited rebind event binds the new subject to the same person, and the old subject can never be rebound.

The practitioner returns to an active clinic on a credential the attacker never held. This needs a BLOCKED successor:
there is no rebind writer today, and the custody test simulates one.

### 6.3 Custodial access when the clinic itself is closed

A platform custodian, who is not a member of the suspended clinic:

- acts only on a named request from the covered entity;
- needs two-person approval;
- works read-only, on named patients, for a bounded time;
- has every access recorded in an append-only log.

The custodian fulfils record copies and transfers through the existing privacy-fulfilment shape (assignment-based,
like `owned_privacy_operator_assignments`), extended to clinic-held records. This answers D5.

### 6.4 Preserve

Records, consent history and retention holds are kept as they are (tested). A closed-clinic legal hold is placed by
the custodian (D4) before any cleanup decision under D3.

### Threat model

| Threat | How the design answers it |
| --- | --- |
| Stolen practitioner token and refresh token | 6.1 ends it at the next request. API Gateway still honours the stolen ID token until it expires, but nothing behind it answers. |
| Stolen sole-owner credential | 6.1. Membership removal cannot reach the last owner. |
| Malicious or fraudulent clinic | Suspension (status successor), with 6.3 for patients. |
| Insider with a valid credential after suspension | Status successor plus consent-decision successor (§5). |
| Race at the moment of suspension | The row lock, in both orders (native evidence). |
| Stale tab naming another clinic | The expected-clinic fence (`docs/clinic-authority-fences-2026-10-15.md`). |
| Compromised custodian | Two-person approval, named-patient scope, time limit, append-only access log, and no write path. |
| Replay of an earlier request after suspension | Refused before replay or version checks (tested). |

### Required evidence before any of this goes live

**Source (not done):**

- the identity-disable, rebind and custodial-access successors, each BLOCKED with a preserving rollback;
- PGlite and native two-session tests in both orders;
- the closed-clinic hold path.

**Hosted (Codex):**

- both successors applied to the qualification Aurora, never production;
- a four-persona probe through the deployed API with fictional rows:
  - an active practitioner whose clinic is suspended mid-session;
  - a disabled identity;
  - a rebound replacement;
  - the custodian;
- Cognito global sign-out observed against a token already issued;
- CloudTrail and audit-log readback.

**Human:** Brandon and counsel decide D1 to D5; a business associate agreement review of the custodial path.

## 7. What did not change

- `legacy-claims-clinic-status.sql` is `c3788dc2…7cc66`; its rollback is `4c311c01…b29a0`. Both are byte-pinned.
- The route-authority inventory still shows the four suspended-clinic `gap` cells. A BLOCKED candidate closes nothing
  until it is applied, so relabelling them would be the failure this inventory exists to prevent.
- No release switch, flag or manifest entry was touched.
