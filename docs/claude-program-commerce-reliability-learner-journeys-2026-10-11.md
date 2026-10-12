# Program commerce reliability and learner journeys — October 11–12, 2026

Return for the handoff "Claude handoff for reliable purchases and complete learner journeys"
(packets `808c2da2` and its refresh `5823c2dc`). Source engineering only, with fictional
transports, isolated embedded databases and local browser tests. Nothing here contacted AWS,
Stripe, an email provider or a store; no secret was retrieved, no product or price was created, no
webhook registered, no schema applied, nothing activated or published, no PR opened, nothing
merged, no force-push, no mobile build, and PHI stays disabled. Prices, billing frequency, access
duration, commercial terms and storefront classification remain unset. Both **Book a
consultation** and **Buy the program** remain.

| Repository | Branch | Base for this assignment | Milestones |
| --- | --- | --- | --- |
| HolisticDrBright/AI_DESKTOP_PRO | `claude/program-commerce-closure-20261011` | `d14522b58f5f6c4557fc1fa233fc75b724fdaca3` (unit 5) | M0 (time-zone repair + unit 6 return), WP1 (this section), later packages below |
| HolisticDrBright/AI_LONGEVITY_PRO_V2 | `claude/program-commerce-closure-20261011` | `1a9fd822c4bde85337e03388d493e6235af65d15` (unit 5) | from WP3 (mirror successor) and WP4 |

The original closure return, `docs/claude-program-commerce-closure-2026-10-11.md`, is preserved and
completed by M0; this document is the successor return.

---

## M0 — the time-zone assertion

The failing case on `d14522b` (CI 38192228557) compared the claim window's rendering
(`2026-10-11T12:00:00+00:00`) with PGlite's rendering in the unit suite's Pacific session zone
(`2026-10-11T04:00:00-08:00`): one instant, two presentations. The declared contract is
`z.string().datetime({ offset: true })` in all three commerce contracts, so an offset is admitted
and the instant is the fact. The assertion now compares the instant beside the unchanged ownership,
revision, single-use and stranger checks, and a new case reads the same entitlement under `UTC`,
`America/Los_Angeles` and `Asia/Kolkata` session zones (three distinct renderings, one instant,
each a contract timestamp, the claim still used and the stranger still empty). The file passes
under `TZ=UTC` and `TZ=America/Los_Angeles`. No runtime changed; nothing was forced, removed,
retried or given a longer timeout. Details and the full unit-6 verification are in the closure
return.

---

## WP1 — checkout and background recovery (first milestone)

### Failing before, on `d14522b`

`src/server/commerce/checkout-recovery.test.ts` was written first against the unchanged source.
Seventeen cases failed for the reasons the handoff names; three passed and are classified as
already correct. Evidence: the run output kept with the session notes (`wp1-failing-before`).

| Finding | Reproduction on `d14522b` | Result before |
| --- | --- | --- |
| 1 Completed and unpaid is terminal | a delayed-method session (complete, unpaid) then success | order went `payment_failed`; the later success could not fulfil |
| 2 Creation re-derived from the clock | Stripe transport over a fictional Stripe: lose the creation reply, advance 5 minutes, start again | the replay sent a different `expires_at` under the same key; Stripe's idempotency error left the order refused |
| 2 Beyond the retention window | the same, after 25 hours | a second creation was sent for the same order and key |
| 3 Reused session without the full binding | substitute account, amount, currency, price, billing mode, order, metadata, live mode, session, checkout host, missing address, expiry | 12 of 13 substitutions were redirected to; only "completed" was held |
| 6 Swallowed expiry and recursive restart | fail the expiry write, start again | `admitOrder` called 21 times (an unbounded loop) |
| 7 Failed backlog read | `unsettledOrders` throws | `settleDue` answered `[]` ("no work") |

Already correct before (kept as regression cases): an explicit asynchronous failure settled
failed and a reversed success-then-completed pair converged; a completed session on reuse was held
as `attempt_in_progress`; two processors restarting the same expired attempt produced one new order
and one new session.

Findings 4 (stream readers) and 5 (detached processing) were reproduced in the transport and route
tests: the old reply reader and webhook read whole bodies before comparing character length (a
130,000-character "€" body of 390 KB passed a 262,144 limit), and the route started processing
after the reply.

### Repairs

1. **The creation request is durable before it leaves** (`program-checkout/2`). Admission is
   followed by `creation_pending`, which records the complete outbound request: mode, price, the
   quantity, both return addresses, the opaque order id twice, the expiry in the processor's own
   unit, the idempotency key and the SHA-256 of the canonical form encoding. The processor
   receives exactly those saved bytes on the first send and on every replay; nothing is
   re-derived from a clock. `buildCreation` runs once per order.
2. **Unknown outcomes are kept, not guessed.** A definitive pre-mutation refusal closes the order
   `refused`. Anything else (timeout, lost reply, 5xx, 409, 429, a malformed or redirected reply)
   is `creation_unresolved` and is replayed from the saved request. Beyond the processor's
   idempotency retention a replay could create a second session, so the order is held
   `creation_unreconciled` (an operator hold, "cannot take a payment") unless the saved expiry has
   already passed, in which case whatever may exist has expired and the order closes. An
   idempotency error is never answered with a new key.
3. **One binding for every session.** `verifySessionAgainstOrder` now also checks the saved return
   addresses and expiry and requires the recorded creation; `redirectableCheckout` adds open,
   unexpired, an address on the processor's own checkout host, no credentials or port. New,
   reused, concurrent and reconciled sessions all pass through it before any redirect. A missing
   checkout address stays missing.
4. **Processor authority is proven.** The processor interface gains `authority()`: the Stripe
   transport retrieves the account the secret key belongs to (`GET /v1/account`, test keys only)
   and attributes every session to that observation; the boundary refuses to create or redirect
   when the proven account is not the configured one or cannot be proven.
5. **Delayed payments.** `payment_processing` is a state; `observePayment` reads the retrieved
   object (session status, payment status and the expanded payment intent status) and decides
   open, expired, processing, verified or failed. A generic unpaid status is never a grant and
   never, on its own, a failure. The event type only asks for a retrieval. A duplicate or reversed
   event converges on the same receipt (a peer's identical transition is recognised after a stale
   revision); an observation that contradicts a decided order is the new intake state `conflict`,
   settled once and visible, never applied. No refund or renewal policy is invented.
6. **Durable work and a bounded worker.** The webhook admits and acknowledges; nothing runs in the
   request after the reply. `program-commerce-worker.ts` takes one bounded pass over the same
   durable ledgers: due intake (the ledger bounds attempts and schedules backoff), reconciliation
   of undecided orders (saved creations, processing payments, open checkouts past expiry),
   settlement, and the operator status. Each step reports its own unavailability. There is no
   lease: every step is safe twice at once, and a lease expiry would not prove a processor call
   stopped. Processor calls happen between ledger calls, never inside a transaction.
7. **Bounded byte readers.** The webhook reads its body through the existing bounded reader (bytes,
   not characters; absent or dishonest Content-Length; a slow body; cancellation) and verifies the
   signature over those exact bytes; the shared verifier now accepts bytes (string callers are
   unchanged) and decodes only after the signature matched, refusing invalid UTF-8. The Stripe
   transport reads every reply the same way under one deadline that covers connection, body and
   parse.
8. **Nothing swallowed, nothing unbounded.** Every transition goes through one helper that returns
   the order, a converged peer's order, or a typed failure the caller turns into a visible hold.
   One start restarts at most once after a decided order. `settleDue` answers
   `{ ok: false, reason: 'backlog_unavailable' }` when the backlog cannot be read, and each new
   settlement reports its delivery hand-off (`none`, `not_configured`, `handed_off`, `failed`);
   durable delivery is WP2.

### After

| Check | Result |
| --- | --- |
| `checkout-recovery.test.ts` | 25 passed (the 17 reproductions, the 3 already-correct cases, and worker, authority and convergence cases) |
| Contract, boundary, Stripe transport, webhook route, settlement, purchase rows, funnels, Studio commerce | all commerce-related files: 37 files, 396 passed |
| `program-checkout-orders-candidate.database.test.ts` (PGlite, predecessor + successor, API role) | 6 passed, including the successor case |
| `program-education-access-candidate.database.test.ts` (with the successor applied) | 8 passed |
| Billing webhook and bounded reader (shared verifier) | 38 passed |
| `tsc --noEmit`, `eslint` on every changed file | clean |
| `check:aws-desktop-operation-inventory` | passed |

### BLOCKED successor

`infra/aws-clinical-core/source-candidates/program-checkout-recovery.sql`, SHA-256
`29d85d75da43176b1a6d007afc5a0a892f99a08994f44bb459a4a756e2e2efc0`
(`PROGRAM_CHECKOUT_RECOVERY_SCHEMA_CANDIDATE_SHA256`). Parent: `program-checkout-orders.sql`
`767ac13bc111a15b98bdc2978a5e42a33f5f1ab61f010061907787040b0c37ee`, unchanged and applied first
(and through it the offer candidate `4973461564e6812906403525cb3aa109d6fd569eec159c9400fcf568a90b321f`
and identity consent `c4ca967352bce6c678249336ef410fe7de4216d123a0d3da06a467379780c445`). Not in the
manifest, not applied, not registered. It adds the `creation` column with shape checks tying its
key, order id, price, mode and addresses to the order; the new states and transition table; the
`conflict` intake state; `program_orders_in_states` (undecided states only, bounded) and
`checkout_work_status` (counts only). The SQL ledger enables only when the evidence names the offer
digest and both checkout digests. Grants are still `clinical_core_api`; narrowing them by caller is
WP3.

### Interfaces Codex wires (names only)

- `ProgramCheckoutProcessor`: `accountRef` (configured), `checkoutHosts`, `idempotencyRetentionHours`,
  `authority()`, `createSession(savedCreation)`, `retrieveSession(ref)`. Stripe source:
  `createStripeCheckoutProcessor(config, fetch)` with `STRIPE_TEST_SECRET_KEY`,
  `STRIPE_TEST_ACCOUNT_ID`, `STRIPE_API_VERSION_PINNED`, `STRIPE_TEST_MODE_ENABLED`.
- `createCommerceWorker({ ledger, checkout, settlement, limits })`: `runOnce()` and `status()`.
  Scheduling, alarms on `status` (`exhausted`, `conflict`, `creation_unreconciled`,
  `oldestUnresolvedAt`) and the host are Codex's.

### Concerns still open after WP1

- Delivery of the claim: a hand-off failure is now reported, but the plaintext token still exists
  only in the first settlement call; durable delivery and recovery are WP2.
- The education functions' grants (WP3).
- Real Stripe behaviour (idempotency retention, payment intent expansion on a delayed method,
  account retrieval with a restricted key) is hosted work and is not claimed here.

---

## WP2 — claim delivery and purchaser recovery

### Purchaser threat model

Three gates, each proven separately and none standing in for another:

| Gate | What proves it | What does not |
| --- | --- | --- |
| The payment happened | the retrieved processor object bound to the saved order (WP1) | a redirect, a success URL, an event alone |
| This is a real account | a verified consumer session (the V2 Cognito session the bridge resolves) | a typed email, a name, a device |
| This account is the purchaser | the one-time code, delivered to the contact the payment processor holds for the order, presented by that session | an order id, a processor reference, an email address, a success URL, the staff status |

There is no email-equality or order-number recovery path, and none was added. A lost code is
replaced only by an operator, and the replacement cancels every earlier code in the same step.

### Failing before, on the WP1 head `15f4e0d`

`src/server/commerce/claim-delivery.test.ts`, five reproductions, all failing for the stated reason:

| Observation | Result before |
| --- | --- |
| The staff status reply carries the code's digest | the serialized `listForProgram` reply contained `tokenHash` (the SQL `claim_json` returned it too) |
| The settlement result carries the plaintext code | the outcome JSON contained the 43-character code, so any worker report or log could |
| A failed first delivery strands the purchaser | after a provider failure and a restart, no code was ever delivered again (the digest cannot be turned back into a code) |
| The winner retrying after a lost reply is refused | the second identical claim answered `claim_used` |
| Screens say a code was sent | the staff row said "the one-time code sent to the address…" and the return page "is sent separately", whatever delivery did |

### Repairs

1. **Sealed, durable delivery.** Settlement seals the new code (`ClaimSealer`) and the ledger stores
   the entitlement, the claim (digest only) and a delivery row holding the sealed code in ONE step.
   No return value, report or log carries the code. The sealed copy exists only while delivery is
   pending or its outcome unknown and is erased when delivery is accepted, fails for good, or the
   claim is used, expires or is superseded.
2. **A delivery step** (`program-claim-delivery.ts`) opens the sealed code only at the moment it
   sends it. The recipient comes only from `PurchaserContactAuthority` (the contact the payment
   processor holds, read at send time, never stored here). Each message goes to the provider under
   a stable per-delivery idempotency key, so a retry after a lost receipt cannot send a second
   code. States: `pending`, `provider_unknown` (retried with backoff, bounded at six attempts),
   `accepted` (not proof of arrival), `failed`, `withdrawn`. The copy is generic: "Your access code",
   the code as text (never a link), its expiry, and "if you did not make this purchase, ignore this
   message". No program, curriculum, price, lab, diagnosis or protocol word.
3. **The worker** runs delivery as its fourth step and reports `delivery_unconfigured` where there is
   none, never "nothing to send".
4. **The winner's retry** returns the same receipt (same entitlement, same enrollment); anyone else
   is `already_claimed_by_other`.
5. **Operator replacement** (`settlement.reissue(operatorContext, entitlementId)`): only while nobody
   holds the entitlement; supersedes every issued claim and withdraws its delivery atomically; a
   learner or the general API cannot reach it (`not_operator` in source, `permission denied` in SQL).
6. **Words.** Staff rows distinguish `code_delivery_pending`, `code_delivery_unknown`,
   `code_delivery_failed` and (only after acceptance) `pending_account`, which says acceptance is not
   proof of arrival. The return page no longer says a code was sent.
7. **The contract** (`program-education-access/1`, mirrored): a claim is seen without any digest and
   with its delivery state. Mirror digest
   `17bf3d974571fb85204fc447eb5497571a677bad63ec755cb9acedcf49ea717f` in both repositories.

### After

| Check | Result |
| --- | --- |
| `claim-delivery.test.ts` | 16 passed: the five reproductions now held, interrupted first delivery and restart, a lost provider receipt (one message), bounded attempts, no contact (fails, nothing sent) versus a contact outage (retried), generic copy, expiry withdraws and erases, a sealed code opens only for its own claim, an unreadable queue is said, two delivery workers send one message, both claim race orders, operator-only replacement, and a replacement racing a claim (exactly one wins, either landing order) |
| `program-education-access-candidate.database.test.ts` (PGlite; offer, checkout, recovery, education and delivery candidates under their own roles) | 7 passed, including the role case below |
| All commerce-related files | 47 files, 725 passed |
| V2 education tests with the mirrored contract | 45 passed; V2 `tsc` clean |

The role case uses the embedded database's real reduced roles. The API role is refused the due
queue, recording a delivery, a replacement, the parent's unsealed settlement, and every delivery
and claim table. A session whose **session user** is the API role cannot `SET ROLE` to the delivery
or operator role. A superuser session that only runs `SET ROLE` would prove nothing, so the case
first sets the session authorization itself. The delivery role cannot replace, claim or read the
tables. Every sealed code is erased once deliveries settle.

### BLOCKED successor

`infra/aws-clinical-core/source-candidates/program-education-delivery.sql`
(`PROGRAM_EDUCATION_DELIVERY_SCHEMA_CANDIDATE_SHA256`, value pinned in
`program-education-ledger-sql.ts` and held equal by its test). Parents, applied first and unchanged:
`program-education-access.sql` `e4f11e29f1b6a68f1478dbc112aaac1ea2bbf72adf86f9458dd5a20c8151df93`
and `program-checkout-recovery.sql`. It creates the NOLOGIN roles `commercial_education_delivery`
and `commercial_education_operator` (granted to nobody), the delivery table, the sealed settlement,
the replaced claim and claim view, the delivery queue and record functions (delivery role only), and
the replacement function (operator role only), and revokes the parent's unsealed settlement from the
API role.

### Additive overlap in a shared file

`src/server/clinical-core/rds-data-database.ts`: the commerce refusal token family now includes
`program_delivery_*` (one alternation added to the existing pattern at line 275). No other line of the
file changed; the media and telehealth lanes do not use that pattern.

### Host inputs (names only)

- `ClaimSealer`: a KMS key for envelope sealing whose `Decrypt` only the delivery worker's role holds
  (`Encrypt` for the settlement role), the claim id bound as encryption context.
- `PurchaserContactAuthority`: from the retrieved Checkout Session's collected customer email at send
  time. Whether the processor-collected address is sufficient purchaser authority is a decision.
- `ClaimDeliveryProvider`: a transactional email provider with idempotency keys; provider coverage
  and data classification of the message require review before real delivery.
- Database sessions for `commercial_education_delivery` and `commercial_education_operator`, and an
  operator identity the host resolves into `OperatorContext`.

### Decisions named (unchanged policy, safe state built)

Code lifetime (7 days in source, a bound and not a policy), code format, whether the processor's
collected email is sufficient purchaser authority, the operator role's holders, and account-first
versus anonymous checkout.

## WP3 — database authority separation and undecided-terms holds

### Failing before, on the WP2 head `3a36047`

Two new files reproduced the findings first, each failing for the stated reason.

`program-commerce-authority.database.test.ts` (PGlite, the whole BLOCKED chain through the delivery
successor, then DIRECT calls from a session whose **session user** is `clinical_core_api`):

| Call from the API role | Result before |
| --- | --- |
| `transition_program_order(open order, …, 'payment_verified', forged verification)` | succeeded: the order became `payment_verified` with no processor involved |
| `claim_program_entitlement(digest, 'sub:fictional-mallory-01', …)`, and `education_access('sub:fictional-alice-0001')` | the subject was an argument the caller chose; Alice's purchases were returned to a caller naming her |
| `read_program_entitlement(id)`, `entitlement_for_order(id)`, and `program_education_status(clinic A, …)` under clinic B's workforce context | every entitlement was readable by id, and clinic B read clinic A's status |
| `record_entitlement_policy(…, 'operator_revoke', …)`, `transition_program_entitlement(…, 'revoked')`, `expire_program_entitlements(now() + 4000 days)` | the API role could revoke, transition, and expire every active entitlement at an instant it chose |
| `unsettled_program_orders`, `due_checkout_intake`, `find_program_order_by_session` | the worker's backlog and intake were readable from the request path |

`settle_program_order_sealed` was also granted to the API role; the reproduction's call used a random
order id and was refused as unverified, so that line proves nothing alone. The grant is the evidence.

`commerce-terms-holds.test.ts` (fictional ledgers):

| Observation | Result before |
| --- | --- |
| an offer naming `education-access-terms/42`, which nobody reviewed | published |
| a null access duration | published, and read as "no end" |
| an entitlement whose duration nobody decided | claimed, and still active in 2036 |

### Repairs

1. **Reviewed access terms.** A version is a name until a review records what it says
   (`reviewedAccessTerms` in the offer contract): duration policy `fixed_days` or `indefinite`, Core
   dependency `not_required` or `required`, and refund and renewal policy references (null is
   undecided). The source registry is **empty**. The fictional ledgers carry two fixture entries whose
   reviewer reads `FICTIONAL REVIEW FIXTURE`. Five holds, at publication and at availability:
   `access_terms_unreviewed`, `access_duration_undecided` (null is "no end" only under `indefinite`,
   and a number contradicts `indefinite`), `core_dependency_unresolved` (a purchase never grants Core,
   and nothing here can check a buyer holds it), `refund_terms_undecided`, `renewal_terms_undecided`
   (recurring offers only).
2. **The same holds at activation.** A claim of an entitlement whose terms are held is refused
   `terms_undecided` and binds nothing, whatever an older artifact let through. The refusal is in
   the mirrored contract, with words on the V2 claim screen.
3. **Caller contexts.** The consumer methods take a `ConsumerCaller` built from the verified request
   context, never a subject string. The staff methods take a `StaffCaller`. Policy, transitions and
   replacement codes take an `OperatorContext`. Expiry is the worker's bounded sweep by the store's
   own clock. The consumer's access read expires only the caller's own ended windows.
4. **SQL authority successor** (below): a worker role, consumer functions whose subject is the
   verified request context, staff status bound to a clinician of that clinic, operator-only policy,
   and the API role's grants removed for every function it no longer needs.
5. **Ledgers per authority.** The SQL checkout ledger has a request-path instance (admission,
   creation-side transitions through `advance_program_checkout`, webhook admission, the return-page
   read) and a worker instance (intake, observed payment outcomes, reconciliation, counts). The SQL
   education ledger takes four handles: API, worker, delivery, operator. Both pin every digest in the
   chain, the authority successor included.
6. **The worker** gains a fifth step, the bounded expiry sweep, and reports `store_unavailable`
   rather than "nothing expired" when it cannot read.

### After

| Check | Result |
| --- | --- |
| `program-commerce-authority.database.test.ts` | 8 passed: the five reproductions refused; the API role cannot assume the worker, delivery or operator role; the legitimate paths still work through their own roles; an unreviewed version is held at publication in SQL, and the reviewed registry is append-only and closed to the API role |
| `commerce-terms-holds.test.ts` | 3 passed |
| `program-education-access-candidate.database.test.ts`, `program-checkout-orders-candidate.database.test.ts` | 7 and 6 passed, now on the whole chain with each call through its owning role |
| All commerce-related files | 23 files, 276 passed (`src/server/commerce`, the commerce routes, `src/lib/programs`) |
| Full unit suite (`npm run test:unit`, Pacific zone) | 497 files passed; 7751 tests passed, 11 skipped |
| `tsc`, `eslint` on the changed areas | clean |
| V2 education tests with the mirrored contract | 45 passed; V2 `tsc` and `eslint` clean |

Three existing tests changed in setup only, never in what they assert:

- The database tests now let days pass by shifting stored instants back with triggers suspended for
  one statement. They can no longer pass a future instant, because the database clock decides now.
- Two fixtures paired a null duration with fixed-day terms. They now name the fixture `indefinite`
  terms, so the policy test and the "no end" test keep asserting what they did.
- The checkout candidate's person-shaped-column check is scoped to the five offer and checkout
  tables it always covered, now that the full chain is applied. The education test keeps its own
  column check.

### BLOCKED successor

`infra/aws-clinical-core/source-candidates/program-commerce-authority.sql`, sha256
`11e53bc2e7ff13d1aa66c219fc9da1c4e768faef8ea42e1ebc44ed375a8c6c62`
(`PROGRAM_COMMERCE_AUTHORITY_SCHEMA_CANDIDATE_SHA256` in `program-commerce-authority.ts`, held equal
by three database tests). Parent: `program-education-delivery.sql`
`653965ff19f1d522067a6b636ac4ed5a4d2f9f1696cbb692c9545e3fc2046ae6`, and through it every earlier
candidate. It replaces `publish_holds` and `program_education_status` in place, and it changes no
migration, shared identity function or privilege outside `commercial_education`.

| Role | May call |
| --- | --- |
| `clinical_core_api` | `admit_program_order`, `advance_program_checkout` (never a payment outcome), `read_program_order`, `admit_checkout_intake`, the offer command and availability, `claim_program_entitlement_for_caller`, `education_access_for_caller`, `own_program_entitlement_for_caller`, `education_curriculum_for_caller`, `program_education_status` and `education_curriculum_staff` under a clinician's workforce context |
| `commercial_education_worker` (new, NOLOGIN) | order transitions, intake read, settle and due list, session lookup, reconciliation list and counts, sealed settlement, settlement backlog, per-order entitlement reads, `expire_program_entitlements_due(limit)` by the database clock |
| `commercial_education_delivery` | unchanged from WP2 |
| `commercial_education_operator` | `record_entitlement_policy`, `transition_program_entitlement`, `record_reviewed_access_terms`, and the WP2 replacement |

Revoked from the API role: `transition_program_order`, `find_program_order_by_session`,
`program_orders_in_states`, `checkout_work_status`, `read_checkout_intake`, `settle_checkout_intake`,
`due_checkout_intake`, `settle_program_order_sealed`, `unsettled_program_orders`,
`claim_program_entitlement`, `read_program_entitlement`, `entitlement_for_order`, `education_access`,
`education_curriculum`, `record_entitlement_policy`, `transition_program_entitlement`,
`expire_program_entitlements`.

### Host inputs (names only)

- A database session per role: the API pool for request handlers, a worker session for the commerce
  worker, and the delivery and operator sessions from WP2.
- The consumer bridge's verified request context (person and identity subject) for every consumer
  call, and the workforce context for staff calls.
- An operator identity resolved into `OperatorContext`, and the operator's review evidence for each
  access-terms entry.

### Decisions named (unchanged policy, safe state built)

What the access terms say: duration policy per version, whether a program depends on Core, the
refund policy and the renewal policy. Until Brandon records a review, every paid offer stays held,
and no claim activates.

### Concerns still open after WP3

- The return page reads an order by its id through the API role. The id is an unguessable value the
  browser already holds, and the reply carries no entitlement or code. A bound on what that read
  returns is a hosted review item.
- Processor refund and dispute events are not handled by this build's intake. Policy holds are
  operator decisions only until a reviewed intake mapping exists.
- The database binds each consumer and staff call to the request context, and refuses a person and
  subject pair that does not exist or does not match. It cannot authenticate the caller. The API
  role sets the context, so a compromised API process could still name any existing pair. The
  independently authenticated identity factory that sets the context is a host input Codex installs.
- Concurrent settlement and claim races are tested against the real candidate in PGlite, which runs
  one connection at a time. Real PostgreSQL contention remains a hosted case.

## WP4 — learner progress in V2 and Desktop

### Already correct, and the gap

The enrollment already stored a `phaseIndex`, and V2's My courses screen already read the exact
purchased version read-only, cleared private state on session, environment and foreground changes,
and discarded late replies. Nothing could record or read a learner's progress: the consumer
contract had only access, claim and curriculum reads. Progress is now its own contract, ledger
methods, service seam and BLOCKED successor. The clinical program-assignment service is not used.

### The contract: `program-education-progress/1` (mirrored)

`src/contracts/programEducationProgress.ts`, sha256
`c86676406c05242aac330f7c2973521dea80f4862a93a5598f4912279ee40630`, byte-identical in V2
`expo/contracts/programEducationProgress.ts` and held there by a digest test.

- Lessons are named by the stable phase and item ids of the purchased version, pinned by version
  id, number and digest.
- Three requests: `read`; `complete` (the learner pressed "Mark this lesson complete"); `position`
  (a resume point, never a completion). Each write carries the revision the device read and a
  request id it generated.
- A recorded write answers with a receipt: request id, action, lesson, time and new revision. The
  same request id always answers with the same receipt. A different write under a used request id
  is `request_conflict`.
- Refusals: `not_owner`, `not_active`, `enrollment_mismatch`, `stale_version`, `unknown_lesson`,
  `not_completable` (supplement steps and unreleased lessons), `revision_stale` (with the current
  record, never merged), `request_conflict`, `service_unavailable`.
- Pure navigation helpers: `courseLessons` (reads only the published shape and reports whether
  every part was readable), `neighbours`, `isCompleted`, `resumeLesson` (the recorded position while
  it is still a lesson of this version, else the first released lesson not completed).

### Desktop

- Ledger methods `progress(caller, entitlementId)` and `recordProgress(caller, command)` in the
  fictional and SQL education ledgers, taking the verified `ConsumerCaller` only.
- `education-progress-service.ts`: the consumer bridge, shaped for
  `POST /clinical-core/consumer/education/progress` and **not registered**. Consumer pool, synthetic
  boundary, `clinical_data` purpose, the caller from the context, the body strictly one of the three
  requests, activation evidence naming the progress candidate, and an outage reported as unavailable.
- BLOCKED successor `infra/aws-clinical-core/source-candidates/program-education-progress.sql`,
  sha256 `7d4b3ee7027dca24e91423b409bc1cf5e387689e14d154ede448348f655a2eb5`
  (`PROGRAM_EDUCATION_PROGRESS_SCHEMA_CANDIDATE_SHA256`). Parent: the authority successor
  `11e53bc2…`. One revisioned progress row per enrollment, append-only completions and receipts,
  FORCE RLS on all three with every role revoked, and two functions granted to the API role only:
  `education_progress_for_caller(entitlement)` and `record_education_progress_for_caller(command)`.
  Both take the subject from `caller_consumer_subject()`. Lesson ids are validated against the
  stored version through `clinical_private.program_consumer_content`, the same read the curriculum
  function makes, with the digest re-checked. The SQL ledger's progress methods enable only with
  this pin; nothing else depends on it.
- Staff status does not include a learner's lesson progress. Progress is the learner's own
  bookkeeping; whether a clinic sees it is a decision, not a default.

### V2

- `lib/education/awsEducationProgress.ts`: the transport, with the access transport's owner, epoch,
  origin and size posture. A reply is accepted only for the request it answers: same action, course
  and enrollment, and for a recorded write the same request id and lesson.
- `lib/education/lessonMedia.ts`: the media reader seam, **held**, naming
  `program-media-reference/1` and building no storage, signing or alternate media reference. Every
  released lesson shows its governed text and says plainly that lesson video is not available in
  the app yet.
- `app/education.tsx`: course overview ("N of M lessons marked complete", Start or Continue), the
  phase and lesson list, a lesson view with Back, Next and All lessons, and "Mark this lesson
  complete". A completion says "Saving…" until the receipt. A failure says it was not saved and
  offers to try again with the **same** request. A save from a device that is behind shows the saved
  record and says the course was updated on another device. A supplement step says it is reviewed on
  My programs and has no complete button; an unreleased lesson shows no text. Back in the foreground,
  the course that was open is read again from the service and resumes where the service says; a
  relaunch does the same from nothing kept on the device. Losing authorization clears lesson text and
  progress. There is no purchase button, price, checkout link or Core term on the screen.

### Verification

| Check | Result |
| --- | --- |
| `education-progress.test.ts` (fictional ledger and service) | 5 passed |
| `education-progress-candidate.database.test.ts` (PGlite, whole chain + progress successor) | 5 passed: disabled without its pin; no role reads the tables; no context or a workforce context refused; idempotent receipt with one completion row; two-device stale refusal; every refusal; a direct API session with Bob's context cannot write Alice's course; append-only completions and receipts; revision rises by exactly one |
| V2 `education-progress-contract`, `education-progress-client`, `education-course-journey` | 4, 11 and 9 passed |
| V2 education tests together | 7 files, 69 passed; `tsc` and `expo lint` clean |

Device evidence here is component evidence: the screen, contract and transport are real, and only
the native, session and network boundaries are substituted. A physical two-device run against a
hosted service is still owed.

### Additive overlap in a shared file

`src/server/clinical-core/rds-data-database.ts` line 275: the commerce refusal token family gains
`progress` and `terms` beside WP2's `delivery`. It is one alternation in one existing pattern; no
other line changed.
