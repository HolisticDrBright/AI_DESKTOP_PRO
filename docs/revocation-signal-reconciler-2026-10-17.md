# The campaign-signal reconciler: bounding the publication gap, and what it cannot bound

**Status: BLOCKED, source only.** These stay blocked:

- the reconciler (`WORKFORCE_REVOCATION_SIGNAL_RECONCILER_RELEASE = 'blocked'`, and the same variable `blocked` in its
  Lambda's environment);
- its SQL candidate `workforce-revocation-signal-reconciler.sql` and rollback (unregistered, applied only to PGlite);
- its template `infra/aws-clinical-core/workforce-revocation-signal-reconciler.json` (`ReconcilerRelease` accepts only
  `BLOCKED`, `ScheduleState` accepts only `DISABLED`, so no resource, schedule or IAM grant exists);
- the head start (`PENDING_HEAD_START_DECISION.status = 'owner_decision_required'`, constructed nowhere);
- and, unchanged, the emergency revocation itself (`WORKFORCE_IDENTITY_REVOCATION_RELEASE = 'blocked'`) and the campaign
  engine (`CampaignEngineEnabled=false`, `SendScheduleState=DISABLED`).

Nothing was applied, deployed or called. No AWS, Cognito, SES or Fly call was made. The evidence is PGlite on the real
106-migration schema with the emergency revocation, its campaign-signal successor and this candidate applied, the real
signal writer and reader over a fictional DynamoDB table, and the campaign engine's own staff route and sending job.
**PGlite is not Aurora and the fictional table is not DynamoDB.** PGlite is one connection, so the lease's row locks
are tested for their logic, never for two sessions racing. Fictional subjects, clinics and addresses only.

**This is not a complete fix for the pre-publication window.** A scheduled reconciler bounds how long a revocation can
stay unpublished once the signal table is writable again. It cannot make the interval between the clinical commit and
the first publication zero. §3 states exactly what it bounds and what it does not.

## 1. The question

`docs/revocation-signal-timing-2026-10-17.md` left three cases OPEN, each reproduced as an `it.fails`:

1. **Race order B.** The pending write is slower than the clinical transaction.
2. **The signal table is unwritable while the reader still works.**
3. **The final publication keeps failing past the 30-minute pending deadline.**

For (2) and (3) the old campaign token stayed admitted "until a reconciliation". A reconciliation was an operator
action: `reconcile(operator)` calls `list_workforce_identity_revocation_work`, which requires an active platform
operator. So the bound was "until an operator comes back". The owner requires immediate compromise revocation and
paused queued sends. A gap that only closes when a person returns does not meet that.

## 2. The design

### 2.1 Source of truth: the existing revocation records

The reconciler keeps no list of its own. It reads only what the emergency revocation already records:

- `clinical_private.workforce_identity_revocations`: one row per revocation that took effect, with the
  `identity_subject` it revoked;
- `clinical_private.workforce_identity_provider_actions`: append-only, one row per attempt, including the
  `campaign_signal` step the campaign-signal successor admits.

A revocation is **due** when its latest `campaign_signal` attempt did not succeed, or when it has none. That is the
same "latest row wins" rule the summary uses, so the reconciler and the operator's work list never disagree. Unlike
the operator's work list, the due list is not limited to the 200 most recent proposals.

### 2.2 Its own role, no operator

An operator subject was the obvious shortcut. It was rejected. Registering the reconciler in
`workforce_platform_operators` would give it every operator power: proposing, approving, and acting as the
"independent second operator" of the two-person rule.

Instead, the SQL candidate creates `clinical_revocation_signal_reconciler`:

- NOLOGIN and NOINHERIT, a member of nothing. Codex grants it to the reconciler's own database login.
- It is granted exactly three functions, in a schema of their own (`clinical_revocation_signal`), and no table.
- It is **never granted USAGE on `clinical_private`** (finding F5, §4).
- None of its functions reads whether an operator is active. With every operator disabled, it still claims, records
  and completes. A test does exactly that.

The store (`createSqlRevocationSignalReconcilerStore`) sets the role itself at the start of every transaction and
checks `current_user`, before any reconciler call. Handed a broader connection, it still runs with the role's rights
only. Handed one that cannot take the role, it refuses.

### 2.3 The lease and the cursor

| Function | What it does |
| --- | --- |
| `clinical_revocation_signal.claim_sweep(sweep, limit)` | Takes the one lease: 60 s, fixed in SQL. Bumps the generation and logs the sweep (append-only). Returns the due list, at most 200. A held lease: `granted: false, reason: lease_held`. A sweep id used before: `sweep_id_used`. The holder asking again (a lost reply): the same generation. |
| `clinical_revocation_signal.record_attempt(sweep, generation, action, revocation, subject, outcome, failure)` | Holds the lease row `FOR SHARE` and records into `provider_actions`, keyed by the action id. Refuses, writing nothing, when it is not the holder of that generation (`lease_lost`), when the revocation is unknown (`not_found`), or when the subject is not the one the revocation recorded (`subject_mismatch`). `recorded_by` is the sweep id. |
| `clinical_revocation_signal.complete_sweep(sweep, generation)` | Releases the lease and records the completion. A stale holder gets `completed: false`. |

**The cursor is the attempt records.** The due list is ordered never attempted first, then least recently attempted.

- A sweep that dies part way leaves the items it attempted at the back of the line, and the rest at the front.
- A new revocation is never queued behind a stuck backlog.
- A stored keyset position was rejected for two reasons. It would put the newest revocation (the most urgent) last,
  and it could disagree with the records.

**Fencing.** A sweep that overran its lease, after another sweep took the lease over, is refused at its next record and
stops. What it already published is harmless, because publication is idempotent. The current holder records the
outcome.

**An operator's records and a sweep's stay apart.** A sweep id that matches a registered operator's subject is refused
at claim, so a sweep's row can never read as an operator's.

### 2.4 One sweep (`runRevocationSignalReconciler`)

1. **Claim** the lease. A database that cannot be reached throws, and the run fails into the error alarm.
2. For each due item:
   - **Publish** exactly the record's subject and revocation id, with the writer's `attribute_not_exists` put.
     - A lost reply, a retry or a duplicate sweep finds the item there, and the publish succeeds without changing it.
     - An item the table already holds, from any revocation or contract, is never replaced.
   - **Bounded retries:** at most `RECONCILER_ATTEMPTS_PER_ITEM = 2` tries, `RECONCILER_RETRY_PAUSE_MS = 250` apart.
   - **Renew on failure.** If the publication still fails, `hold(subject, revocationId)` is written again, so the
     pending item gets a fresh 30-minute deadline. The revocation took effect, so holding the login pending is the safe
     direction.
     - The hold is named by the revocation's own id, so no decision's `release` can remove it.
     - It lapses by itself if the reconciler stops.
     - It never stands in for the publication: the item stays due, and becomes overdue.
   - **Record** the outcome under the lease.
     - A lost record reply is retried once under the same action id, and the database recognises it as a duplicate.
     - An outcome that cannot be recorded is reported as `unrecorded`, never assumed.
3. **Stop early, and say so (`more: true`)**:
   - after `RECONCILER_SWEEP_BUDGET_MS = 30 000`;
   - or after `RECONCILER_OUTAGE_STOP_AFTER = 5` consecutive items fail for the table, rather than for the item
     (`throttled`, `unavailable`, `timeout`, `access_denied`, `not_found`). The table is down, and the next sweep tries
     again.
4. **Complete**, and report. The summary is counts, plus revocation ids for at most 50 failures. It never holds a
   subject.

### 2.5 Alarms (no operator needed)

`summary.alarms` is drawn from five values:

| Alarm | Raised when |
| --- | --- |
| `refused` | A malformed item, or a record the database refused. A defect or tampering: page at once. |
| `lease_lost` | The sweep lost its lease part way. |
| `unrecorded` | An outcome could not be recorded. |
| `outage` | The sweep stopped for a table outage. |
| `overdue` | After the sweep, the oldest unpublished revocation is older than `RECONCILER_OVERDUE_AFTER_MS = 5 min`, by the Lambda's clock. |

The Lambda logs the summary, then fails when any alarm is set. The template's two alarms page the SNS topic
`AlarmTopicArn`:

- `ReconcilerErrorAlarm`: `Errors ≥ 1` in a minute.
- `ReconcilerSilenceAlarm`: fewer than 1 invocation in each of 5 minutes, with **missing data as breaching**. A
  reconciler that stopped running is itself the page.

### 2.6 It never releases

- The run is typed to receive `publish` and `hold` only. Tests hand it a `release` that records any call, and none is
  made.
- Its IAM is `dynamodb:PutItem` on the signal table only: no `DeleteItem`, `UpdateItem`, `GetItem` or `Query`.
- It writes `<subject>` only with `attribute_not_exists`. Any item at `<subject>` reads as revoked (`/1` and `/2`), so
  nothing it can write ever un-revokes a login.

## 3. The windows, stated exactly

These are the bounds with the proposed values: schedule period P = 1 minute, lease 60 s, sweep budget 30 s, Lambda
timeout 45 s.

| Case | Before (operator-run reconciliation only) | With the reconciler running | Can it be zero? |
| --- | --- | --- | --- |
| **(1) Race order B:** the pending write lands after the commit | Admitted from the commit until the pending write lands (ms on a healthy table) | **Unchanged.** The reconciler does not touch it. | Only with the head start (§6), and only for pending writes acknowledged within N ms |
| **(2) Writer down at the commit, reader up** | Admitted from the commit until an operator reconciles, which is **unbounded** if no operator returns | Admitted from the commit until the first sweep after the writer recovers succeeds: **≤ recovery + P + one sweep**. Add up to one more P if the previous sweep crashed holding its lease, and ⌈backlog / 100⌉ − 1 more P for a backlog over 100. | **No.** At the commit the table held nothing. Closing it needs the clinical commit to wait on DynamoDB, or the campaign engine to read the clinical database. Both are forbidden. |
| (2) while the writer stays down | Unbounded, and silent | **Unbounded**: nothing can publish to a table that refuses writes. But the sweep reports `overdue` from 5 minutes on, which pages without an operator. | No |
| **(3) Final publication failing past the pending deadline** | Reopens at the deadline until an operator reconciles | **Not reopened** while a sweep runs inside each 30-minute window and the pending write lands: each failed sweep renews it. It reopens if the reconciler stops (silence alarm) or the pending write fails too, until a publication lands. | Not in general |
| No answer from the database, though it committed | Pending refuses for 30 minutes; after that, until an operator reconciles | Pending refuses until the first sweep (≤ P) publishes. If the pending write landed, the gap is zero. | Yes, when the pending write landed |
| **A queued send the revoked login scheduled, due inside window (2)** | It goes out, and keeps going until an operator reconciles | It goes out if it falls due before the reconciler publishes (`it.fails` OPEN). It is held, and the hold recorded, from the publication on. | No (as (2)) |
| The same send on a healthy table (race order A) | Paused at the commit, nothing recorded; held after publication | Same | Yes, already |
| An email already handed to SES | Not recalled | Not recalled (`docs/campaign-send-authority-2026-10-17.md` §5) | No |

## 4. Findings, labelled

| # | Finding | Label | Where |
| --- | --- | --- | --- |
| F1 | A failed campaign-signal publication was retried only by an operator. With every operator away the signal was never published, and the old token stayed admitted after the writer recovered. | **Failing-before defect.** Closed in source (BLOCKED) by the operator-free scheduled reconciler. | Scratch test 1 failed before: `expected 200 to be 403`. After: *a writer outage … publishes it with every operator away*. The pinned *before* test keeps the operator path's dependency visible. |
| F2 | A final publication failing past the pending deadline reopened the gap even when a reconciliation ran inside the window: the operator path never renews the pending item. | **Failing-before defect.** Closed in source (BLOCKED) by renewal, while the reconciler runs and the pending write lands. | Scratch test 2 failed before: `expected 200 to be 403`. After: *with a sweep inside each pending window …*. Mutation: renewal removed, it fails again. |
| F3 | Idempotent publication (`attribute_not_exists`), "any item is revoked", and send authority holding a revoked login's queued send and pausing on pending. | **Coverage of already-correct behaviour**, exercised through the reconciler | Lost-reply, duplicate-sweep, wrong-subject and healthy-table send tests |
| F4 | The reconciler could have been given an operator subject. That would hand it every operator power, including standing in as the independent second operator. | **Design hazard, avoided.** A dedicated role and schema instead. | §2.2, and the role-privilege test |
| F5 | **PUBLIC holds EXECUTE on 20 `clinical_private` functions** in the 106-migration schema. 9 are SECURITY DEFINER, and 4 of those are directly callable (not triggers): `move_entitlement`, `build_sync_payload`, `require_knowledge_admin`, `require_knowledge_editor`. Every role with USAGE on `clinical_private` can call them: `clinical_core_api`, `clinical_core_migrator` and `clinical_sync_worker` in the schema, plus `clinical_workforce_application` and `clinical_workforce_operator` once the onboarding candidate grants them USAGE. Whether any of this is a real escalation depends on each function's own checks, which were not reviewed. | **Finding, not fixed (outside WP3).** Pinned as current state by a test. The reconciler is kept out of `clinical_private` because of it. | *found, not changed here: PUBLIC holds EXECUTE …* |
| F6 | Race order B (OPEN 1) | **Policy hold:** the head start is the owner's decision (§6) | The original `it.fails`, unchanged |
| F7 | The commit-instant window with the writer down (OPEN 2), and a queued send due inside it | **Policy hold / structural.** Bounded after recovery, never zero. | The original `it.fails`, unchanged, and the new `it.fails` for the send |

## 5. Evidence

### 5.1 Failing before (unchanged code)

| Run | Result | Log |
| --- | --- | --- |
| The four new test files, written first | **4 of 4 files failed** at import: the reconciler, its SQL and the head start did not exist; 0 tests ran | `wp3-failing-before.log` |
| Behavioural scratch: the two properties, against the only reconciliation that existed (the operator's); deleted after | **2 of 2 failed**, each `expected 200 to be 403` | `wp3-failing-before-behaviour.log` |

Both logs are local evidence from the WP3 session's scratchpad. They are not committed.

### 5.2 Passing after

| Suite | Result |
| --- | --- |
| `src/integration/revocation-signal-timing-reconciler.database.test.ts` (new) | **19 passed, 1 expected-fail.** The new OPEN, run as a plain `it`, fails with exactly `expected [ { …(9) } ] to have a length of +0 but got 1`: one broadcast email went out. |
| `src/server/clinical-core/revocation-signal-reconciler.database.test.ts` (new) | **15 passed**: the parent refusal, file and prosrc hashes, role privileges, F5, the due order, lease and fencing, idempotent record, subject and not-found refusals, operator independence, append-only log, rollback and re-apply, then all three rollbacks in order |
| `src/server/clinical-core/revocation-signal-reconciler.test.ts` (new) | **23 passed**: BLOCKED (3), one sweep (14), SQL store (3), template (3) |
| `src/server/clinical-core/staff-revocation-signal-head-start.test.ts` (new) | **7 passed** |
| `src/integration/revocation-signal-timing.database.test.ts` (unchanged) | **13 passed, 3 expected-fail.** Each of the three, run as a plain `it`, still fails with exactly `expected 200 to be 403`. |
| Focused set: the files above plus `staff-revocation-signal` (integration and unit), `workforce-revocation-campaign-signal.database`, `workforce-identity-revocation`, `workforce-route-inventory`, `outreach-separation`, the Fullscript reconciler, and all ten `src/campaigns/*.test.ts` | **22 files: 234 passed, 4 expected-fail** |
| `npm run typecheck` | exit 0 |
| `eslint` on the changed TypeScript files | exit 0 |

**Mutation checks**, each restored afterwards:

| Mutation | Test that failed |
| --- | --- |
| Renewal removed | The pending-window test: `expected 200 to be 403` |
| Lease fencing removed | The stale-sweep test: an extra row was recorded |
| Subject check removed | The wrong-subject test: `'recorded'` where `'subject_mismatch'` was expected |

**What happened to the three `it.fails`.** All three remain, unchanged, because none of their exact properties holds:

- (1) still lands its pending write after the commit;
- (2) still finds the table unwritable at the commit;
- (3) runs no sweep inside its window.

What the reconciler adds is stated as new, passing tests beside them, not by flipping theirs.

### 5.3 The race tests the handoff asked for

| Race | Tests |
| --- | --- |
| Lost publication reply | The reconciler's own reply; the service's final reply; the record's reply |
| Writer outage with a working reader | Measured at the commit; through the outage; overdue; recovery; backlog order |
| Duplicate sweep | Concurrent (the second is `held_elsewhere`); lapsed lease (fenced); a reused sweep id |
| Wrong subject | Exact-subject publication, with another login's item and another decision's pending item untouched; the database's `subject_mismatch` and `not_found` |
| Old scheduled send | OPEN inside the window; held from the publication on; paused at the commit on a healthy table |

## 6. Owner decision: the bounded head start (not taken)

**Proposed text for Brandon.**

> Should the operator host wait up to **N = 250 ms** (allowed range 1 to 1000) for the pending campaign signal to be
> acknowledged before it starts the clinical transaction that revokes a compromised login?
>
> - **Yes, healthy table.** The wait ends as soon as DynamoDB acknowledges, typically a few milliseconds. Race order B
>   closes for every pending write acknowledged within 250 ms: the old campaign token is refused from the commit.
> - **Yes, signal table slow, throttled or down.** Every emergency revocation's clinical refusal starts **250 ms later**
>   than today, never more. The clinical decision never depends on DynamoDB's answer. The gap at the commit is
>   unchanged (case 2), and the reconciler still bounds it after recovery.
> - **Yes, pending write slower than 250 ms.** The old token is still admitted from the commit until it lands.
> - **No (today).** The clinical refusal never waits, and race order B stays open for milliseconds on a healthy table.

**How it is built.** `withPendingHeadStart` (`src/server/clinical-core/staff-revocation-signal-head-start.ts`) wraps the
operator's database and signal writer.

- It has **no default duration**. Built without an explicit N from 1 to 1000, it throws.
- A test proves nothing outside tests constructs it.
- `PENDING_HEAD_START_DECISION` records the proposal as `owner_decision_required`.
- Wiring it after a yes is one line in the operator host: pass `withPendingHeadStart({ database, signal,
  headStartMs: 250 })`'s two parts to `createWorkforceIdentityRevocation`.
- **Scope, stated:** it waits on any pending write in flight on that host, so two concurrent decisions can each wait up
  to N for the other's. That is the same bound, never more.

**Evidence.** All three head-start race tests are real PGlite plus the fictional table, with the head start configured
in the test only:

- a pending write that lands within N is in place at the commit (403);
- a slower one still sees 200;
- a table that never answers delays the clinical refusal by exactly one N.

**Also for review (proposals, not safety switches):**

- the 1-minute schedule;
- the 5-minute overdue threshold;
- the 100-item batch.

Each trades cost against window length. None weakens a refusal.

## 7. Switches and identities

| Switch | Value |
| --- | --- |
| `WORKFORCE_REVOCATION_SIGNAL_RECONCILER_RELEASE` (source) | `'blocked'` |
| `WORKFORCE_REVOCATION_SIGNAL_RECONCILER_RELEASE` (Lambda environment, template) | `blocked` |
| `ReconcilerRelease` | `AllowedValues: [BLOCKED]`. Every resource has `Condition: ReconcilerReleased`. |
| `ScheduleState` | `AllowedValues: [DISABLED]` |
| `PENDING_HEAD_START_DECISION.status` | `owner_decision_required` |
| Lambda `build` | Refuses without an injected role-scoped database: the adapter does not exist in `rds-data-database.ts` |

| Artifact | SHA-256 |
| --- | --- |
| `workforce-revocation-signal-reconciler.sql` | `5ef389b41ca3efc230364ef38e878dcd48055f5899bf4aba27e855af3c6a7946` |
| `workforce-revocation-signal-reconciler-rollback.sql` | `bf272983de34c692eb0ed4fcfcc851f6ff5a5fb24642f05afdfdedf9f8c3c763` |
| prosrc `clinical_private.workforce_revocation_signal_reconciler_status()` | `970fe12e450bb4c52ebfa9d4c3e0dbaefee845e7abd0fe7609f4c4c07742cb7d` |
| prosrc `clinical_revocation_signal.claim_sweep(uuid,integer)` | `eb495344faa066add3e45114a820e03212575518bdacdf0e99b6f6282e98b276` |
| prosrc `clinical_revocation_signal.record_attempt(uuid,bigint,uuid,uuid,text,text,text)` | `705ec0b0722bbab43ac4d9b17d2eb8f63d466e948941faabfb46e2ca0b852dd9` |
| prosrc `clinical_revocation_signal.complete_sweep(uuid,bigint)` | `c5494ed3275da42cbeb2c6503ea034e78a1d9d733ab2854311aa6df46b489857` |

**The candidate's parents:**

- `workforce-identity-emergency-revocation.sql`, then `workforce-revocation-campaign-signal.sql`;
- the candidate checks the summary's prosrc `da11a53c…` and the recorder's `8eab347a…`, and the three-step check;
- it changes neither, nor `set_request_context` (`3ee98d29…`).

**The rollback:**

- It drops the four functions and the (then empty) schema.
- It keeps the role (it may be granted to a login), the sweep log, the lease, and every recorded attempt.
- It changes no parent.
- The candidate applies again over it.
- Order: this rollback, then the campaign-signal successor's rollback, then the emergency revocation's. The test runs
  all three in that order.

No existing SQL candidate file was edited.

## 8. Threat model and IAM

| Actor | What it can do |
| --- | --- |
| A compromised practitioner with an old token | Admitted only in the §3 windows. Refused from the publication on, for as long as the item exists, which is forever. |
| An attacker holding the reconciler's IAM role | Can write a false revocation or hold an innocent login pending: the writer's reach, minus delete. A renewed false hold lasts while they keep renewing it. Cannot delete or un-revoke. Can read nothing. |
| An attacker holding the reconciler's database login | Can claim the lease and keep it, which would starve the real reconciler. Its sweeps still run, read the claim's status and report `overdue`, so the error alarm pages. Can record attempts only for a real revocation's own subject. Can write `failed` rows, which keep an item due, never complete. Can record `succeeded` without publishing; this is the main residual of a stolen login (§9). Cannot propose, decide, read a table or reach `clinical_private`. |
| A DynamoDB outage | Publication fails and is retried each sweep; overdue pages at 5 minutes; reads stay fail-closed (503). |
| An Aurora outage | The sweep fails at claim; the error alarm pages. Nothing is assumed published. |
| Every operator away | No effect. Nothing here needs one. |

**The role (template, not applied):**

| Grant | Scope |
| --- | --- |
| `dynamodb:PutItem` | `table/alp-campaign-staff-revocations` only (pinned by `AllowedPattern`) |
| `secretsmanager:GetSecretValue` | The reconciler's own database secret (`alp-revocation-signal-reconciler-db-*`, never the cluster master's) |
| Data API (four actions) | One cluster |
| `kms:Decrypt` | One key |
| Logs | Its own log group |

A test refuses `*`, any delete, update, read, query or scan, any Cognito or SES action, and `sns:Publish`.

## 9. Residual races, stated

1. **The commit-instant gaps (1) and (2)** remain OPEN by design. See §3.
2. **A declined second proposal for an already-revoked, still-unpublished subject.** If its pending write overwrote the
   reconciler's renewal, its own release removes that pending item. The login is then admitted until the next sweep
   (≤ P). Edge case; bounded.
3. **A `succeeded` row is trusted.** The reconciler never re-reads DynamoDB, because it has no `GetItem`. An
   out-of-band delete of a `<subject>` item by an administrator is not detected. A DynamoDB resource policy denying
   `DeleteItem` on non-`pending#` keys to every principal would close this; that is Codex's to evaluate. The same
   gap covers a stolen reconciler login that records `succeeded` without publishing.
4. **Clock skew.** Overdue compares the Lambda's clock with Aurora's `revoked_at`, so it is off by the skew.
5. **Two reconcilers.** The operator's `reconcile` and the scheduled one can both publish and record the same
   revocation. Publication is idempotent. If their rows interleave so that the latest is `failed`, the next sweep
   publishes again (a condition failure, so success) and records it.
6. **The Cognito steps** (`disable_user`, `global_sign_out`) are still retried only by an operator. The clinical refusal
   never depended on them; the campaign signal is the only campaign-side refusal, and that is what this covers.
7. **Native concurrency.** The lease's `FOR UPDATE` / `FOR SHARE` behaviour under two real sessions is unobserved:
   PGlite has one connection.

## 10. Codex hand-back (ordered, not run)

1. Review §3 and §6, and take two things to Brandon: the head-start decision with its exact text, and the schedule
   period and overdue threshold proposals.
2. Review finding F5, the PUBLIC EXECUTE grants in `clinical_private`, separately. It is not part of this package.
3. Add a role-scoped Data API adapter for the reconciler's login to `rds-data-database.ts`
   (`set local role clinical_revocation_signal_reconciler`), and wire it into
   `revocation-signal-reconciler-lambda.ts`'s `build`.
4. On isolated fictional qualification Aurora, with the emergency revocation and the campaign-signal successor:
   - apply this candidate and confirm the hashes in §7;
   - create a fictional reconciler login, granted only `clinical_revocation_signal_reconciler`;
   - confirm it cannot select any `clinical_private` table or call any `clinical_private` function;
   - run the two-session lease qualification: two claims at once (one granted); a record racing a takeover (fenced);
   - roll back, re-apply, then roll back all three in order.
5. In a fictional qualification account, apply the template with `ReconcilerRelease` still `BLOCKED`, and confirm
   nothing is created.
   - A reviewed edit then allows `RELEASED` there only.
   - Confirm the role's exact grants (§8), and that `DeleteItem` on any key is denied.
   - Keep `ScheduleState` `DISABLED`, and invoke the function by hand.
6. With a fictional login revoked while the signal table's writes are denied:
   - confirm the clinical refusal is immediate;
   - confirm the sweep reports `failed`, then `overdue` after 5 minutes, and that the error alarm fires;
   - restore writes, and confirm the next sweep publishes and the campaign staff route answers 403.
   - Also confirm the silence alarm fires when the function is not invoked for 5 minutes.
7. Only after Brandon's decisions: release the schedule, together with the emergency revocation. Never separately.
