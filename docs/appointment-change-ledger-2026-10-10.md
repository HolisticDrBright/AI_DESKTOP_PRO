# Appointment change ledger and remaining release work

The source candidate serializes consumer cancellation and rescheduling, workforce scheduling and cancellation, card authorization, charges, refunds and payment reconciliation on one request. PHI remains disabled. This is a source implementation and fictional-store verification, not an installed AWS release or a completed appointment workflow.

## Admission and receipts

A client can supply `operationId` as a UUID with `operationProtocol: "appointment-change/1"`. It must persist the exact input and operation identity before dispatch. Older callers receive an identity derived from their verified role, person, subject, action, version and canonical input. A different caller or changed input cannot reuse a receipt.

Only callers requesting `appointment-change/1` receive the additional `operationReceipt` field. Legacy callers retain their original strict response shape while the durable receipt remains server-side. This avoids making an older V2 parser reject a successful mutation. A matched new client must refuse an absent or mismatched receipt; it must not infer commitment from matching status.

The service conditionally records `REQOP#requestId#operationId` and fences the request before any provider write. Existing visit rows are fenced under their version; an active or completed visit cannot be cancelled or rescheduled through this path. A competing staff or payment writer cannot pass the fence. Request-backed visit writes check the request fence atomically, including creation when no visit existed during admission.

Provider and scheduler dispatch is recorded before I/O. A known validation refusal before side effects creates a refused receipt and unlocks. An unknown admission, replacement reservation, provider result or uncommitted settlement remains pending. No timeout or empty listing authorizes takeover. The pending refusal is `appointment_change_pending`, HTTP 503.

The final request version, calendar and slot updates, visit change, receipt and fence removal settle in one transaction. A lost transaction response is checked against the exact receipt. Replay returns the current authorized request **and a separate historical operation receipt**. The receipt does not certify current scheduling, payment, recording consent or join authority. A receipt from an earlier version remains historical after later updates.

An exact replacement hold becomes a fenced reservation before old provider cleanup. Its expiration cannot make it reusable midway through rescheduling. Admission records its storage key. Cancellation fees use the server-recorded operation time rather than a later recovery time. The latest visit consent withdrawal and retained text survive settlement. Fence removal advances visit versions so stale withdrawals cannot restore a cleared fence. Withdrawal and confirmed end-for-all remain available while a payment operation is pending; neither settles that payment.

The durable rows, not a ten-minute request token, provide replay identity. See [DynamoDB transaction idempotency](https://docs.aws.amazon.com/amazondynamodb/latest/APIReference/API_TransactWriteItems.html). The fictional conditional-store tests are not proof of AWS transaction or provider behavior.

## Required next engineering

### Original writer closure

New admissions now carry a private `appointment-writer/1` authority: a fresh per-invocation `writerToken`, `writerStatus: active` and, only after all local work has returned, `writerStatus: closed` with a canonical `writerClosedAt`. Every provider dispatch, replacement reservation and final mutation receipt conditionally requires that exact active authority. Closure conditionally matches the protocol, token and input digest; it removes neither the appointment fence nor the reserved replacement.

A lost admission reply may close this invocation's authority before it enters the action, but may not close a competing writer. A lost closure acknowledgement needs a strong matching read. An unavailable closure write leaves the writer unresolved without replacing an already committed receipt. A running request, hard timeout that never reaches `finally`, or legacy row without these fields remains unresolved; elapsed time does not create closure. Local closure after a failed provider call does not certify provider cancellation, absence, or the end of a late remote write.

Seventeen added fictional-store cases cover successful and refused closure, both admission-loss orders, a competing admission, both closure-loss orders, a stalled provider, private-field non-disclosure, lost writer authority before dispatch, reservation and commitment, and legacy/elapsed-time refusal. The existing foreign-payment regression now distinguishes the allowed private closure write from forbidden financial changes. The expanded six-file suite passes 207 tests. An initial typecheck failed on the new legacy-row test's inferred object type; its explicit record type fixes that compilation error. An earlier expanded run failed the old payment assertion; the revised assertion checks the unchanged version and payment fields as well as the exact closure-only update.

This is a prerequisite for safe recovery, not an implemented recovery endpoint. The matched server `recover-change` route still needs conditional recovery admission, positive provider disposition checks, reservation preservation, and hosted late-write acceptance. The V2 recovery client remains source-only until that matching server contract is implemented and qualified. Closure metadata and every operation row still need lifecycle/export/retention/hold integration. No provider activation, hosted acceptance or PHI approval follows from these tests.

- Implement reviewed reconciliation of pending operations. Read provider outcomes and invocation settlement before admitting a recovery writer. A pending meeting create must be found by exact provider evidence; an empty upcoming listing or elapsed lease is not proof of non-creation. Preserve replacement reservations until explicit settlement or compensated rollback is proven. Do not delete fences manually.
- Qualify operation discovery and change receipts across two authorized devices. The Desktop source now exposes owner-bound pending-input discovery and exact operation outcomes; V2 `33157adf1d5a8f745da01a3dbcb1a46d568a2d39` has a sealed change journal, outcome observation and explicit adoption/retry controls for cancellation, rescheduling and payment authorization. These source controls do not yet reconcile unfinished provider writes or prove convergence on physical devices. A normal replay of a pending operation still refuses instead of starting another writer.
- Bind booked slots to their exact request lineage, with an audited migration/reconciliation path for legacy unbound slots. Complete bounded availability, slot and request-list pagination.
- Add these operation records and reserved resources to export, amendment/correction, retention, legal holds, erasure and provider-copy reconciliation. Existing telehealth lifecycle, chart integration, clinic-host binding and patient-app consent remain open.
- Qualify unknown dispatch, provider completion, failed reminders, webhooks, late writes, cancellation races and rollback against the reviewed synthetic AWS target. Then build matched releases and run physical iOS/Android and two-participant Zoom journeys. No provider, device or production activation evidence is supplied by these source tests.

## Original six phases remain incomplete

Plan and adoption continuity; owned lab/document/voice provenance and recovery; privacy and record lifecycle; verified clinical knowledge and same-target catalog; Core commerce and provider acceptance; matched release, security/recovery and physical-device acceptance remain in scope. Clinical holds, source verification, adult-only launch exclusions, synthetic-only data and the prohibition on unapproved paid builds are unchanged. Provider agreements and real security/retention approvals cannot be replaced by these implementation receipts.

## Reminder safety gate repair

The full local unit audit of Desktop `bb0e0550df9255ccce41ba1c4f8686525bb8d375` finished with 5,992 tests passing and 11 existing skips. GitHub runs `38048294209` and `38048291731` nevertheless failed: the provider configuration gate still required a literal line from the older reminder implementation. This is a recorded CI failure, not a green release.

The repaired gate parses TypeScript and compares the executable refusal helper and the delivery checks before and after the suppression lookup. It requires the pending-operation fence, deliverable status, original time, protocol and generation identity, and the rechecked revision and recipient. Negative tests remove or weaken 22 separate protections; each must fail the gate. A formatting/comment change passes, and malformed source fails. Runtime race tests remain necessary: these source-shape assertions prove neither atomic email delivery nor behavior against AWS. Passing this repaired gate does not approve a provider, change activation or enable PHI.
