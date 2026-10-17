# One Desktop account per Fullscript practitioner, and the revocation reconciler

**Status.** Source only. Fullscript stays off in every deployment (`FullscriptEnabled=false`, token and fence tables
`disabled`), and lab checkout stays off. Nothing called Fullscript, AWS or Cognito. The reconciler is BLOCKED three
ways, and its template deploys nothing. The evidence is unit tests over fictional tables, accounts and tokens.

**Owner decision (2026-10-16, Brandon).** A Fullscript practitioner account connects to one Desktop account.

## 1. What was wrong

| # | Defect | Before |
| --- | --- | --- |
| 1 | **Nothing tied a practitioner to one Desktop account.** A second account, in another clinic or the same one, installed a connection to the same Fullscript practitioner, and both used it. Two accounts racing each other both connected. | `connection-admission.ts` install: no cross-account check |
| 2 | **A token issued but refused at install was revoked best effort and not recorded.** If that revocation failed, the token stayed valid at Fullscript with nothing here to revoke it again. | the callback's `catch` (reconnect doc §5.1) |
| 3 | **A lost install reply was a failure.** The callback then revoked the token, which may have just been saved. | the same |
| 4 | **Nothing drained the revocation outbox.** `reconcileFullscriptRevocations` was called only by tests, no role could query the outbox, and no job existed. Superseded tokens stayed valid at Fullscript. | reconnect doc §5.3 |

**Failing before** (each test run against `a269552f`):
- `practitioner-ownership.test.ts`: a second account in another clinic, a colleague in the same clinic, and a racing pair are all installed ("promise resolved instead of rejecting"; two fulfilled).
- `practitioner-ownership-callback.test.ts`: the second account's callback answers `connected`, where it should answer `practitioner_connected_elsewhere`.
- Reconciler: `git grep` at `a269552f` finds `reconcileFullscriptRevocations` only in `membership-generation.ts` and its test, and no Fullscript role with `dynamodb:Query`.

## 2. The ownership reservation (`fullscript-owner/1`, `practitioner-reservation.ts`)

**One item per practitioner, in the token table.**
- **Key:** `pk FULLSCRIPT_OWNER#<sha256(fullscript-owner/1, environment, resourceOwner.id)>`, `sk OWNER`. It holds a fingerprint, never the raw provider id. The sandbox and production are separate reservations.
- **Body:** the owning row's key (`ownerPk ORG#<clinic>`, `ownerSk FULLSCRIPT#<account key>`), the `connectedAt` it was taken for, and `reservedAt`. No token.

**Taken in the install's own transaction.** The TransactWrite now holds:
1. both fence checks;
2. the superseded row's outbox item, if any;
3. the reservation Put, with condition `attribute_not_exists(pk) OR (ownerPk = :ownerPk AND ownerSk = :ownerSk)`;
4. the token row, last.

So a reservation held by another account cancels the whole transaction: the second token is never saved, and the first connection is byte-identical. The cancellation's reasons say which condition refused:
- the reservation → `FullscriptPractitionerConnectedElsewhereError`;
- the token row → `FullscriptAlreadyConnectedError` (the account racing itself);
- anything else → unavailable.

**A lost reply is not a guess.**
- The transaction carries a client request token (the installation id). DynamoDB applies it at most once, so one retry is safe.
- If the retry is inconclusive too, the row is read back. This exact installation saved is a success; anything else is `FullscriptInstallUnconfirmedError`.
- Definite refusals (validation, access, throttling, conflict) are never retried as if lost.

**Released only for the exact connection it names** (`ownerPk`, `ownerSk` and `connectedAt` all match):
- **by a confirmed disconnect,** in the same transaction as the row delete (`token-store.ts`). A reservation naming another connection (an older duplicate, a transfer) is left alone, and the row is deleted by itself on its exact bytes. A disconnect Fullscript does not confirm keeps both, as before;
- **by the reconciler,** once Fullscript confirms a queued token's revocation, in the same transaction as the settle;
- **never by a membership change.** A superseded or queued row keeps the practitioner until its token is confirmed revoked. The same account reconnecting renews its own reservation. A later confirmed revocation of its older token cannot release the renewed one, because `connectedAt` differs.

## 3. The callback

Which practitioner a token names is known only once the code is exchanged. So the refusal comes from the install, after Fullscript has issued a token. Every issued-but-unsaved token is **queued in the outbox before it is revoked** (`install_refused`, `practitioner_connected_elsewhere`). Then it is revoked:
- confirmed: its item is removed;
- not confirmed: the item stays pending for the reconciler.

Only when the outbox write itself fails is the revocation best effort. That is logged without the token, as the one remaining way to orphan it.

**An unconfirmed install** is queued as `install_unconfirmed` and **not** revoked inline. The reconciler revokes it only if no saved connection holds it.

New outcomes in the closed set:

| Outcome | What the card says |
| --- | --- |
| `practitioner_connected_elsewhere` | "That Fullscript account is already connected to another Desktop account, so nothing was saved here and that connection was not changed. A Fullscript account connects to one Desktop account: disconnect it there first, or ask support to move it." |
| `unconfirmed` | "Fullscript's answer was lost on the way back, so we can't yet say whether this connected. Refresh in a moment: if it shows Connected, it worked; if not, nothing was saved." |

## 4. Transfer, and existing duplicates (`practitioner-ownership.ts`)

**Transfer is explicit, reviewed and BLOCKED** (`FULLSCRIPT_OWNERSHIP_TRANSFER_RELEASE = 'blocked'`).
- It refuses while the current owner's row exists, live or superseded. It requires that connection's outbox item first.
- It replaces the reservation only if it is still exactly the one read (`reservedAt`). The reservation then names the target account with `connectedAt: null`, so only that account can install next.
- It writes an append-only audit item in the same transaction.
- Nothing ever transfers implicitly: without it, every other account is refused.

**The inventory is read-only** (`inventoryFullscriptPractitionerOwnership`).
- It runs across clinics, on rows read from a PITR-restored copy.
- It reports collisions (one practitioner under two or more accounts) as a group label, row fingerprints and counts. It also counts unreserved rows (installed before reservations) and stale reservations.
- It reports no token, provider id, clinic or account key.
- The per-clinic `inventoryFullscriptConnections` is unchanged. Duplicates span clinics, so they need this one.

**The reconciliation is reviewed and never picks a winner** (`executeReviewedFullscriptOwnershipReconciliation`).
- It refuses unless every collision has exactly one operator decision: the row that keeps the practitioner, or none. The signed digest must also cover exactly this inventory and these decisions.
- Then every other row of the group moves, unchanged, into the outbox (`duplicate_practitioner`). The kept row and each unreserved row are reserved, and the outbox is reconciled.

## 5. The reconciler (BLOCKED)

**Worker.**
- `runFullscriptRevocationReconciler` (`revocation-reconciler.ts`) is one pass over the outbox's queue index across every clinic, at most 50 items.
- **Confirmed before settled.** A token a saved connection holds is never revoked; its item is discarded.
- **Retry.** A failure keeps the token, counts the attempt and backs off: 5 minutes, doubling, at most a day.
- **Reporting.** The summary carries counts plus, per failure, a fingerprint, its outcome and attempts. It never carries a token. An item that has failed 8 times is `stuck`, and the Lambda then fails after logging, which is what the error alarm watches.

**Lambda** (`lambda/revocation-reconciler.ts`). It is closed unless both the source constant and its environment say `qualification`. Closed, it builds nothing.

**Queue index.** Outbox items now carry `revocationQueue`/`nextAttemptAt` and leave the index once revoked. The index is `RevocationQueue`, KEYS_ONLY, so it holds no token. It is defined in `fullscript-connector-extension.json` behind `RevocationQueueIndex`, which defaults to `disabled`.

**Deployment** (`infra/aws-clinical-core/fullscript-revocation-reconciler.json`).

The locks:
- `ReconcilerRelease` accepts only `BLOCKED`, and every resource is conditioned on `RELEASED`, so the template deploys nothing;
- the function environment says `blocked`;
- the schedule state accepts only `DISABLED`;
- the environment is sandbox only.

The role, exactly:

| Action | Resource |
| --- | --- |
| `dynamodb:Query` | `table/${TokenTableName}/index/RevocationQueue` only |
| `dynamodb:GetItem`, `dynamodb:UpdateItem`, `dynamodb:DeleteItem` | `table/${TokenTableName}` |
| `secretsmanager:GetSecretValue` | the client-id and client-secret ARNs |
| `kms:Decrypt` | the clinical key |
| `logs:CreateLogStream`, `logs:PutLogEvents` | its own log group |

There is no Scan, PutItem, batch or wildcard. The hosted Desktop role is unchanged: Get, Put and Delete only, and still no Query.

## 6. Evidence

| Suite | Result |
| --- | --- |
| `practitioner-ownership.test.ts` (new) | 19/19: refused across clinics and within one; fingerprint-only reservation; environment scoping; two-account race ×6; self-race; idempotent retry; lost reply confirmed; unconfirmed committed or not; renewal over a superseded row; queued-row hold until confirmed revocation; no release of a renewed reservation; disconnect releases atomically; older duplicate keeps the other's reservation; transfer blocked, refused while live, moved only to the named account; inventory without secrets; unreviewed or undecided plan refused; reviewed decision executed |
| `practitioner-ownership-callback.test.ts` (new) | 7/7: refused end to end with queued-then-revoked order and first row byte-identical; revoke failure leaves a pending item; outbox failure still revokes and logs without the token; colleague refused, then connects after disconnect; unconfirmed disconnect keeps the practitioner taken; lost install reply is `unconfirmed`, queued, not revoked; card text |
| `revocation-reconciler.test.ts` (new) | 12/12: BLOCKED in source, Lambda builds nothing; two-secret build still closed; cross-clinic pass settles only on confirmation, no token in receipts; backoff; in-use token never revoked; reservation released only for its exact connection; stuck and bounded report; unrecorded settle; template's exact permissions; hosting role unchanged; queue index off and KEYS_ONLY |
| Updated | `connection-admission.test.ts`: the fixture now names a cancellation as DynamoDB does, and the write list includes the reservation (4 writes). `token-store.test.ts`: the disconnect is a transaction with the exact-bytes condition and the release condition, plus a new case for a reservation naming another connection. `membership-generation.test.ts`: types only. Every assertion is kept. |
| All Fullscript suites | 35 files, 978 tests pass. `tsc --noEmit` clean. ESLint clean on changed files. `check:aws-desktop-hosting`, `check:aws-provider-configuration` and `check:aws-desktop-operation-inventory` pass. |

## 7. Residual races and holds (not closed)

1. **Rows saved before reservations hold none.** Until the reviewed plan runs, a second account can still connect a practitioner whose only connection predates this change. The plan reserves them; it needs the restored-copy inventory first.
2. **Outbox write and revocation both fail.** The issued token is orphaned. This is logged without the token.
3. **Revocation confirmed, settle lost.** The item stays pending, and the next pass asks Fullscript to revoke an already-revoked token. RFC 7009 says that answers 200; Fullscript's actual answer is **unverified**. If it errors, the item becomes `stuck` and the alarm fires.
4. **An unconfirmed install still in flight after the read-back.** If it commits after the reconciler's `holds` check and before the revoke, a live connection's token is revoked. That connection fails visibly and is recoverable by disconnect. The window is one reconciler pass after a doubly failed install.
5. **Items queued before this change carry no queue attribute.** The index never finds them; only the per-clinic `pending` path does. Fullscript was never enabled, so none are expected. The read-only check is in §8.
6. **The reconciler can read token rows.** It must, to know whether a token is in use, and IAM cannot restrict GetItem by sort-key prefix.
7. **A transferred reservation nobody installs** blocks that practitioner for everyone else until another reviewed transfer. This is intended.
8. **Email-keyed rows** (reconnect doc §4) still hold no reservation and are unrevoked until that migration.
9. **A token revoked at Fullscript by someone else** keeps its reservation until a Desktop disconnect (reconnect doc §5.6).

## 8. Codex hand-back (ordered, not run)

1. Review §2 against the hosted install. It needs no new permission: the reservation is a Put and a conditional Delete on the token table, both already granted.
2. On the fictional sandbox stack, with two fictional Desktop accounts and one fictional Fullscript sandbox practitioner:
   - the second account's callback shows "already connected to another Desktop account";
   - the first account's row is unchanged;
   - the outbox item for the second token is removed once Fullscript confirms its revocation;
   - with `/oauth/revoke` blocked, the item stays pending.
3. Read-only, on a PITR-restored copy of the token table:
   - count `FULLSCRIPT_REVOCATION#` items without `revocationQueue` (expected 0);
   - run `inventoryFullscriptPractitionerOwnership` and return counts and fingerprints only.
4. **One reviewed change, never separately:**
   - enable `RevocationQueueIndex` (a GSI addition on the existing table);
   - add an esbuild entry for `src/server/fullscript/lambda/revocation-reconciler.ts` like `scripts/build-campaign-engine.mjs`;
   - set `ReconcilerRelease`'s allowed values, the function's release variable and `FULLSCRIPT_REVOCATION_RECONCILER_RELEASE` to the qualification value;
   - qualify on the sandbox with the schedule `DISABLED`, invoking by hand.
5. Confirm Fullscript's answer to revoking an already-revoked token (residual 3).
6. Only after Brandon's review: the duplicate plan, executed through `executeReviewedFullscriptOwnershipReconciliation` with a signed digest.
