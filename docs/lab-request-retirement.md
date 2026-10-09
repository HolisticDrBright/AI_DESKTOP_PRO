# Release unavailable lab requests — September 15, 2026

Source candidate only. No deployment, paid mobile build, PHI activation, vendor
request, credential change or clinical sign-off. This increment does not complete
commercial readiness or cross-device recovery.

## User workflow

In synthetic V2 Labs, **Release unavailable request** sits beside **Resume pending
lab analysis**. It reads a local preview, then asks for explicit confirmation.
**Keep request** does nothing. **Check and release** asks AWS for an atomic decision.
It does not start a replacement analysis. Saved panels, results and protocols are
not deleted by this action.

AWS permits release only when:

- The request has never been created (a durable retirement record wins against any
  delayed attempt to create it).
- Its job is already absent, such as after deletion or expiry cleanup.
- Its job is expired AND terminal: completed, failed or needs_review.

Active and unknown states remain protected, even when their expiry timestamp has
passed. In particular, an expired awaiting-upload request is not cancelled here;
it needs safe job cleanup or a future explicit cancellation workflow. Unexpired
completed jobs stay recoverable so results are not casually discarded. Older local
pointers without a durable request identity cannot be released automatically.

## Safety and durability

- The request identity binds the signed account, organization, person, request UUID
  and original timestamp. Cross-scope actions cannot retire another scope's request.
- If no request exists, conditional insertion of a retirement record competes with
  the existing atomic job+ledger creation. Only one may win.
- For an existing request, the ledger retirement update and job eligibility check
  occur in one DynamoDB transaction. The job itself is not updated or deleted.
- The original request ID remains blocked against later create/discovery attempts.
  Existing retention rules still apply: minimal synthetic ledger metadata has a
  90-day TTL, while creation requires a fresh original timestamp. Retirement is
  not production approval of retention policy or fulfillment of a privacy request.
- Lost server acknowledgements can be retried. Permission errors, ambiguous 404s,
  timeouts and active-job conflicts do not clear the phone's pending information.
- The confirmation preview is bound to the original account and exact local
  snapshot. Forged/stale previews, account changes and replacement local requests
  refuse. The phone removes only that matching pointer, only after a strict
  versioned server acknowledgement. A failed local removal remains retryable.
- No clinical input, source verification, catalog holds, approval or PHI gate changed.

## Deployment

The Desktop-owned lab extension now contains **22 authenticated routes**, including
POST requests/{requestId}/retire under both existing authorizers. The only new IAM
permission is ConditionCheckItem on the existing lab table. Deploy the matching
API bundle AND template before publishing a mobile candidate. Existing creation
capability responses are unchanged for backwards compatibility. A missing/old
retirement endpoint leaves the pending request intact; there is no legacy fallback.

## Verification

- V2: 627 tests passing, one existing hosted skip; typecheck/lint and capability /
  TestFlight source gates pass.
- Desktop: 1,352 tests passing, 11 existing skips; typecheck passes, lint has zero
  errors and four pre-existing warnings. AWS bundle build and cfn-lint pass.
- Tests cover create-vs-retire races, unrecorded/deleted/expired terminal requests,
  active/unknown-state refusal, all three ownership dimensions, timestamp mismatch,
  lost acknowledgement, permission failure, stale/forged previews, account changes,
  replaced pointers, local removal failure, strict response parsing and route IAM.
- These are local synthetic/mocked-service tests. The Labs confirmation UI has
  source-level coverage, not physical-device or rendered-browser acceptance.
  Real DynamoDB/IAM concurrency, hosted two-account denial, iOS/Android confirmation
  and mixed-version rollback checks remain required before release.

## CI repair included

Previous Desktop CI34993601564 failed because the sync verification test tried to
bind fixed port39448 and received EADDRINUSE, which then caused its setup hook to
time out. The test now asks the OS to reserve a free port, handles listen errors,
and closes HTTP connections. No sync authentication or data-boundary assertions
were weakened. The affected sync subset passes locally. Previous V2 CI34993595015
passed. Check the new exact-head CI separately; local success is not hosted success.

## Next

Continue cross-device recovery / missing-file handling and atomic result-plan
persistence, then active-plan adoption and the remaining commercial engineering.
Physical acceptance, signed eligible clinical releases, BAAs, provider/store
activation, guardian/privacy fulfillment and deployment remain separate gates.

References:
- [DynamoDB transaction condition checks](https://docs.aws.amazon.com/amazondynamodb/latest/APIReference/API_ConditionCheck.html)
- [IAM permissions for transactions](https://docs.aws.amazon.com/amazondynamodb/latest/developerguide/transaction-apis-iam.html)

