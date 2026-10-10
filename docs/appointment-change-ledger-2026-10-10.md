# Appointment change ledger and remaining release work

The source candidate serializes consumer cancellation and rescheduling, workforce scheduling and cancellation, card authorization, charges, refunds and payment reconciliation on one request. PHI remains disabled. This is a source implementation and fictional-store verification, not an installed AWS release or a completed appointment workflow.

## Admission and receipts

A client can supply `operationId` as a UUID with `operationProtocol: "appointment-change/1"`. It must persist the exact input and operation identity before dispatch. Older callers receive an identity derived from their verified role, person, subject, action, version and canonical input. A different caller or changed input cannot reuse a receipt.

The service conditionally records `REQOP#requestId#operationId` and fences the request before any provider write. Existing visit rows are fenced under their version; an active or completed visit cannot be cancelled or rescheduled through this path. A competing staff or payment writer cannot pass the fence. Request-backed visit writes check the request fence atomically, including creation when no visit existed during admission.

Provider and scheduler dispatch is recorded before I/O. A known validation refusal before side effects creates a refused receipt and unlocks. An unknown admission, replacement reservation, provider result or uncommitted settlement remains pending. No timeout or empty listing authorizes takeover. The pending refusal is `appointment_change_pending`, HTTP 503.

The final request version, calendar and slot updates, visit change, receipt and fence removal settle in one transaction. A lost transaction response is checked against the exact receipt. Replay returns the current authorized request **and a separate historical operation receipt**. The receipt does not certify current scheduling, payment, recording consent or join authority. A receipt from an earlier version remains historical after later updates.

An exact replacement hold becomes a fenced reservation before old provider cleanup. Its expiration cannot make it reusable midway through rescheduling. Admission records its storage key. Cancellation fees use the server-recorded operation time rather than a later recovery time. The latest visit consent withdrawal and retained text survive settlement. Fence removal advances visit versions so stale withdrawals cannot restore a cleared fence. Withdrawal and confirmed end-for-all remain available while a payment operation is pending; neither settles that payment.

The durable rows, not a ten-minute request token, provide replay identity. See [DynamoDB transaction idempotency](https://docs.aws.amazon.com/amazondynamodb/latest/APIReference/API_TransactWriteItems.html). The fictional conditional-store tests are not proof of AWS transaction or provider behavior.

## Required next engineering

- Implement reviewed reconciliation of pending operations. Read provider outcomes and invocation settlement before admitting a recovery writer. A pending meeting create must be found by exact provider evidence; an empty upcoming listing or elapsed lease is not proof of non-creation. Preserve replacement reservations until explicit settlement or compensated rollback is proven. Do not delete fences manually.
- Add operation discovery and receipts for a second authorized device. Implement the V2 sealed change journal, explicit status/recovery UI and cancellation, rescheduling and payment receipt handling. The existing V2 journal protects booking creation only.
- Bind booked slots to their exact request lineage, with an audited migration/reconciliation path for legacy unbound slots. Complete bounded availability, slot and request-list pagination.
- Add these operation records and reserved resources to export, amendment/correction, retention, legal holds, erasure and provider-copy reconciliation. Existing telehealth lifecycle, chart integration, clinic-host binding and patient-app consent remain open.
- Qualify unknown dispatch, provider completion, failed reminders, webhooks, late writes, cancellation races and rollback against the reviewed synthetic AWS target. Then build matched releases and run physical iOS/Android and two-participant Zoom journeys. No provider, device or production activation evidence is supplied by these source tests.

## Original six phases remain incomplete

Plan and adoption continuity; owned lab/document/voice provenance and recovery; privacy and record lifecycle; verified clinical knowledge and same-target catalog; Core commerce and provider acceptance; matched release, security/recovery and physical-device acceptance remain in scope. Clinical holds, source verification, adult-only launch exclusions, synthetic-only data and the prohibition on unapproved paid builds are unchanged. Provider agreements and real security/retention approvals cannot be replaced by these implementation receipts.
