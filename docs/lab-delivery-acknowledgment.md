# Durable lab delivery acknowledgment — September 16, 2026

Original phase 2 increment, not phase completion. The synthetic backend was
deployed at source b04551a1457f5aca135b091b257c502ecbc32619; V2 source
6a9d20944c909b1dd29a701bd4385281a008d787 has not been built for devices.

The existing delivery endpoint now accepts a second versioned command:

```json
{"contractVersion":"lab-delivery-ack/1","deviceBindingSha256":"<64 lowercase hex>","disposition":"applied"}
```

`disposition` is exactly `applied` or `archived_not_applied`. The original
`lab-delivery/1` claim request/response and normal status response are unchanged.
No route or IAM expansion is required beyond the source delivery routes already
added previously. Both delivery routes now exist in the synthetic stack, protected
by their existing JWT/custom authorizers. No production deployment is implied.

A claim only reserves the completed job for one installation. An acknowledgment
records that the client reports successful durable local saving or inert archival.
It requires the existing claim, same owner and binding, completed job and exact
unchanged result. The conditional write binds the full result, then stores the
server-computed canonical result digest, disposition and acknowledgment time.
No health content is copied into the receipt. Conflicting devices, dispositions,
changed results and deletion races refuse without overwriting the prior receipt.
Concurrent identical requests and retries after lost responses return the original
receipt after renewed ownership/classification/production-consent checks.

`applied` means persisted in the phone's lab/analysis/plan projections. It is **not**
active-plan adoption, practitioner approval, cloud personal-record publication or
clinic-transfer confirmation. A client assertion is not independent physical proof
of disk persistence. Status remains backward compatible; operational inspection of
the underlying synthetic test rows verified the stored acknowledgment separately.

V2 now waits for this validated receipt before clearing its pending request. A
missing endpoint, malformed response, outage, consent refusal or account change
keeps recovery available. Archive review preserves and executes the original
claim callback before saving and acknowledges `archived_not_applied` only after
the local snapshot and audit step succeed. Archive payloads contain no callbacks.

## Executed evidence

- Seven server tests cover claim and acknowledgment ordering, conditional races,
  replay, conflicting dispositions, changed content, wrong owners/devices,
  deletion and production consent refusal. Other AWS services are doubles there.
- `pwsh -NoProfile -File scripts/test-aws-lab-delivery.ps1 -ConfirmSyntheticFixtures`
  passed **13 actual DynamoDB assertions**, twice (including the final result-bound
  condition). It validates account588966314750, us-east-2, exact synthetic stack,
  PHI false/classification and physical table mapping/ARN before any writes.
- Two random fictional completed jobs per run; real simultaneous competing claims
  and simultaneous identical acknowledgments; no S3, model, workflow or email work.
  Exact owner/run-bound deletion and consistent read-back verified **zero remaining
  primary fixture rows**. Backups/PITR and AWS audit history were not purged.
- This runs the real handler locally against AWS DynamoDB. It does **not** exercise
  hosted API Gateway/JWT verification, phone storage, production consent database,
  clinic synchronization or model analysis. Report fields explicitly say so.

Run only in the named synthetic environment. The runner refuses other accounts,
tables, regions and non-synthetic posture. Any cleanup uncertainty prints the exact
fictional job ID and fails; it never scans or deletes unrelated jobs.

Remaining: physical interruption/restart/disk-full/lost-response/two-device tests, approved
retention and full privacy coverage. Lost-phone claim transfer, durable cloud
publication of results and active-plan reconciliation are still separate gaps.
No clinical/source hold, PHI restriction or paid-build authorization changed.

Local release checks: Desktop 1,679 tests passed /11 existing skips; V2 1,049
passed /one hosted skip; typechecks and lint passed (Desktop retains four old
warnings). A concurrent map rebuild caused two initial native-process timeouts;
the full Desktop rerun without competing extraction passed. Both lab artifacts
build and their infrastructure templates pass schema/reference lint.

The route-count output is corrected from28 to30 and is now checked against the
actual route definitions. The hosted recovery harness has an opt-in
`-TestDeliveryAcknowledgment` mode: two fictional Cognito identities, one new
unstarted request conditionally completed with a literal result, no upload/model
calls, real JWT claim/receipt/refusal/replay plus durable read-back. It cannot be
combined with upload or generation modes. The runner disables new test identities
and retains their audit history.

## Executed synthetic deployment and hosted acceptance

- Reviewed change set `recovery-b04551a1457f-20260916130806`, AWS account
  588966314750/us-east-2, stack `ai-clinical-core-synthetic-staging-lab-analysis`.
  UPDATE_COMPLETE, PHI false, synthetic_only, 30 routes. No running workflow at
  execution. Existing parameters/environment matched before update; no storage
  removal/replacement or data-permission expansion. Knowledge release disabled.
- Lambda ZIP hashes verified against all four deployed function configurations:
  API/cleanup/session authorizer
  `f44e102b54d5e948853f969e159f30594a400b1ef0585ef5ce35324bcbc93c8e`;
  worker `6cb1889ee443891b49abe6fb6674ed2f579a1b93d2d5b663d394b9b750823b8f`.
- Hosted acknowledgment mode with reviewed-context checks passed **31 distinct
  checks**, including actual Cognito JWT, route enforcement, Lambda/IAM/DynamoDB,
  unclaimed/wrong-user/wrong-device refusals, exact result digest, retry preserving
  all receipt values, disposition conflict and durable read-back after claim retry.
  No model call/upload in this mode. The fictional job was deleted via its API
  and subsequent GET returned404. Two temporary identities were signed out and
  disabled; cleanup metadata/audit/PITR history intentionally remain.
- Two earlier harness attempts failed on fixture assumptions: initialized-null
  result versus absent attribute, then order-sensitive JSON comparison of DynamoDB
  maps. Both were corrected without runtime changes; both attempts cleaned the
  job through the API and disabled both new identities. Final receipt comparison
  checks all four fields, including timestamp, regardless of property order.
- Real DynamoDB concurrency tests above remain separate from sequential hosted
  tests. No physical phone or App-to-Desktop data-transfer acceptance is implied.
- Separate hosted `-TestSavedPlanGeneration -TestReviewedContext` run passed
  **33 distinct checks /40 evaluations** using one fictional three-marker request
  and the existing server-side OpenAI credential. Completed result retained all
  values/units and unverified-source provenance, exact panel/analysis binding,
  tasks, source/context fingerprints and stable repeat retrieval. Cross-user
  running/completed reads refused. Generated job plus an unstarted recovery job
  were deleted via API and read-back returned404; two new identities disabled.
  No document upload/OCR or physical-device verification in that mode.
