# Complete telehealth listing and overlap checks

The telehealth service previously returned only the first DynamoDB page for patient appointment requests, practitioner requests and published slots. Later pages could be silently omitted, and publication could miss an overlapping opening. Publication also explicitly ignored an already-booked slot. Both defects are repaired in source; no hosted service or provider has been activated.

Source base is `5640e153d9ef5aafc607e71998957821e0327d59`, on the separate branch `agent/telehealth-complete-lists-20261011`. The managed qualification database remains at 112. This repair changes no migration, schema identity, credential, consent, provider release or production gate.

## Listing contract

The existing array response is preserved, but is returned only after the walk reaches a completed page. The server follows continuations through empty pages, checks the owner and clinic bindings on each record and continuation, and refuses duplicate storage keys or duplicate logical identities. A later failure, invalid page, cursor cycle or unfinished twentieth page returns `service_unavailable` without projecting earlier records.

One ten-second abort signal covers the entire walk. Page sizes are bounded by the requested limit, and the combined serialized record budget is three MiB. Slot and workforce request queries use strongly consistent base-table reads. The patient request query uses the existing `ByConsumer` GSI, where strongly consistent reads are not supported. It may cross clinics for that owner, but only the requested clinic is projected. A continuation cannot substitute a different owner.

Exhausting pages is not an atomic snapshot. The GSI remains eventually consistent and may not immediately show a newly committed request. These reads are not durable write admission, proof of provider absence or a replacement for conditional booking and recovery operations.

## Slot publication and lookup

Slot lookup follows the same bounded complete walk, so an eligible later-page slot can be held using the existing conditional owner-bound hold. Publication checks all returned slots, including booked ones, before writing. An unfinished conflict lookup cannot create a slot.

Publication's read followed by conditional insertion is still not an atomic overlap check across simultaneous publishers. The complete request-service work must address that concurrency with a durable admission and recovery contract, including the practitioner and calendar resource binding. This repair does not claim that race is solved.

## Regression evidence

Before the listing repair, 46 of the initial 54 new tests failed and eight already-correct cases passed. The separate booked-slot diagnostic then failed with HTTP 201 where 409 was required. After repair, the final complete-list suite and the inherited request and booking-replay suites pass 267 tests across three files, without skips.

The final complete-list suite contains 73 cases. It covers later pages and empty intermediate pages, malformed and cross-owner continuations, response failures, page and byte bounds, one shared abort deadline, repeated cursors, duplicate storage and logical identities, genuine completed empty lists, clinic-filtered consumer projection, later-page holds and overlap checks, unfinished publication refusal, and booked-slot refusal.

One inherited cancellation fixture gained its missing `organizationId`, so it represents the persisted slot's ownership metadata. No existing assertion or denial was removed. Legacy slot keys remain accepted within their correct clinic and family; canonicalizing their historical spelling is not required for this read repair.

Typecheck and telehealth artifact build passed. Final lint, AST update, the normal whole suite and exact-head CI are recorded separately as their commands complete. Do not infer these from the parent source's successful whole suite and CI. The historical production gate still refuses production traffic with PHI disabled.

## Verification commands

```text
npm run test:unit -- src/server/clinical-core/telehealth-complete-lists.test.ts src/server/clinical-core/aws-telehealth-requests.test.ts src/server/clinical-core/telehealth-booking-replay.test.ts
npm run typecheck
npm run lint
npm run build:aws-telehealth-requests
graphify update .
npm run test:unit
```

## Remaining release work

Integrate these source changes into the reviewed complete request-service artifact without weakening historical gates. Independently verified Cognito identity, current MFA, restricted credentials, live target binding, durable admission, revalidation and settlement are still required. New sharing consent must not prevent cancellation after withdrawal or independently authorized retained-record access.

Reconcile the exact schema and complete fleet before requesting a preserving upgrade from the actual 112 database. The completed approval for 107 to 111 to 112 does not authorize newer schemas or deployment. Run positive and negative hosted journeys against real services only after the complete candidate and its inputs are reviewed. Keep PHI, Zoom, payments and paid mobile builds off until their separate requirements are met.
