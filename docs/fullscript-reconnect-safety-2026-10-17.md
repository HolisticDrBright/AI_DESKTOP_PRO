# Fullscript reconnect safety: truthful states and no silent replacement

**Status.** This is source only. Fullscript stays off in every deployment: `FullscriptEnabled=false`, and the token and
fence tables are `disabled`. Nothing called Fullscript, AWS or Cognito. The evidence is unit tests with fictional
tables, tokens and accounts. The legacy-row migration in §4 is a proposal and was not run.

## 1. What was wrong (found by survey, confirmed in source)

| # | Defect | Where (before) |
| --- | --- | --- |
| 1 | **An outage read as "Not configured".** The status read caught every failure and answered `configured: false`. The card then showed "Not configured", a disabled Connect button and the setup steps, to a practitioner whose connection was fine. | `runtime.ts` posture `catch`, and the panel |
| 2 | **Reconnecting silently replaced a live connection.** The install overwrote any saved row for the same account and clinic. It did not revoke the old token, queue it or compare the Fullscript account. So a second tab or a direct call could swap in a *different* Fullscript account, and the replaced token stayed valid at Fullscript with no row left to revoke it from. | `connection-admission.ts` install |
| 3 | **A superseded row was overwritten and forgotten.** If moving a superseded row to the revocation outbox failed on read, a later reconnect overwrote it, and that token was never revoked. | the same |
| 4 | **Every callback failure was `connection_failed`.** The card read that as "Fullscript did not authorize this connection. Confirm the account…" for every cause: a replayed link after a success (shown beside "Connected"), an outage, another session, or a fence change. | `oauth/callback/route.ts` |
| 5 | **A failed revocation was a bare 500.** It came back as "Something went wrong", and no test covered it. | `disconnectFullscript` |
| 6 | **The reconnect text gave the email-key reason for both causes**, including a change in clinic access. | the panel |
| 7 | **"Reconnect required" from a provider action became a 500** rather than the reconnect message. | `action/route.ts` |
| 8 | **There was no in-flight state**, so Connect and Disconnect could be pressed twice. | the panel |

## 2. What it does now

**Status** (`fullscriptPosture`) gives three answers that are never confused:

| Situation | Answer | Card |
| --- | --- | --- |
| The deployment has no Fullscript | 200 `{configured:false, reason:"not_configured"}` | "Not configured" and the setup steps |
| Configured | 200, with what is saved: connected, ready, or `reconnectRequired` with `reconnectReason` (`account_binding` or `membership_changed`) | "Connected", "Ready to connect", or "Reconnect needed" with the matching reason |
| The status cannot be read | 503 with *"Fullscript's status couldn't be read right now. Nothing about your connection has changed. Try again in a moment."* | "Unavailable". Nothing is offered and no setup steps are shown. |

**A live connection is never replaced.**
- The callback refuses as `already_connected` before the nonce is spent or the code exchanged, so nothing is issued
  and nothing has to be revoked.
- The install refuses again inside its own logic (`FullscriptAlreadyConnectedError`). If a live connection appears
  during the exchange, the new token is revoked.
- Switching Fullscript accounts means disconnecting first. Disconnect revokes synchronously.

**A superseded connection is queued, not overwritten.** This covers a connection made before the clinic access
changed, and one saved before generations existed.
- The install writes it into the revocation outbox in the **same transaction** as the new row, in the outbox's own
  format (`fullscript-revocation/1`, pending, with the exact previous bytes).
- If the row changed after observation, the whole transaction cancels and nothing moves.

**Callback outcomes** form a closed set, and each one is a true statement:

| Outcome | What the card says |
| --- | --- |
| `connected` | (nothing) |
| `already_connected` | "Already connected … nothing was changed … disconnect first" |
| `link_used` | "Already used or expired, so nothing was changed" |
| `not_authorized` | The account guidance. This is the only outcome that blames the authorization: a declined consent, or a Fullscript 400 (`FullscriptGrantRefusedError`). |
| `session_changed` | "Started from a different account, clinic or session, so nothing was saved" |
| `unavailable` | "Couldn't be connected right now, so nothing was saved" |

Our own client being refused (401), a 5xx, or no answer at all is `unavailable`, never a claim about the account.

**Disconnect.**
- When Fullscript does not confirm the revocation, the connection is **kept** and the answer is 503 *"…your connection
  is still active. Try again."*
- When it changed mid-disconnect, the answer is 409 *"…changed while it was being disconnected. Refresh."*

**Actions.** A reconnect is a 409 carrying its own words. Anything else is 503 *"Fullscript is unavailable right now"*.
No provider error or token reaches the answer.

**The card** is built on one pure function, `fullscriptPanelState`, which the tests drive. It adds *Connecting…* and
*Disconnecting…* states and disables the buttons while a request is in flight.

## 3. Evidence

| Suite | Result |
| --- | --- |
| `src/server/fullscript/reconnect-admission.test.ts` (new) | 7/7: live / superseded / none observed; a live row refused with no write and the token unchanged; a superseded row queued in one transaction with its exact bytes; a pre-generation row queued; a row changed after observation cancels everything; a 400 is a refused grant, while 401/5xx/network are not |
| `src/server/fullscript/reconnect-callback.test.ts` (new) | 8/8: refused before the nonce or exchange; superseded allowed; a race refused with the token revoked; replay after success is `link_used` with one exchange; tampered link; declined and 400 are `not_authorized`; an outage is `unavailable`; every outcome has text, and every failure says nothing changed or was saved |
| `runtime.test.ts` (+4) | not configured reads nothing; reconnect reason; a revocation failure keeps the row; action error mapping with no token leak |
| `fullscript-presentation.test.ts` (+6) | an outage never shows "Not configured" or "Ready" and offers nothing; not configured; ready, connecting, connected, disconnecting; reconnect reasons; only `not_authorized` blames; the address-bar parse is a closed set |
| Existing Fullscript suites | All pass (32 files, 939 tests). |

**Updated expectations.** These changed to the new truthful outcome, and each still asserts that nothing was exchanged
or saved:
- `connection_failed` became `session_changed` or `link_used`;
- the outage payload became a 503;
- the disconnect race became `conflict`.

## 4. Legacy rows: migration and rollback proposal (NOT run)

**What exists today:**

| Class | How to recognise it | Current treatment |
| --- | --- | --- |
| Email-keyed rows | `sk FULLSCRIPT#sha256(org \0 email)` | Never claimed, refreshed, revoked or deleted. The account is asked to reconnect. **Its token is never revoked.** |
| Rows without `membershipGeneration` | The payload has no generation | Superseded. Moved to the outbox on first read, or by a reconnect (now in the same transaction). |
| Rows without `installationId`, `oauthClientId` or `oauthRedirectUri` | Optional fields absent | Readable, but refused for drafts |
| Outbox items | `sk FULLSCRIPT_REVOCATION#…` | Pending. **No reconciler is wired:** `reconcileFullscriptRevocations` is called only by tests, and the hosting role lacks `Query` and `UpdateItem`. |

**Proposal (Codex, isolated fictional qualification first):**

1. **Inventory, read-only.** Run `inventoryFullscriptConnections` per clinic against a PITR-restored *copy* of the
   table, never the live one. Output only counts and key fingerprints: no tokens, emails or subjects.
2. **A reviewed plan.** One line per row: `revoke_then_delete` (email-keyed, superseded), `keep` (current) or
   `refuse_for_drafts` (missing installation fields, left as is). Brandon or Codex review it. A plan is executable
   only through `executeReviewedFullscriptReconciliation`, which refuses an unreviewed plan.
3. **Execute per row, in this order:**
   - write an outbox item with the exact bytes, conditional on the row being unchanged;
   - revoke at Fullscript;
   - delete conditionally.

   A failed revoke leaves the item pending with its attempt counted, and the row is never deleted first.
   Prerequisites: `Query` and `UpdateItem` for the reconciler only, and a scheduled job. They ship together, or not at
   all.
4. **Rollback.**
   - Revocation cannot be undone at Fullscript. A revoked token is gone, which is the safe direction.
   - So a rollback restores the table from PITR into a **new** table for audit and comparison, never over the live
     one: restoring would bring back rows whose tokens are dead and would show "Connected".
   - Practitioners whose rows were revoked reconnect.
   - The migration writes no new fields, so the code needs no rollback.

## 5. Held, explicit

1. **A failed install after the provider issued a token is revoked best effort and not recorded.** If that revocation
   also fails, the token is orphaned at Fullscript. Recording it needs an outbox write that can itself fail; it is part
   of §4's reconciler.
2. **Email-keyed rows' tokens are not revoked** until §4 runs.
3. **There is no outbox reconciler, job or IAM.** Superseded tokens are queued, not revoked, until that ships.
4. **Owner decision, 2026-10-16: one Desktop account per Fullscript practitioner. Not implemented.** There is no
   uniqueness on `resourceOwner.id`, so two Desktop accounts can still connect the same practitioner. A safe release
   needs an atomic ownership reservation keyed by Fullscript practitioner ID, with a refusal before installation,
   a lost-reply/retry path, and a reviewed reconciliation for any existing duplicates. The current per-account
   reconnect repair does not enforce this cross-account rule.
5. **Whether the Cognito pool allows two accounts with one verified email is unread.** That is Codex's (the
   subject-binding doc).
6. **The status never asks Fullscript.** A token revoked at Fullscript by someone else still reads as "Connected" until
   the next action answers. Probing on every status read is a cost and rate decision.

## 6. Codex hand-back (not run)

1. Review §2 against the hosted install. The install's outbox `Put` needs `PutItem` on the token table, which is
   already granted. The fences' `ConditionCheckItem` is unchanged.
2. On the fictional sandbox stack, check each of these:
   - with the token table unreadable, the card shows "Unavailable", never "Not configured";
   - connecting again in a second tab is `already_connected`, with no token issued;
   - after a membership change, a reconnect queues the old row in the outbox;
   - a replayed callback URL shows "already used" beside "Connected";
   - with `/oauth/revoke` blocked, disconnect keeps the connection and says it is still active.
3. Then §4, on a restored copy only.
