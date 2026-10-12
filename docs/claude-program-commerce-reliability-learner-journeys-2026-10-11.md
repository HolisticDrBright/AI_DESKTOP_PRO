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
