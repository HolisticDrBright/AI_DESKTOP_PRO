# Revision-bound personal corrections

September 17, 2026. Original commercial phase 3. Source candidate only: no
persistent migration, AWS deployment, clinical approval or paid mobile build.

## What is connected

V2 Privacy Center → saved-record selection → explicit correction request →
AWS personal-storage API → owner-bound SQL target → reviewed operator resolution →
the owner's visible request ledger.

The new production overlay is
`20260917020000_production_owned_correction_resolution.sql`. Both repositories
carry the same `personalCorrection.ts` contract. Existing personal-storage
deployment gates and its fourteen JWT routes are unchanged; discovery uses
`GET /clinical-core/consumer/personal/privacy-request?view=correction-targets&collection=...`.
It returns at most 25 current nondeleted records, ordered by record ID, with
revision and server-computed payload digest. An `after` record ID advances the
page. It survives feature-consent withdrawal, but not identity/deployment failure.

Submission requires `personal-correction/1`, collection, record ID, expected
revision, expected payload digest, top-level field, proposed value and reason.
SQL validates the actual owner's latest revision under the owner lock. A missing,
foreign, deleted, stale or modified target is refused. The same command can be
retried after the record subsequently changes, but cannot be repurposed. Legacy
unbound pending commands are preserved and require support; they are not silently
rebased or resent.

The V2 form handles scalar string/number/boolean fields, preserving their type.
Empty numeric input is not zero. Arrays, objects and null-valued fields need a
domain-specific review workflow; the screen says so and does not flatten them.
Pages replace the previous page, bounding records rendered at once. Categories
are collapsed until requested. Submission is an explicit confirmation action,
never a mount effect. Account changes, abandoned confirmations, duplicate taps
and mismatched receipts are fenced. Request status can be refreshed. The Privacy
Center scroll area avoids the keyboard, but physical iOS/Android verification
is still required.

## Resolution is verification, not a clinical write bypass

An assigned, unexpired owner-specific workforce privacy operator can call:

```sql
select clinical_private.resolve_owned_correction(
  :privacy_request_id, :outcome, :applied_revision, :explanation
);
```

Use bound parameters in a reviewed administrative workflow, not string-built SQL.
`applied` requires an actual successor already saved through the ordinary
authorized record-writing path. Under the owner lock, SQL verifies the original
payload/request hashes and that the current latest payload equals the original
with exactly the requested top-level field changed. Unrelated changes, stale
successors, deleted targets, missing history or a value that was never applied
refuse resolution. This function does not write a record, change a consent,
approve a protocol, adopt an active plan, reinterpret a lab or edit a source file.

The immutable resolution records before/request/after evidence, applied revision,
operator, explanation and timestamp. The request becomes completed in the same
transaction. Exact retries reuse the resolution; changed retries conflict.
`declined` requires an explanation and no applied revision; it records refused,
not completed. Existing legal holds and owner/operator restrictions apply.
Legacy completed corrections without evidence are labelled as needing
verification in V2; they are not rewritten.

The ordinary generic deletion-completion operation still refuses corrections;
only the evidence-bound resolution operation can complete a new correction.

## Verification and remaining work

Local tests execute all 59 production migrations in isolated PostgreSQL using
fictional fixtures. They exercise actual SQL permissions, target hashes and
revisions, idempotency, cross-owner denial, append-only resolution, legal holds,
exact delta verification and the real API/adapter/database round trip. V2 tests
exercise typed drafts, strict response schemas, account changes, paging,
concurrency, ambiguous responses and preservation of legacy commands.

This is not a complete deployed correction service. Remaining engineering:
a reviewed workforce operations interface/queue, safe application of corrections
through each domain's existing write path, nested/structured-field editing,
source lab/document and clinic-specific amendments, cross-store propagation,
complete request-history pagination and large-account acceptance. Personal
record-history purge does not erase this privacy request/resolution audit;
its retention needs a reviewed policy. Operator explanations may contain
sensitive information and must stay in the authenticated privacy workflow.

Required release verification: exact-source CI and coordinated SQL/API/mobile
rollout, hosted JWT/role tests, distributed concurrency, physical keyboard and
account-switch tests. No policy, operator assignment, PHI scope, clinical hold,
source verification or provider approval is activated by these changes.
