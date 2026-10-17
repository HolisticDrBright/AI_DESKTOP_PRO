# A revoked practitioner login at the campaign engine

**Status.** Two parts, with different states:

- **The campaign API's read is in source and fails closed.** No release switch is involved. The staff route refuses
  every staff operation for a revoked subject, and refuses everything while it cannot read the signal.
- **The writer is BLOCKED.** It runs with the emergency revocation and its SQL successor. Nothing was applied,
  registered or deployed. No IAM grant, table or Lambda exists.

All the evidence is local: unit tests, PGlite and a fictional DynamoDB table. There is no hosted, AWS or Cognito
evidence.

## 1. The gap

The campaign engine has its own API, authorizer and store. It authorizes staff from two things only: the verified
token's claims, and its own role grants. It never reads the clinical identity row, and the separation tests require
that it never does.

So the emergency revocation, which disables that row, did not reach it. A practitioner login revoked for a suspected
compromise kept every campaign staff operation until its ID token expired:

- the practice's contacts, an export of names and addresses;
- templates and approvals;
- sequences and broadcasts;
- test sends;
- role grants.

Refreshed tokens kept it after that too, until Cognito disabled the user. The pinned test at `daaf6291` showed this:
`events-and-routes.test.ts::GAP pinned`, which returned 200 for the revoked login. The route inventory carried it as
`gap` in both authority modes.

## 2. The fix

### The reader: the campaign API

`src/campaigns/staff-revocation.ts` and `src/campaigns/http.ts`.

Before any staff operation, the staff route takes the token's `sub`. It reads one item by that subject from the
campaign stack's own table, `alp-campaign-staff-revocations`. The read is strongly consistent, with a 3-second timeout.

| Signal | Result |
| --- | --- |
| An item for the subject (any item, even a malformed one) | **403** `identity_refused`, whatever practice or person the token names |
| No item | The request goes on, under the engine's own role checks |
| The read fails, times out or throws anything | **503** `staff_revocation_unavailable`. An outage never reads as "not revoked". |
| No signal configured (`CAMPAIGN_STAFF_REVOCATION_TABLE` unset) | **503** `staff_revocation_unconfigured` |
| A missing or malformed `sub` | **403**, without reading the signal |

**Every way in.** The engine's staff handler takes a practice and a person, never a subject, and reads no revocation.
Outside its own definition it is built in only two places: the HTTP route and the fictional test engine (a test scans
`src` for this). The Desktop's `/api/live/campaigns` forwards the bearer token to that route over HTTP. So every staff
operation passes the check.

**The public routes never read the signal:** sign-up, confirm, unsubscribe, the join page and signup-open. A
subscriber is never turned away by it.

**What it does not touch.** The campaign API holds no clinical credential and reads no clinical store. It reads one
item by subject, with `dynamodb:GetItem` on that one table. The separation tests still pass, with their DynamoDB
allow-list naming the new table. They also now assert that only the API role may touch that table, and only with
`GetItem`.

### The writer: the emergency revocation

`src/server/clinical-core/staff-revocation-signal.ts` and `workforce-identity-revocation.ts`.

After the revocation's commit, the operator service publishes the signal **first**, then runs AdminDisableUser and
then AdminUserGlobalSignOut:

- One failing step never stops the next.
- A signal outage never delays the database refusal or the Cognito steps.
- A Cognito outage never delays the signal.

The item holds the subject (an identifier), the revocation's id and the contract (`staff-revocation-signal/1`). It
holds no token, email or name. It is written with `attribute_not_exists`:

- A retry, or a later revocation of the same login, finds it there and succeeds without changing it.
- Nothing here ever deletes or overwrites it. A revoked login is never restored; a replacement credential is a new
  subject.

The two code paths share no module. An integration test runs the writer and the reader against one fictional table:
`src/integration/staff-revocation-signal.test.ts`.

**Superseded in part (2026-10-17): staff-revocation-signal/2.** The revocation item above is unchanged. A second,
pending item under `pending#<subject>` is now written as the decision starts, so an old token is refused from before
the commit. See `docs/revocation-signal-timing-2026-10-17.md`, which also states what still cannot be closed.

### The successor: the signal becomes a recorded step

`infra/aws-clinical-core/source-candidates/workforce-revocation-campaign-signal.sql` (BLOCKED), with a preserving
rollback.

**Failing before.** Under the emergency revocation alone, a failed publication was recorded nowhere. The database
refuses the `campaign_signal` step. Once both Cognito steps succeeded, the revocation read `complete` and left the work
list, so no reconciliation ever retried the publication.

**The successor changes three things:**

1. The step check admits `campaign_signal`.
2. The recorder accepts it exactly as it accepts the other two steps.
3. The summary reads `complete` only when all three steps last succeeded, and `failed` when any last failed.

The work list is unchanged, so it now keeps a revocation until its signal is confirmed. A revocation that completed
before the successor was applied returns to the work list, and the next reconciliation publishes its signal: that is
the backfill.

**Kept:** signatures, owner, `SECURITY DEFINER`, `search_path` and grants. Records stay append-only.

**The rollback:**

- It restores both parents byte for byte.
- It keeps every row and the widened check, so the successor can be applied again over it.

### The template

`infra/campaigns/campaign-engine.json` declares:

- the table: keyed by `subject`, retained, deletion-protected, point-in-time recoverable, and encrypted with the AWS
  managed key, never the campaign key;
- the API role's `GetItem` on it;
- the API function's `CAMPAIGN_STAFF_REVOCATION_TABLE`;
- an output of the table's ARN, for the writer's grant.

The sender and events functions get nothing.

## 3. Threat model

| Threat | What happens |
| --- | --- |
| Revoked login, unexpired ID token | Refused on its next staff request, for every operation (read, export, edit, approve, send, schedule, sequence, grant). Nothing is read, changed or sent (unit). |
| Refreshed token after the revocation | Same subject, so it is refused the same way. |
| Token naming another practice or person | Refused: the signal is about the login. |
| A colleague in the same practice | Unaffected. |
| Signal store down or slow | 503, nothing changed (unit). |
| Signal not configured | 503 for staff. The public routes are unaffected. |
| Missing or malformed `sub` | 403, and the signal is not read. |
| Publication fails | The step is recorded `failed` and stays on the work list until a reconciliation confirms it (PGlite, with the successor). |
| Publication lost after a Cognito success | Recorded as above: the item is not `complete` without the signal. |
| Revocation recorded before the successor | It returns to the work list and is published at the next reconciliation (PGlite). |
| A malformed or foreign item in the table | Read as revoked (unit). |
| Overwrite or delete of an item | Not done by any code here. The writer is `attribute_not_exists`, and the reader's grant is `GetItem` only. |
| A staff request already in flight when the signal lands | It completes. Every later request is refused. This is the same bound as the database's own revocation, where an admitted request finishes first. |

## 4. Evidence

| Kind | Result |
| --- | --- |
| Unit (`src/campaigns/staff-revocation.test.ts`) | 16/16. The engine alone serves a revoked login, and only the route builds the handler. Then: every operation refused with no change, the store never reached, refused on the next request, any practice or person, a colleague unaffected, outage and unconfigured 503 with no change, any throw 503, malformed subjects never read, the public routes with the signal down or absent, the DynamoDB adapter (key, consistency, any item, errors and timeout), the runtime setting, the template. |
| Publisher unit (`staff-revocation-signal.test.ts`) | 4/4: the conditional put, already-there is success, closed failure codes with no message, malformed input never written. |
| PGlite (`workforce-revocation-campaign-signal.database.test.ts`) | 9/9: the failing-before, the pin and an exact diff, parent-only apply with grants and rows kept, backfill, signal first with outage and reconcile, Cognito outage, the state rules, append-only, and the rollback (exact, rows and check kept, reapply, then the revocation's own rollback). |
| Integration (`src/integration/staff-revocation-signal.test.ts`) | 2/2: one contract; the writer's item stops the reader's route; a second publication changes nothing; nothing personal is held. |
| Existing suites | Campaign and outreach (13 files) pass, including both separation suites. The route inventory passes with both campaign `compromised_identity` cells moved from `gap` to `refused`. |

No native two-session run applies. The successor changes no lock or entry, and the campaign side is DynamoDB.

## 5. Identities

| Artifact | SHA-256 |
| --- | --- |
| `workforce-revocation-campaign-signal.sql` | `b8d5e9b1332e8804e0a23223884b1870b87d9fa08078743b2b0922c32caebeb8` |
| `workforce-revocation-campaign-signal-rollback.sql` | `edfc76fd7d767f2704da087040558f1969b3afa57d82f8a640ded7ff01286add` |
| Summary prosrc, successor (parent) | `da11a53c05619318ccb6e88af3f7c51a9b48f7d3bef3acac34cb2c6ac78f9fe6` (`775819dd791c2df318aaa18544ba7bd0ea12a9c9749dba68e81943146904a4a7`) |
| Recorder prosrc, successor (parent) | `8eab347a286520a0619681dc895ea9a216fbb25d4653b4b1e8f47ec7e2b3d458` (`60817476eca810cd704937eb2df836dcb69b4fe4986eb0db81d65d52aad0f3d6`) |

**Parent:** `workforce-identity-emergency-revocation.sql` as written. The successor does not read `set_request_context`,
so it sits beside the ordinary-suspension window and the consent candidates in any order. Roll it back before the
emergency revocation's own rollback, which removes both functions.

## 6. Held, explicit

1. **Owner decision, 2026-10-16: pause sends already queued by a revoked login for another authorized staff member's
   review. Now in source:** `docs/campaign-send-authority-2026-10-17.md` (send-authority/1). The sending job re-reads
   every recorded login before each SES call; legacy records are held; a different, unrevoked staff member resumes a
   held send through an audited review. One race remains: an email already handed to SES. The interval between the
   clinical database revocation commit and signal publication is `docs/revocation-signal-timing-2026-10-17.md`. No
   post-publication route test here proves immediate revocation.
2. **The writer must be configured wherever campaigns run, and only with the successor applied.** Configured on the
   parent alone, a publication still happens but is not recorded (the failing-before). Not configured under the
   successor, revocations never read `complete`. That case is visible on the work list, never silent.
3. **The backfill reaches the 200 most recent proposals**, the work list's own window.
4. **Writer infrastructure:** the operator host's `PutItem` on the table alone, and the Lambda or route host the
   revocation itself still lacks. This is Codex's.
5. **The 3-second read timeout and per-request read** are source constants. There is no cache, so an outage costs
   staff access, never authority.

## 7. Codex hand-back (ordered, not run)

1. Review the reader. It is live in source the moment the campaign stack is applied with `CampaignEngineEnabled=true`.
   Until then nothing changes: the engine ships off.
2. In a fictional qualification account, apply the campaign template and confirm:
   - the table's properties;
   - the API role's single `GetItem`, and the sender role's (send-authority/1);
   - nothing for the events role;
   - the staff route answers 503 when the table is unreadable.
3. With the emergency revocation on isolated fictional qualification Aurora:
   - apply this successor;
   - grant the operator host `PutItem` on the table alone;
   - revoke a fictional login and confirm its next campaign staff request is 403;
   - take the table away and confirm that the revocation still lands at once, that the item is `failed` on the work
     list, and that a reconciliation completes it.
4. Roll back. Confirm both parents byte for byte and every row kept.
