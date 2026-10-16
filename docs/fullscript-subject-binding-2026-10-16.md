# Fullscript beyond installation: the account-bound key, race orders and held actions (16 October)

**Status:** source only. Fullscript stays disabled in every deployment, production Fullscript is not approved, and lab
ordering stays off. Nothing here deploys a table, an IAM change, a provider credential or a release switch. Fictional
accounts and tokens only, and no token is logged.

## 1. Codex's callback repair: reviewed, then integrated

| Item | Value |
| --- | --- |
| Branch | `agent/fullscript-revocation-evidence-20261016` at `e08df97fb5b5f871ced5b393526b9f63c4c4e83e` |
| Base | Desktop `3c863b7b` |
| Exact-head CI | [38955809006](https://github.com/HolisticDrBright/AI_DESKTOP_PRO/actions/runs/38955809006), **success**, attempt 1 |
| Failing before | Codex's test files against the parent `3c863b7b`: 7 failed, 61 passed (four files) |
| Passing after | the focused Fullscript suite at `e08df97f`: 26 files, 882 tests |

The tests that fail at the parent fall into two groups:

- **Two defects:** a provider token installed after membership was revoked during the code exchange, and another
  account with the same address completing the starter's callback.
- **One intended contract change:** signed state version 2. A test of a refused unfenced write is in this group too.

The branch was integrated into `claude/desktop-major-source-20261016` by a merge commit (`b56e3bb0`). Nothing was
cherry-picked or rewritten, and none of its callback files were redone. The merged tree passed the inventory and
Fullscript suites: 27 files, 1,039 tests.

**What Codex's note already says, and still holds:**

- The installation fence is conditional on the BLOCKED membership-fence guard, every authority-reducing writer
  beginning the fence, the fence table and its IAM, all released together.
- Reads, refreshes and actions on an existing connection are separate paths that the fence does not certify.

This document is about those paths.

## 2. The defect found in review: the key was the email address

`fullscriptActor()` derived the token-row key from the clinic plus the lower-case email. Two distinct workforce
accounts with the same verified address in the same clinic, both current members, therefore shared one row:

- account B saw account A's connection as its own;
- B searched the catalog with A's Fullscript token;
- B's Disconnect revoked A's authorization at Fullscript and deleted A's row.

The cases this can happen in include a re-created account, an alias, and a second sign-in method for the same mailbox.

Signed state v2 binds a *new* callback to the starter's subject. It does not isolate reads of a row that is already
saved.

**Failing before.** `src/app/api/live/fullscript/subject-binding.test.ts` was run against the integrated tree before
the repair: **9 failed, 4 passed**. The 4 that passed are the control and three coverage cases.

## 3. Repair

**The key is the account.**

- `fullscriptActor()` derives the key from `fullscript-actor/2`, the clinic and the ID token's Cognito subject.
- The versioned label means no subject key can equal an email key.
- A session without a subject is refused before any read.
- Codex's admission, callback and draft-credential binding all take their key from this function. They are
  account-bound without further change, and the signed state's `actor` now names the account too.

**An older email-keyed row is never claimed.**

- If no row exists under the account's key but one exists under the old email key, status answers
  `connected: false, reconnectRequired: true`, and the panel says why. Actions answer "Reconnect Fullscript".
- The old row is never used, refreshed, revoked or deleted by any account, because nothing in it says which account
  made it.
- Reconnecting installs a new row under the account's key.
- The old rows are left for the reviewed migration in §6.

**The authority is read again after Fullscript answers.** The action route re-reads the account's current clinics
after the provider call and before returning. A membership removed, or a clinic suspended, while Fullscript was
answering therefore withholds the catalog result or treatment-plan link: nothing from the provider call leaves the
server.

**Lab checkout is held.**

- `create_lab_checkout` commits a treatment plan at Fullscript. No local transaction can fence that commit, and
  nothing here undoes it.
- It is refused before any token is read, refreshed or sent, whatever `FULLSCRIPT_LAB_ORDERING_ENABLED` says. The
  hosting template still pins that flag to `false`.

**Passing after:**

- `subject-binding.test.ts`: 13/13;
- the Fullscript route, server, panel and inventory suites: 28 files, 1,052 tests;
- typecheck and lint are clean.

The three older suites built their fictional sessions with a non-JWT token string. Those fixtures now carry a
fictional ID token with a subject, and no assertion changed.

## 4. Survey of `src/app/api/live/fullscript/`

| Route and action | External effect | Before admission (membership or clinic changed) | While the provider call is in flight | Classification |
| --- | --- | --- | --- | --- |
| `status` | none (row read) | refused before the row is read (`clinic-authority.test.ts`) | no provider call | guarded |
| `action` `search_products`, `search_labs`, `lab_order` | provider read | refused before the row is read | **result withheld** (tested for products) | guarded by the post-call re-read |
| `action` `new_treatment_plan_link` | provider issues a link; the plan itself is made in Fullscript's own UI under Fullscript's authority | refused before the row is read | **link withheld** (tested) | guarded by the post-call re-read |
| token refresh, inside any action | provider rotates the refresh token (irreversible but benign) | refused before the row is read | the rotated token is saved only by the conditional `replace`; the result is withheld (tested) | guarded; see §6 for a lost rotation |
| `action` `create_lab_checkout` | **provider commits a treatment plan** | refused before any token use | not reachable | **held** (tested, distinct negative case) |
| `disconnect` | provider revocation, then row delete | refused before the row is read | revocation and delete complete (privacy-protective; tested) | intended |
| `oauth/start` | none | refused before the state is signed | — | guarded |
| `oauth/callback` | provider code exchange, then token install | Codex: refused before the exchange | Codex: fenced install transaction; provider revocation on a failed install | conditional on the BLOCKED fence guard |

A clinic suspension reaches the Desktop as the clinic disappearing from the account's current clinics. Under
`legacy_claims`, `list_my_organizations` omits a non-active clinic. So "removed" and "suspended" are the same
observation here, and the tests name both.

## 5. Residuals (not repaired here)

- **A removed member's row stays in DynamoDB.** Membership removal does not delete or revoke the Fullscript row. If the
  member is re-added later, the connection comes back. The membership-change writer should begin a revocation, or at
  least a reconnect requirement, for that clinic and account. This needs the fence writer, which is BLOCKED.
- **The post-call re-read narrows a race; it does not linearize it.** A removal that commits after the re-read and
  before the response is written is not caught. The answer is read-only data or a link, and the next request is
  refused.
- **Provider-side state from a read is not compensated.** For example, a link issued and never used is Fullscript's to
  expire.
- **Untested against the real stack.** Nothing was run against hosted DynamoDB transactions, the Fullscript sandbox,
  or the Cognito pool. In particular, whether the pool allows two accounts with one verified address is a pool setting
  that Codex should read.

## 6. Provider-side reconciliation plan (for Codex; nothing here runs it)

1. **Email-keyed rows.**
   - Inventory every `FULLSCRIPT#<hash>` row whose payload `actorKey` is not an account key: no account-bound
     installation exists for it, and its connection predates this change.
   - For each row, a reviewed operator revokes the token at Fullscript, using that installation's own client, and
     deletes the row. Both steps are recorded in an append-only log with the row's clinic, `resourceOwner.id` and
     `connectedAt`, never the token.
   - The practitioner reconnects.
   - Never re-key a row onto an account.
2. **A failed install after the provider issued a token.** The callback already attempts revocation. If that attempt
   fails, record a reconciliation item (installation id, clinic, time, no token). An operator then revokes it at
   Fullscript.
3. **A lost refresh rotation** (the provider rotated, and the conditional `replace` lost to a concurrent disconnect or
   reconnect). The old token is dead and the new one was never saved. That is availability, not exposure. The
   practitioner reconnects. Report the count, never the tokens.
4. **Lab checkout, before it could ever be released:**
   - an idempotency key bound to the patient, test and practitioner;
   - a durable outbox row written before the provider call and fenced like the installation;
   - a reconciliation job that lists Fullscript treatment plans by that key and cancels any whose outbox row did not
     commit.

   Until all of that exists, the action stays held.

## 7. Hosted evidence Codex still needs

With fictional accounts on an approved, reviewed target:

- two Cognito accounts with the same verified address, if the pool allows it, in one clinic: each sees only its own
  connection, and each Disconnect revokes only its own;
- an email-keyed row left by the deployed build: `reconnectRequired`, with no provider call;
- removal and suspension during a sandbox catalog search: no result returned;
- the refresh race against a real conditional write;
- the lab-checkout refusal with the flag forced on.
