# The revocation-signal timing gap: pending before the commit, and what stays open

**Status: BLOCKED, source only.** These stay blocked:

- the emergency revocation (`WORKFORCE_IDENTITY_REVOCATION_RELEASE = 'blocked'`);
- its SQL candidate and the campaign-signal successor (unregistered);
- the writer (constructed nowhere, with no IAM).

The campaign engine ships off. Nothing was applied, deployed or called. The evidence is PGlite on the real
106-migration schema with both candidates applied, plus the real writer and reader over a fictional table, and the
campaign engine's own staff route. Fictional rows only.

**This does not close the gap.** It narrows it to the cases in §4 and reproduces each of those as a failing test. Do
not read any post-publication test as proof of immediate revocation.

## 1. The gap

The clinical database refuses a revoked login the moment the operator transaction commits. It holds the identity row
`FOR UPDATE`, so a request already admitted finishes first and every later one is refused.

The campaign engine never reads that database, and must not. It learns of a revocation only from its own signal
table, and that item was published *after* the commit. In between, an old campaign token was admitted:

- by the staff route, so it could read contacts, edit templates and schedule sends;
- and by the sending job's authority check (`docs/campaign-send-authority-2026-10-17.md`).

**Failing before.** The test *"before: one phase"* in `src/integration/revocation-signal-timing.database.test.ts` uses
the `/1` order. It probes the staff route at the moment of commit and gets **200**; after publication it gets 403.

## 2. The design (staff-revocation-signal/2)

Two items per subject, under two keys. `#` is never part of a subject, so the keys cannot collide.

| Key | Written | Means | Lapses |
| --- | --- | --- | --- |
| `<subject>` | Once, `attribute_not_exists`, when the decision has taken effect | Revoked, exactly as `/1` | Never. The writer's role cannot delete it (§5). |
| `pending#<subject>` | As a decision that can take effect starts | A revocation is being decided now | At `pendingUntil`, 30 minutes after it was written |

**The reader** (the campaign API and the sender) reads both keys, strongly consistent:

- Any item at `<subject>` means revoked. A `/1` item still reads that way.
- Otherwise, an unexpired pending item means pending. So does one whose deadline is missing, unreadable or more than
  31 minutes ahead: it never lapses.
- Otherwise the subject is clear.
- Either read failing means 503, never "clear".

Pending blocks exactly like revoked, with one difference: the sending job records **no** hold for it. So a declined
decision leaves nothing behind to review.

**The service** (`workforce-identity-revocation.ts`) handles a proposal, or an approval under
`second_operator_before`, like this:

1. **Start the pending write, and do not wait for it.** The database call goes ahead at once, so a DynamoDB outage
   never delays the clinical refusal.
2. **The database answers.** The service waits for the pending write to settle, so a release can never land before
   it. Then it acts on the answer:

   | Database answer | What happens to the pending item |
   | --- | --- |
   | Took effect (`revoked`) | Step 3 publishes `<subject>`. The pending item is left and lapses; the revocation wins. |
   | Definitely did not (`awaiting_approval`, `declined`, a named refusal) | Released: deleted only while it is still this decision's |
   | No answer (`service_unavailable`) | Left to lapse. The login stays refused until the deadline, because a commit may have happened. |

## 3. What is now true

Each row is probed at the instant the deciding transaction commits.

| Case | Old token at the commit | After |
| --- | --- | --- |
| **Race order A:** the pending write lands before the commit (a healthy table) | **403** | 403 |
| The pending write's reply is lost, but it landed | **403**. The decision never waited on it. | 403 |
| The final write's reply is lost | 403 | The step is recorded failed and stays actionable; a reconciliation records it succeeded |
| The table is unwritable | 200 (OPEN, §4) | The clinical refusal is undelayed. The step is recorded failed; a reconciliation publishes it, then 403. |
| The reader is down | 503 | 503. Never admitted. |
| Awaiting a second operator | 200: released at once | A decline leaves both keys empty |
| An approval that takes effect | **403** | Revoked |
| A named database refusal (`not_found`) | 200: released at once | Nothing left |
| No answer from the database | 403 | Clear after 30 minutes by itself: an innocent login is never revoked for good |
| A release whose reply is lost | 200: it was removed | Nothing left |
| A release that never lands | 403 | Clear after 30 minutes |

## 4. OPEN: what this cannot close (reproduced as `it.fails`)

Each test below states the property we want. It fails with exactly `expected 200 to be 403`; that was checked by
running each one as a plain `it`.

1. **Race order B: the pending write is slower than the clinical transaction.** The old token is admitted from the
   commit until the pending write lands. That is milliseconds on a healthy table. The companion test measures it:
   200 at the commit, 403 from the next request on.
2. **The signal table is unwritable while the reader still works** (writes throttled, the writer's IAM broken). The
   old token is admitted from the commit until a reconciliation publishes the item. This is the `/1` gap, unchanged.
3. **The final publication keeps failing past the pending deadline.** The old token is admitted again from the
   deadline until a reconciliation succeeds.

**Why these stay open.** Closing any of them needs one of two things:

- the clinical commit waits on DynamoDB, which delays the refusal during an outage, the one thing it must not do;
- or the campaign engine reads the clinical database, which the separation forbids.

Two decisions for Brandon would narrow them without crossing either line:

- **A bounded head start** (a decision; not built). Wait up to *N* ms for the pending write before the database
  call. That closes (1) on a healthy table, at the cost of an *N* ms delay to the clinical refusal during a DynamoDB
  outage.
- **A scheduled reconciliation** (Codex's). Today a reconciliation is an operator action. A job every few minutes
  would bound (2) and (3) by its period instead of by an operator.

A fourth case is a false positive, not a gap. A hold aborted at the client but applied by DynamoDB *after* its
release leaves an innocent login refused at the campaign engine for up to 30 minutes. It is bounded by the deadline.

## 5. Threat model and the writer's IAM

**The writer's role must never be able to un-revoke.**

- Under `/1`, any item meant revoked, so the only way to un-revoke was `DeleteItem`.
- `/2` keeps that property. The pending item has its own key, so overwriting `<subject>` with anything still reads as
  revoked.
- `DeleteItem` must be limited to pending keys. The release's condition expression cannot enforce that, but IAM can.

The operator host's grant, Codex's to create (not in any template here):

```json
[
  { "Sid": "WriteStaffRevocationSignal", "Effect": "Allow", "Action": "dynamodb:PutItem",
    "Resource": "arn:aws:dynamodb:<region>:<account>:table/alp-campaign-staff-revocations" },
  { "Sid": "ReleasePendingDecisionsOnly", "Effect": "Allow", "Action": "dynamodb:DeleteItem",
    "Resource": "arn:aws:dynamodb:<region>:<account>:table/alp-campaign-staff-revocations",
    "Condition": { "ForAllValues:StringLike": { "dynamodb:LeadingKeys": ["pending#*"] } } }
]
```

The fictional table enforces the same rule: a delete of `<subject>` is `AccessDeniedException`, and a test asserts it.

| Actor | Can it admit a revoked login at the campaign engine? |
| --- | --- |
| A compromised practitioner with an old token | Only in the §4 windows. Afterwards it is refused for as long as the item exists, which is forever. |
| An attacker holding the writer's role | Can hold innocent logins pending, which a deadline bounds. Can write a false revocation, as under `/1`. Cannot delete a revocation. |
| An attacker holding a campaign reader role | No: those roles hold only `GetItem` |
| A DynamoDB outage | Reads fail closed (503). Writes: §4 (2). |

## 6. Template change (not applied)

`CampaignStaffRevocationTable` gets `TimeToLiveSpecification` on `expiresAt`. Only pending items carry the attribute,
so DynamoDB removes lapsed ones in the background. The reader never relies on it: it compares `pendingUntil` itself.

## 7. Deploy order (when unblocked)

1. **The reader first:** the campaign stack, with this code.
   - A `/1` reader never reads `pending#` keys, so a `/2` writer in front of it only loses the pending protection.
   - It never blocks an innocent login.
2. **Then the writer:** the operator host, with the IAM in §5.

## 8. Evidence

| Suite | Result |
| --- | --- |
| `src/integration/revocation-signal-timing.database.test.ts` (new) | 13 passed, 3 expected-fail (the OPEN cases) |
| `src/integration/staff-revocation-signal.test.ts` | Writer to reader on the shared table: `/1` items still revoke, a release never touches a revocation, a lapse, another decision's pending item kept, the role cannot delete a revocation |
| `src/server/clinical-core/staff-revocation-signal.test.ts` | The exact `PutItem` and `DeleteItem` per phase, closed failure codes |
| `src/campaigns/staff-revocation.test.ts` | The ten-row status matrix over both keys |
| `src/campaigns/send-authority.test.ts` (+2) | Pending holds for the pass and records nothing; pending that takes effect becomes a recorded hold |
| The existing revocation database suites | Unchanged and passing |

## 9. Codex hand-back (ordered, not run)

1. Review §4 and take the two decisions to Brandon: the bounded head start, and a scheduled reconciliation.
2. In a fictional qualification account:
   - apply the campaign template and confirm the table's TTL;
   - grant a fictional operator host exactly §5;
   - confirm `DeleteItem` on a `<subject>` key is denied, and on `pending#<subject>` is allowed.
3. Against isolated fictional qualification Aurora, with both candidates:
   - revoke a fictional login, and confirm its campaign token is 403 within the request after the commit;
   - throttle the table's writes, and confirm the clinical refusal still lands at once, the step is recorded failed,
     and a reconciliation completes it;
   - under `second_operator_before`, decline a proposal, and confirm both keys are empty and the login is admitted.
