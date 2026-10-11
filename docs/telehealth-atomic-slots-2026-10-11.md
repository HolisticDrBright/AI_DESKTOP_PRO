# Atomic telehealth availability publication

Concurrent workforce publication previously admitted overlapping slots after both callers read an empty calendar. Availability creation now advances a clinic revision and creates the slot in one conditional DynamoDB transaction. Source qualification is separate from hosted verification and activation.

## Publication contract

The existing workforce request body and response are unchanged. A strong read observes `ORG#<organization>` / `SLOT_PUBLICATION#1` before the complete bounded conflict lookup. A valid guard carries `slot-publication/1`, the exact clinic and a positive safe revision. An absent guard is the first publication; malformed, foreign or exhausted guards refuse the operation. Existing slots must have readable ordered intervals. Overlapping intervals, including held and booked slots, refuse publication. Adjacent intervals remain allowed.

The transaction conditionally advances the same guard and conditionally creates the slot. Two callers observing the same revision cannot both commit, even if they finish different query pages. No wall-clock lease, database lock, external provider call or cleanup process is required by this fence. Hold and booking operations do not change interval bounds. New interval creation or any future interval mutation must participate in the guard protocol.

The transaction uses the new slot ID as its stable SDK client token and bounded storage requests. An expired start is rechecked before writing. A late or lost transaction response reports service unavailable: it does not prove non-commitment, certify success or independently delete either row. An explicit retry re-reads availability; an already committed overlap is refused rather than duplicated. There is no new cross-request publication receipt or automatic application retry.

Only a structured two-item cancellation containing conditional-check failures and no capacity/unknown reason is classified as a conflict. Unclassified failures remain unavailable. No raw SDK message, submitted text or secret is logged. Template identity is `telehealth-requests/10`; table IAM scope and production/PHI/provider guards remain unchanged.

AWS documents all-or-nothing conditional transactions, their short client-token window and the distinction between serializable item operations and read-committed queries. The clinic revision catches competing participating writes; it does not make the paginated query itself an atomic snapshot. [DynamoDB transaction semantics](https://docs.aws.amazon.com/amazondynamodb/latest/developerguide/transaction-apis.html).

## Verification

The first diagnostic ran against exact parent `513b71c6bc105295499956b2107a4ef08cebc78f`: 18 failed, 3 passed. Both overlapping calls succeeded. New guard integrity, loss-of-receipt and conditional transaction cases also failed before implementation. Six further interval/deadline diagnostics failed on the first repaired source and passed after the interval checks and late-write refusal were added.

The existing three publication pagination fixtures now supply the additional strong guard read. Their later-page, unfinished-read and booked-overlap refusals and no-write assertions are preserved; explicit guard-read checks were added. No skip, test deadline or refusal assertion was removed. Focused verification, normal complete suite, exact commit and CI are recorded separately after the final source is frozen. Parent full and CI evidence cannot certify this successor.

The final seven-file focused run passed 518 tests. Typecheck, lint and `git diff --check` passed on that source. The telehealth artifact build, Desktop operation inventory and compatibility gates also passed. The fictional store applies only conditions declared by the request: unconditional puts remain unconditional, and unsupported expressions fail the fixture instead of inventing a protective condition. A full-suite or CI result for the parent does not certify this repair; the new head needs its own terminal results.

## Hosted qualification and rollout

Only participating publishers are protected. A mixed fleet containing old unfenced writers, direct administrative puts or a future interval mutator bypassing the guard can still create an overlap. Before any activation, identify every writer, stop new writes through historical versions and direct-write credentials, drain previously admitted writes and verify the exact matched source fleet. Inspect existing intervals for overlaps; this repair neither deletes nor retrospectively fixes old records. No deployment or write-stop/drain is performed by this source change.

The synthetic AWS run must prove both race orders, first and existing revisions, cross-clinic refusal, adjacent slots, booked overlaps, later-page concurrent publication, actual conditional-cancellation reasons, no partial transaction state, timeout/lost receipt and explicit recovery through current slot reads. Verify IAM against the reviewed table, ensure holds/bookings still work, and test the source cutover with no old publisher left active. Refusals or skipped cases cannot count as positive qualification.

Large retained calendars can still exceed the complete-walk budget and refuse publication. A scoped/indexed availability lifecycle remains a separate scale requirement; this fence does not certify unbounded calendar capacity. Complete native request authority, preserving schema/fleet integration, provider reviews, matched releases and physical acceptance remain open.

This change contains no AWS write, schema application, fixture, consent or review hash, secret, provider activation, paid build, main merge or PHI activation. The original six commercial scopes are not closed by this repair.
