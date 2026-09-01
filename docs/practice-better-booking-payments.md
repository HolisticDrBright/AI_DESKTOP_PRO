# Patient booking and telehealth commerce

## Implemented in contract v4

- Workforce publishes explicit future openings with visit types, price, time zone, and cancellation policy.
- The consumer API returns only future, unbooked openings for the requested visit type.
- A consumer receives a ten-minute ownership-bound hold before creating a request.
- The request and slot consumption are one DynamoDB transaction with optimistic conditions.
- Workforce scheduling creates or updates a canonical AWS appointment record in the same transaction as the request status.
- Consumer rescheduling first holds a new published slot, then atomically books it and releases the previous slot.
- Cancellations enforce the published numeric cancellation window and record any fee due.
- Canonical patient-booked appointments are included in the Desktop calendar instead of living only in the request queue.
- Zoom creation, rescheduling, and cancellation are implemented behind the BAA-and-secret activation gate.
- EventBridge Scheduler reminder delivery is implemented behind the SES activation gate; stale or cancelled reminders refuse to send.
- Stripe-hosted test-card setup, explicit patient authorization/withdrawal, off-session visit charges, refunds, signed webhooks, and test-mode receipts are implemented without storing card numbers.
- Zoom remains fail-closed until its BAA gate and exact secret are registered.

## Provider activation still required

- Stripe test secret and signed webhook secret are not registered. The Stripe boundary reports unavailable and no card is collected or charged.
- Zoom Server-to-Server OAuth credentials and the Zoom BAA gate are not registered. No meeting is created.
- SES production access is pending. The domain, DKIM, custom MAIL FROM, configuration set, and Cognito sender are configured, but reminders remain disabled until AWS approves sending outside the sandbox.

No PHI or live payment flag is enabled by this release.
