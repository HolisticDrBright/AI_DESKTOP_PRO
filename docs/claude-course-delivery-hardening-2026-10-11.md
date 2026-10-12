# Course delivery and learner release hardening (2026-10-11 handoff, returned 2026-10-12)

Source engineering only. Nothing here applied a schema, contacted AWS, Stripe or any provider,
read a secret, created a product or price, registered a webhook, activated, published, built for
mobile or enabled PHI. Prices, billing frequency, duration, access terms, refunds, renewals, taxes,
purchaser-contact authority, code lifetime and storefront classification remain undecided; the
bounds in source (for example the 7-day claim validity and the 1 MiB reply bound) are bounds, not
policy. An education purchase grants its reviewed education access and nothing else: not Core
(separately $19.99/month), peptides, the longevity add-on, clinic membership, health sharing,
clinical enrollment, supplements, a protocol or a phase advancement. Lesson media stays held; the
frozen media preview head `1c618f5` on `agent/program-media-preview-delivery-20261011` was not
edited, merged or turned into a learner URL.

The V2 half is `expo/docs/claude-course-delivery-hardening-2026-10-11.md` in
HolisticDrBright/AI_LONGEVITY_PRO_V2.

## Work package one: V2 progress integrity (Desktop side: the mirror)

The mirrored `program-education-progress/1` contract (`src/contracts/programEducationProgress.ts`,
byte-identical to V2 `expo/contracts/programEducationProgress.ts`):

- `MAX_PHASES` 52 and `MAX_PHASE_ITEMS` 100 (the published content's bounds), `MAX_LESSONS` their product;
- `courseLessons(...)` returns `problem: null | 'partial' | 'ambiguous' | 'oversized'`. Item ids are unique
  across the whole curriculum, as `programAssignments.ts` requires of published content. Ambiguous and
  oversized outlines carry no lessons at all: no navigation, no count, no resume point;
- an `educationProgress` with two completions of one lesson does not parse.

Desktop effect: the in-memory ledger never appended a duplicate completion, and the SQL candidate keys
completions by `(enrollment_id, phase_id, item_id)`, so the server never produced one (already correct).
An ambiguous outline now yields no lessons, so a write against it is refused `unknown_lesson`.
`src/server/commerce/education-progress.test.ts` asserts the mirrored rules on the Desktop side.

Mirror digest: `cea4725b690d7976a20f2d5b1e6f2c784167c1af87e781620f9e310c76484aac` (predecessor
`c86676406c05242aac330f7c2973521dea80f4862a93a5598f4912279ee40630`). `programEducationAccess.ts` is
unchanged (`61b8df5a…70005d3`).

The V2 transport and screen repairs, their failing-before evidence (22 of 28 transport and contract
cases and 3 of 9 mounted cases failing on `160bc78`) and the already-correct cases are in the V2 document.

## Work package two: My courses on the Desktop

### What a learner gets

`/courses`: the learner's own purchased courses, the exact purchased version, phases and lessons,
Back and Next, an explicit "Mark this lesson complete", and a resume point. Text lessons are the
lesson as published; where a lesson has video, the page says "Lesson video is not available here
yet", and no preview address is offered. Supplement steps say they are reviewed with a practitioner
before anything is added. There is no purchase link, price, claim form or protocol action on the page.
The public funnel (`/learn/<slug>`), the purchase pages, the practitioner Studio and the mock
education programs are untouched.

### Authority

| Step | Who decides | Where |
| --- | --- | --- |
| Reaching the page | nobody: it carries nothing private | `src/app/courses/page.tsx`; the middleware admits exactly `/courses` (not `/courses/x`, `/course`, `/courses-admin`) without a workforce session |
| Who the learner is | the learner host's `identify(request)`: the reviewed host's own authentication | `src/server/learner/learner-host.ts` |
| Access view, curriculum, progress | the existing education access and progress services (consumer pool, synthetic boundary, activation evidence naming the candidates), over the host's store | `education-access-service.ts`, `education-progress-service.ts` |
| A reply reaching the browser | the route, only if the same learner is still verified after the service call | `src/app/api/my-courses/route.ts` |
| What the page shows | the controller, only answers bound to the course it is opening | `src/lib/learner/learnerController.ts`, `learnerTransport.ts` |

A workforce session, a course slug, a cookie the host does not recognise, or a subject, person or
clinic in the request body is not consumer ownership: the body is exactly `{service, body}` and is
refused otherwise.

### The integration interface (for Codex)

```ts
type LearnerHost = {
  kind: 'reviewed';
  identify(request: Request): Promise<ClinicalRequestContext | null>; // the host's own session verification and revocation
  services(): { education: (context, body) => Promise<EducationAccessResponse>;   // createEducationAccessService(...)
                progress:  (context, body) => Promise<EducationProgressResponse> }; // createEducationProgressService(...)
};
installLearnerHost(host); // once, from the deployment's reviewed bootstrap; refuses any other kind and a second install
```

Nothing in this source calls `installLearnerHost`. Without it, `/api/my-courses` answers
`503 learner_host_unavailable` and constructs nothing (asserted: the checkout selection stays
`disabled`), and the page says that My courses is not connected on this server, which is not the same
as having no courses. The journey fixture's host exists only under the contract fixture AND
`COMMERCE_JOURNEY_FIXTURE=1`; its two learners are signed in by the fixture route's
`learner_session` stand-in (an opaque http-only session) and revoked by `learner_revoke`.

### Lifecycle

- Identity is verified before each service call and again after it. A reply finished for a learner who
  was signed out, revoked or replaced meanwhile is discarded and answered `401` (a write that the
  service recorded stays recorded; a retry with the same request id gets its receipt).
- Every answer is `Cache-Control: no-store, private` with `Vary: Cookie`; the page is no-store,
  no-referrer and same-origin CSP (`frame-ancestors 'none'`, `connect-src 'self'`).
- The browser transport: one deadline over request and body, a 1 MiB received-byte bound with
  Content-Length agreement, strict UTF-8, redirects refused; a transport that ignores the abort cannot
  commit a late answer.
- The controller drops everything private (view, course, lessons, progress, pending save) on a sign-in
  or access refusal, on a different account's access view, and before another course is read; every
  answer belongs to a generation and an earlier generation's answer is discarded. Returning to the tab
  supersedes in-flight work and re-reads access, curriculum and progress.
- A completion shows as saved only after the receipt; a failed save says so and retries the same
  request; a tab or device that is behind is shown the saved record, never a merge.

### Tests

| Suite | Cases | What it holds |
| --- | --- | --- |
| `src/app/api/my-courses/route.test.ts` | 9 | no host: unavailable, nothing constructed; same-origin only; no learner, a workforce session or a made-up token is not a learner; body subject refused; the fixture host's real services for two learners and a revoked session; a reviewed host's identity lapsing or changing while the service is held at a barrier |
| `src/lib/learner/learnerController.test.ts` | 10 | revoked access while a read or save is pending; a superseded save; switching course; another account; two tabs on one revision-checked service; outline problems send nothing |
| `src/lib/learner/learnerTransport.test.ts` | 9 | wire posture, byte bound, Content-Length, UTF-8, redirect, deadline with an abort-ignoring transport, stalled body, refusal mapping, bindings |
| `src/middleware.test.ts` | +1 | exactly `/courses` |
| `src/lib/funnel-headers.test.ts` | +1 | `/courses` headers; the existing "no funnel API route" assertion is unchanged (the route was named `/api/my-courses` to respect it) |
| `e2e/commerce-journey.spec.ts` case 8 | 1 | the page in a browser: no learner, then the exact course, a completion with a receipt, a tab that is behind, revocation elsewhere clearing the open lesson, a second learner |

## Work package three: the SQL acceptance host

`src/server/commerce/sql-acceptance-host.ts`, gated by `sql-acceptance-gate.ts` (contract fixture AND
`COMMERCE_SQL_ACCEPTANCE=1`), constructed only by its test.

- **Schema:** the migration manifest, then the seven commerce candidates in parent order, each compared
  with its pinned SHA-256 before it is applied, once, on a fresh directory of an on-disk embedded
  database (PGlite 0.5.8 `dataDir`). A reopened directory is used as found.
- **Sessions:** API, worker, delivery and operator handles whose transactions run with the SESSION user
  switched to the role and checked (`session_user = current_user = role`); a role cannot `set role` into
  another. The embedded engine authenticates one bootstrap user, so these are not separate logins;
  separate logins are hosted acceptance.
- **Above the ledgers:** the real checkout, settlement, claim delivery, worker, and education access and
  progress services. The real webhook and My courses route handlers run on it through
  `installAcceptanceCheckout` and `installAcceptanceLearnerHost`, both refused outside the gate.
- **Named boundaries kept across restarts:** the fictional processor, purchaser contacts, delivery
  provider and mailbox, identity issuer and sealing key. Time passing is `elapse` (triggers suspended for
  one bootstrap statement, the candidate tests' technique), used once, for claim expiry.

### Cases (`src/server/commerce/sql-acceptance.database.test.ts`, 14)

1. Without its flag: does not open, cannot be installed, routes do not see it.
2. Whole chain built once; real role sessions; the API role cannot assume the worker role or read tables; the delivery role cannot reissue.
3. Admitted checkout with a lost creation reply (same order), delayed payment through the signed webhook route; a **fresh instance** after the acknowledgment processes it to `payment_processing`; the async success event (and its duplicate, recorded as a duplicate); another **fresh instance** settles and delivers; the code is in no staff status.
4. A verified consumer claims; a retry gets the same receipt; another account is refused; My courses (route, SQL) serves exactly the purchased pin; the other learner gets `not_owner`; no learner gets 401.
5. Repaired gap (below): settlement over the SQL ledger without the store's curriculum read answers `version_missing`; with it, `served`.
6. A completion survives a **fresh instance**; the same save after it returns the same receipt.
7. A **separate OS process** (`src/test-support/sql-acceptance-child.ts` under `jiti`) opens the closed database, records a resume point through the real progress service and exits; this process reopens and reads it.
8. A save that is behind (`revision_stale` with the saved record), another curriculum version (`stale_version`), an unknown lesson, another learner (`not_owner`).
9. A refund hold withholds the curriculum and refuses progress; the operator's release restores both.
10. A second learner buys and claims their own course; neither sees the other's; another clinic's clinician sees nothing of this clinic, and naming this clinic is refused.
11. A delivery **selected before** its claim is replaced (held at a barrier in the contact read): the provider carries the old code, the record of that attempt is refused (`lost_race`), the old delivery stays `withdrawn`, the old code is refused `claim_superseded`, and only the replacement works; a claimed entitlement takes no further replacement.
12. A replacement made **before** the pass selects anything: the earlier unknown attempt is withdrawn, one message goes out, and the replacement's delivery is `accepted`; an elapsed claim is refused `claim_expired`.
13. The My courses page logic itself (the browser transport and the lifecycle controller) through the real route on the SQL host: the bought course, a completion saved with its receipt and confirmed by a fresh read, and everything dropped when the session is revoked.
14. A store outage answers 503, never an empty course list.

Two protections showed up while writing these and were kept: delivery rows refuse an update that does
not advance the attempt (`program_delivery_attempt_must_increase`), and claim timestamps are immutable
(`program_claim_identity_immutable`), even for the bootstrap user.

PGlite runs one connection and serializes every statement. Nothing here is evidence of PostgreSQL lock
contention between real sessions; that is hosted acceptance.

### Repaired gap: the consumer curriculum on the SQL chain

`createSqlEducationLedger` had no consumer curriculum read, although the authority successor defines
`commercial_education.education_curriculum_for_caller`. Settlement read the content through a callback
that only the in-memory fixture fills, so a SQL-backed deployment would have withheld every bought course
as `version_missing` (case 5 reproduces it). The ledger interface gains an optional
`curriculumForCaller(caller, entitlementId)`; the SQL ledger implements it on the API handle with the
verified consumer context; settlement uses the store's answer when the store provides one. The in-memory
ledger does not implement it, so its path is unchanged.

## Defect found in the returned tests

The journey tests read the delivered code with `/\b([A-Za-z0-9_-]{43})\b/`. A base64url code that starts
or ends with `-` has no word boundary there, so roughly one run in twenty could not find its code
(observed once in 21 repeated runs of the new route test). The code is on its own line; the pattern is now
`/^([A-Za-z0-9_-]{43})$/m` in the fixture route test and the browser journey. Delivery was correct.

## Verification on the code head `f95b529` (and the documentation commit after it)

| Check | Result |
| --- | --- |
| `npm run lint`, `tsc --noEmit` | exit 0 |
| `npm run test:unit` | exit 0: 504 files, 7,809 passed, 11 skipped (existing) |
| Gates (32) | 28 pass; the same four refuse for their inputs as on every predecessor: production readiness and the first real-data pilot need a reviewed local manifest, the production foundation needs its build output, qualification capacity needs its arguments |
| `build:security-qualification` + `qualify:security` | exit 0: 29 of 29, evidence `13b94f51…061f1a` |
| `APP_EDITION=clinical` build, `check:clinical-bundle` | exit 0; 320 client chunks clean; `/courses` and `/api/my-courses` built |
| `e2e/commerce-journey.spec.ts` with the journey flag | 8 passed (1.0 m), including case 8 |
| `sql-acceptance.database.test.ts` | 14 passed; 13 of them passed three runs in a row before case 13 was added |
| Browser battery, forward (29 specs) | 307 passed, 2 failed, 19 skipped, 5 did not run (30.8 m) |
| Browser battery, reverse (29 specs) | 298 passed, 1 failed, 19 skipped, 15 did not run (34.0 m) |

The three battery failures, as observed, not re-run: forward `live-overview-reasoning.spec.ts:44`
(`page.goto` ERR_CONNECTION_RESET while the dev server restarted under its memory guard) and
`live-telehealth.spec.ts:231` (`waitForURL` ERR_CONNECTION_REFUSED, the same restart; the serial suite's
later cases did not run); reverse `live-plans.spec.ts:124` (the "invoice drafted" notice was empty). Each
passed in the other direction, none touches a file this branch changes, and CI on `f95b529` passed every
live case in its shards. |

## Return summary

### 1. Bases, branches, commits, remote match and CI

| Repository | Branch | Base | Code head | Final head |
| --- | --- | --- | --- | --- |
| HolisticDrBright/AI_DESKTOP_PRO | `claude/course-delivery-hardening-20261011` | `8e8c6ad` (the returned commerce record on `0858921`) | `f95b529` | the documentation commit after it |
| HolisticDrBright/AI_LONGEVITY_PRO_V2 | `claude/course-delivery-hardening-20261011` | `160bc78` | `5c9d8cd` | the kit and documentation commit after it |

The source pair is Desktop `f95b529` / V2 `5c9d8cd`. After them: in V2 the acceptance index, its test's
fixture clock and the V2 document; in Desktop this record, its CLAUDE.md index row, and one added SQL
acceptance case (case 13, the page logic over the SQL host), which is test-only and changes no product
source.

Desktop commits: `0eb7d78` (WP1 mirror), `7252eca` (journey code-reading repair), `fd523c4` (WP2),
`f95b529` (WP3), then the record. V2: `5c9d8cd` (WP1), then the kit and record. Nothing was reset,
force-pushed or merged from main; no PR was opened. The Desktop branch's four code commits were written on
`0858921` and rebased onto `8e8c6ad` before their first push (they had never been pushed). Remote heads
were read back after each push and matched.

The previous assignment closed first: its record commit `8e8c6ad` on `claude/program-commerce-closure-20261011`,
CI 38211113573 **success**.

CI, as observed:

| Repository | Run | Head | Result |
| --- | --- | --- | --- |
| Desktop | 38211113573 | `8e8c6ad` (previous record) | **success** |
| Desktop | 38212983985 | `f95b529` (code head) | **success**, 11 of 11 jobs; the journey step (8 cases) passed; the deployed-backend job skipped itself without its secrets, which is not a hosted positive |
| V2 | 38212981094 | `5c9d8cd` (code head) | **success** |
| V2 | 38213415625 | `4d0cb25` (kit and V2 record) | **success** |
| Desktop | reported in the hand-back | this record | observed after push |

### 2. Reproductions, repairs, already correct, unresolved

| Item | Before | After | Where |
| --- | --- | --- | --- |
| V2 progress and access transport, outline, completions, screen | 26 of 40 new cases failed on `160bc78` | 40 of 40 | V2 document |
| SQL consumer curriculum gap | `version_missing` for a bought course over the SQL ledger (case 5) | served by `education_curriculum_for_caller` | this document, WP3 |
| Claim-code reading in the journey tests | one failure in 21 repeated runs (a code beginning with `-`) | line-anchored pattern | this document |
| Desktop learner surface | absent | WP2 | new suites |
| Durable SQL acceptance | absent | WP3 | 14 cases |

Already correct and kept: the abort-ignoring deadline, session and environment changes during a V2
request, the V2 screen's lifecycle fences (seven mounted cases), the server never producing duplicate
completions, the delivery-row and claim-timestamp triggers, and the existing funnel-route assertion
(the new route was named to respect it).

Unresolved, stated rather than decided:

- The 1 MiB reply bound in both V2 clients is the existing bound, now counted in bytes. The progress
  contract's theoretical maximum (5,200 completions with 160-character ids) exceeds it; such a reply is
  unavailable, never truncated. Raising it is a decision.
- A write the service recorded for a learner whose session lapsed before the reply is answered 401; the
  write stands and a retry with the same request id returns its receipt. That is deliberate.
- Without a stream reader (some native fetch implementations), the V2 clients accept only a declared length
  and refuse a decoder's replacement character; byte-exact strictness needs the stream reader.
- The SQL acceptance sessions switch the session user under one bootstrap login; separate logins per role
  are hosted acceptance.
- My courses has no claim form; a learner redeems a code in the app.

### 3. Mirrors, candidates, the reduced-role call inventory

Mirrors (byte-identical, Desktop `src/contracts` = V2 `expo/contracts`): `programEducationProgress.ts`
`cea4725b690d7976a20f2d5b1e6f2c784167c1af87e781620f9e310c76484aac` (predecessor `c8667640…20630`);
`programEducationAccess.ts` `61b8df5a09f5255bef1b1a9cf7d7c70933491504d22559a9ee692088e70005d3` (unchanged).

Candidates, in parent order, SHA-256 of the bytes (LF; the LF-normalized digests are identical). None changed here, so no BLOCKED successor was needed:

| Order | Candidate | SHA-256 |
| --- | --- | --- |
| 1 | `program-offer-revisions.sql` | `4973461564e6812906403525cb3aa109d6fd569eec159c9400fcf568a90b321f` |
| 2 | `program-checkout-orders.sql` | `767ac13bc111a15b98bdc2978a5e42a33f5f1ab61f010061907787040b0c37ee` |
| 3 | `program-checkout-recovery.sql` | `29d85d75da43176b1a6d007afc5a0a892f99a08994f44bb459a4a756e2e2efc0` |
| 4 | `program-education-access.sql` | `e4f11e29f1b6a68f1478dbc112aaac1ea2bbf72adf86f9458dd5a20c8151df93` |
| 5 | `program-education-delivery.sql` | `653965ff19f1d522067a6b636ac4ed5a4d2f9f1696cbb692c9545e3fc2046ae6` |
| 6 | `program-commerce-authority.sql` | `11e53bc2e7ff13d1aa66c219fc9da1c4e768faef8ea42e1ebc44ed375a8c6c62` |
| 7 | `program-education-progress.sql` | `7d4b3ee7027dca24e91423b409bc1cf5e387689e14d154ede448348f655a2eb5` |

No installed historical migration or shared identity privilege changed. `src/server/clinical-core/rds-data-database.ts`
is unchanged; the overlap Codex integrates there is additive only: the four role handles the SQL ledgers
take (API, worker, delivery, operator) would each be an RDS Data API `ClinicalCoreDatabase` under its own
reviewed credential, and this branch adds one API-role call to what those handles carry,
`commercial_education.education_curriculum_for_caller(uuid)` (already granted to `clinical_core_api` by the
authority successor).

Calls by role, as the SQL ledgers make them (the checkout ledger takes one handle per authority and the candidate grants decide what each role may call; the education ledger takes four handles):

| Role | Calls |
| --- | --- |
| `clinical_core_api` (consumer context) | `claim_program_entitlement_for_caller`, `education_access_for_caller`, `own_program_entitlement_for_caller`, `education_curriculum_for_caller` (new use), `education_progress_for_caller`, `record_education_progress_for_caller` |
| `clinical_core_api` (workforce context) | `program_education_status`, `education_curriculum_staff`, the offer commands (`execute_program_offer_command`, `read_program_offer`, `program_purchase_availability`), the request-side checkout ledger (`admit_program_order`, `advance_program_checkout` for creation-side transitions, `admit_checkout_intake`, `read_program_order`, `find_program_order_by_session`) |
| `commercial_education_worker` | `settle_program_order_sealed`, `unsettled_program_orders`, `read_program_entitlement`, `entitlement_for_order`, `expire_program_entitlements_due`, the worker-side checkout ledger (`transition_program_order` for every transition, `due_checkout_intake`, `read_checkout_intake`, `settle_checkout_intake`, `program_orders_in_states`, `checkout_work_status`) |
| `commercial_education_delivery` | `due_program_claim_deliveries`, `record_program_claim_delivery` |
| `commercial_education_operator` | `reissue_program_claim`, `record_entitlement_policy`, `transition_program_entitlement` |

Denied and asserted: the API role assuming the worker role, the API role reading `program_orders`, the
delivery role reissuing a claim (`sql-acceptance.database.test.ts` case 2); a clinician naming another
clinic (case 10); and the candidate tests' existing direct-call refusals. No token, key or code appears in
this document.

### 4. Owner to purchased curriculum: the authority map

1. Purchase: the visitor's attempt key admits one order (a lost creation reply returns the same order and session); the processor's signed event is admitted by the webhook route and acknowledged, nothing more.
2. The worker (a fresh instance after any restart) processes intake, reconciles the order, settles it into one entitlement awaiting claim, and queues one sealed delivery.
3. Delivery sends the code to the processor-held contact; provider acceptance is recorded as acceptance, not arrival. A delivery whose claim was replaced cannot record success, and its code is refused.
4. Claim: the verified consumer context binds the entitlement once; a retry gets the same receipt; anyone else is refused; one enrollment follows.
5. Reading: the host's identity, then the store's own checks (owner, active window by the database clock, exact version and digest) for access, curriculum and progress; the route re-verifies identity after the call; the client accepts only answers bound to the entitlement, enrollment and pin it is opening.
6. Writing: explicit completion or a resume point, revision-checked, request-id idempotent, receipt-confirmed; a stale device is shown the saved record.
7. Holds and endings: a policy hold or an ended window closes curriculum and progress until the operator's recorded release.

Durable receipts and recovery: the order, intake, entitlement, claim, delivery attempts, enrollment,
completions and progress receipts are rows; WP3 recovers each step from them in a fresh instance and a
separate process.

### 5. Ordered Codex inputs

1. Consumer identity: an `identify(request)` that verifies the consumer session and its revocation, and builds the verified consumer context (person, subject, pool). Staff (workforce) and operator identity factories for the status, curriculum and policy paths. A worker identity for scheduling. The delivery identity for the delivery role.
2. Restricted database sessions: one credential per role (API, worker, delivery, operator), each a separate login, wired as `ClinicalCoreDatabase` handles (see `rds-data-database.ts` above).
3. Reviewed processor authority: the Stripe test-mode transport (`program-checkout-stripe.ts`) and the account and API version the webhook expects.
4. Sealing: a reviewed KMS key and context for `ClaimSealer` (the fixture's fixed key exists only for the acceptance host).
5. Transactional delivery: a generic email provider behind `ClaimDeliveryProvider` with idempotency keys, and the processor-held purchaser contact behind `PurchaserContactAuthority`.
6. Worker scheduling and alarms: run `createCommerceWorker(...).runOnce()` on a schedule; alarm on `intake_unavailable`, `deliveries_unavailable`, `provider_unknown` beyond its retries, and `lost_race` counts.
7. Route registration: `POST /clinical-core/consumer/education` and `/progress` (the seams), and `installLearnerHost(...)` in the Desktop deployment's reviewed bootstrap for `/courses`.
8. Rollback and custody: the seven candidates applied in order under schema custody, preserving rollback; nothing here applies them.
9. Same-target catalog and held learner media: the curriculum served from the same target the offer was bound to; lesson media stays held until a learner-authorized media path exists (not the original-author preview).

### 6. Production port, separately from current qualification source

The services above enforce the synthetic boundary (`environment: 'synthetic-staging'`,
`dataClassification: 'synthetic_only'`) and refuse anything else; the request-context function and the
qualification tables they run on are the synthetic families. A production education family needs its own
reviewed schema, a production request context, the production identity pools, and PHI-off confirmation.
None of that is assumed from the synthetic-only bridges, and nothing here describes them as an installed
production service.

### 7. Hosted acceptance owed

- Sandbox delayed payment and reconciliation with the real processor in test mode.
- Real generic email delivery: provider acceptance, a bounce, and a lost reply against the provider's idempotency.
- An independent worker restart on hosted infrastructure, against the hosted database.
- Direct-role isolation with separate logins per role, and real lock contention between concurrent sessions (PGlite serializes; nothing here shows contention).
- Two-device course and progress delivery between a physical phone and the Desktop page.
- Physical iOS and Android runs, the storefront, and the commercial and policy approvals stay with the owner and Codex.

A successful secrets-gated CI job is not a hosted positive: the deployed-backend job skips itself without its secrets.

### 8. Remaining engineering versus decisions

Engineering: the production identity, session, delivery, sealing and scheduling factories above; route
registration; the hosted cases in 7; a native media path; a claim path on the Desktop page if wanted.

Decisions (Brandon's): prices, billing frequency, duration, access terms, refunds, renewals, taxes,
purchaser-contact authority, code lifetime, the reply bound, storefront and territory classification, and
whether staff may see a learner's progress. Both consultation and direct purchase stay. No original
readiness phase is closed by this packet.

### Graphify: append-ready

This container cannot read the shared map; the block carries no section number. Assign the next number
when appending, after reading the map's end fresh under its modification-time and hash guard; preserve
every prior byte and leave the canvas untouched. No graph tool is installed here, so no AST-only Graphify
run happened in this container.

```
NNN. Course delivery and learner release hardening (2026-10-12) — branch claude/course-delivery-hardening-20261011
     Desktop 0eb7d78 (WP1 mirror) 7252eca (journey code-reading repair) fd523c4 (WP2 My courses) f95b529 (WP3 SQL acceptance) + record; base 8e8c6ad
     V2 5c9d8cd (WP1 bounded, version-bound progress and access clients) + kit and record; base 160bc78
     Contracts: programEducationProgress.ts cea4725b… (mirror; was c8667640…), programEducationAccess.ts 61b8df5a… unchanged
     Desktop nodes: src/server/learner/learner-host.ts (LearnerHost, installLearnerHost, selectLearnerHost),
       src/app/api/my-courses/route.ts, src/app/courses/page.tsx, src/components/learner/LearnerCourses.tsx,
       src/lib/learner/{learnerTransport,learnerController}.ts,
       src/server/commerce/{sql-acceptance-gate,sql-acceptance-host}.ts, ProgramEducationLedger.curriculumForCaller
     V2 nodes: lib/net/boundedResponse.ts, lib/education/{educationBody,awsEducationProgress,awsEducationAccess}.ts (ProgressBinding), app/education.tsx
     Edges: My courses -> learner host -> education access/progress services -> SQL ledgers (API role) ; settlement.curriculum -> education_curriculum_for_caller
     Evidence: V2 26/40 failing before -> 40/40; SQL acceptance 14 (fresh instance + separate process); journey 8 browser cases
     Owed: hosted processor/email/worker restart, separate-login role isolation and contention, two-device physical delivery
```

