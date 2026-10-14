# Program-purchase safety path (2026-10-14)

The current launch is the education-only Core. Consumer purchase, program-step purchase, lab-result/2 sending,
clinical attestation activation, PHI and production activation all stay off. Everything here is source, with
fictional data only:

- no deployment, no SQL registered or applied, no AWS change;
- no real patient data, no store product, no paid build;
- nothing merged to `main`.

Every candidate stays BLOCKED.

| Repository | Base (`agent/clinical-source-integrated-20261014`) | Branch |
| --- | --- | --- |
| AI_DESKTOP_PRO | `19beb7035e5db817291bd3fef9d6048ade2c7f58` | `claude/program-purchase-safety-20261014` |
| AI_LONGEVITY_PRO_V2 | `b2681a4e5cedb901a46b3265f02b388b7bcf1f8e` (with the V2 security merge) | `claude/program-purchase-safety-20261014` |

The V2 half is `expo/docs/claude-program-purchase-safety-return-2026-10-14.md` in AI_LONGEVITY_PRO_V2.

## One successor for work packages 1 and 2

`infra/aws-clinical-core/production-candidates/production-program-consumer-boundary.sql` is the program family's
consumer boundary (program-consumer-boundary/1). It is BLOCKED: applied nowhere, registered in no manifest, with its own
disabled activation row.

- **Parent:** the 106-migration production artifact plus, unchanged and in their documented order,
  `lab-result-transfer-v2.sql`, `lab-observation-attestation.sql` and `production-program-assignments.sql`.
- **Independent of** `lab-attestation-review.sql` and `program-step-purchase.sql`.
- **No pinned bytes change.** It calls the parent's request function and reads its private review functions, and
  redefines nothing the parent defines.

What it adds:

- `clinical_core.production_program_bounded_request(jsonb)` is the API role's only program entry point. `EXECUTE` on the
  parent's `clinical_core.production_program_assignment_request(jsonb)` is revoked from `clinical_core_api`, so the
  unredacted projection cannot be reached by calling it directly. The API role still cannot read the program tables
  either (the parent revoked that).
- `clinical_core.program_consumer_boundary_activation` is a disabled singleton. The API role cannot write it, and
  until it is enabled every request is refused with `program_boundary_disabled` and nothing is written.

### Work package 1: no purchase destination leaves the database through the API role

**The gap.** The parent's `read` (the consumer's view) and `preview` (the workforce's view of what a consumer would
see) returned the stored phases verbatim, so each supplement product's authored `purchaseUrl` reached the API role.
Only the TypeScript adapter blanked it, and only for `read`. The parent-alone characterization test in the new suite
shows this with SQL calls made as the API role.

**The repair.**

- **Redaction at the boundary.** Every action except `complete` is answered by the parent unchanged, and the answer
  then passes through `clinical_private.production_program_without_destinations`, which sets every `purchaseUrl` value
  at any depth to null. It is keyed on the name because the parent's content contract admits a destination only as
  `product.purchaseUrl`, so a later projection carrying one is covered too.
- **Refusals carry nothing.** They are the parent's fixed tokens: no content and no destination.

**What stays as authored.**

- **The practitioner's record.** `program_versions.content` and `program_assignments.content` keep exactly what was
  authored, and the parent's immutability trigger forbids changing assignment content anyway.
- **The digest.** The person accepts the authored artifact's own digest, so the redaction does not change it.
- **The authoring surface.** `invoke_program_operation` (from the 106-migration artifact) is gated to knowledge
  editors, refuses a consumer, and is not this family.

**The Desktop adapter.**

- `production-program-assignments.ts` now reaches the database only through the boundary entry point.
- It is enabled only with both pieces of evidence:
  - the parent's `production-program-activation/1`;
  - the boundary's own `program-consumer-boundary-activation/1`, naming both the parent digest and the boundary digest
    (`PRODUCTION_PROGRAM_BOUNDARY_CANDIDATE_SHA256`).
- It still blanks destinations itself as a second lock, now on `preview` as well as `read`.
- Nothing routes to it; the identity API still refuses program routes outside the synthetic boundary.

### Work package 2: a completion is decided against the review the person was shown

**The gap.** The parent's `complete` checked the assignment revision and that the item was in the current review's
`add`, but not the plan revision the person was shown. A completion made against an older review was applied whenever
the item was still listed:

- a new or corrected lab result;
- a plan changed on another device;
- a consent change.

The second parent-alone characterization test shows a completion applied after a new reading had already moved the
plan revision.

**The repair.** `complete` is decided inside the boundary (`clinical_private.production_program_bounded_complete`), in
one transaction, against one review:

1. The parent's authority checks, in the parent's order: activation, actor, request shape, pool, consent, enrollment,
   clinic, connection and owner.
2. The assignment row is locked, and the review (plan inventory and lab readings) is computed once.
3. The revision checks:
   - `sourceDigest` (`program_assignment_version_changed`);
   - `expectedRevision` (`program_assignment_revision_stale`);
   - the mandatory **`planRevision`** (`program_review_stale`).
4. The state and item checks (`program_item_held` unless the item is in that same review's `add`).
5. Only then the writes: the completion row, the revision, and the audit row.

A refused completion writes nothing. A completion without a plan revision is `program_assignment_invalid`. A retried
completion is never recorded twice: it names an assignment revision that no longer holds and is refused as stale, so
the app reads the current state. A refused completion retried unchanged stays refused.

**The decision boundary is one review.** The completion is decided against the review computed inside the locked
transaction. A reading committed by another transaction after that point is a later event: the next completion is
decided against it.

**The successor contract.**

- `src/contracts/programCompletion.ts` (`program-bound-completion/1`) is the completion with its plan revision. It is
  mirrored byte for byte to V2 and pinned in both repositories.
- The pinned `programAssignments.ts` is unchanged, and still refuses a plan revision on `complete`.
- `PROGRAM_BOUND_COMPLETION_ACCEPTED` is `false`. The service the app reaches today (the synthetic program family)
  answers the pinned request and would refuse the bound one. The flag turns on in the same reviewed change that
  activates the production family with its boundary. An app that was not updated then fails closed: its pinned
  completion is refused and nothing is applied.
- The Desktop adapter accepts only the bound completion and refuses the pinned one before the database.

### Rollback

`production-program-consumer-boundary-rollback.sql` is BLOCKED like its forward file. Its order matters: it switches
the program family OFF first, in the same transaction, because removing the boundary gives the API role the parent's
unredacted function back. Then it:

1. revokes the boundary entry point;
2. re-grants the parent;
3. drops the boundary's functions and activation table.

Nothing stored changes.

Checks after running it (run by the last test in the boundary suite):

- `production_program_activation.enabled` is false.
- The boundary entry point no longer exists.
- The parent is callable again and refuses with `production_program_disabled`.
- The boundary's table and private functions are gone.
- Assignment content, revision and completions are unchanged.

Re-enabling the family without the boundary would reintroduce the leak; that is not part of a rollback.

## Work package 3 (V2)

The V2 program screen no longer has any purchase path, so no program purchase button appears even with the general
consumer-purchase flag and the program-step flag both on.

- **Removed.** The generic `prepareProductPurchase(stableId)` handler and its imports are gone from
  `expo/app/programs.tsx`.
- **What a program step needs.** A step is bought only through the step-bound route (program-step-purchase/1, checked
  by the server at issue and at redemption), and that route is not wired or qualified.
- **Nothing opened.** No stored `purchaseUrl` is opened and no generic Fullscript action is substituted.

Details and tests are in the V2 return document.

## Candidates and contracts

| File | LF SHA-256 | Status |
| --- | --- | --- |
| `production-candidates/production-program-assignments.sql` (parent) | `78bd5b3805d96443829f6e7380deba0d66ad2f03073374bd6681f4f6bc25b4f3` | unchanged |
| `production-candidates/production-program-consumer-boundary.sql` | `ca0ce5a62e68638c7c29bd114018344c2755da946d1785f849e11088f8e1122d` | **new**, BLOCKED |
| `production-candidates/production-program-consumer-boundary-rollback.sql` | `d2a77bbd6c2661e2b7a2d1c2cc072712ddaa42bc99f50a3e642498007f475d68` | **new**, BLOCKED |
| `src/contracts/programCompletion.ts` (mirror) | `a002ec092dfb4798f81bb009609d1caddb46e63b00b2ca7983947f774074e477` | **new** |
| `src/contracts/programAssignments.ts` (mirror) | `96c2adb19703d3dcb3ca78c63f444d1eb936f8975839b5723ccc033b6336e62d` | unchanged |
| `src/contracts/programStepPurchase.ts` (mirror) | `417d0573c241262b4356a625627e2bf83e3db94468cdd0547f4e0891597d92a1` | unchanged |
| `production-candidates/program-step-purchase.sql` | `ad66f389221ca77681bc94a0f75b9d6ab45d9656e3431cce22e5cd026de042de` | unchanged |

## Tests

**`src/server/clinical-core/production-program-consumer-boundary.database.test.ts` (17).** Every call is SQL made as
`clinical_core_api`, never through the adapter. It covers:

- **The parent alone (2, characterization):**
  - the destination is handed to the API role by `read` and `preview`;
  - a completion against a changed review is applied.
- **BLOCKED:**
  - the disabled row refuses everything and writes nothing;
  - the API role cannot flip the row, call the parent, read the program tables or call the private completion.
- **Work package 1:**
  - an available step: `read`, `list`, `accept`, `complete` and `preview` carry no destination, while the authored
    record and digest are preserved;
  - a held step;
  - stale accepts and completions: the refusal is a reason only;
  - cross-owner and cross-clinic: one refusal, no answer;
  - `status`, `programs` and `connections` carry no destination, and the authoring surface refuses a consumer.
- **Work package 2:**
  - a pinned completion is refused with no write;
  - an authorized completion is recorded once, with one audit row;
  - race, result first (refused, no write, though the step is still in `add`);
  - race, completion first (the completion stands; the next one against the old view is refused);
  - a corrected reading and a plan changed on another device each refuse;
  - two devices on one view;
  - a retry is never written twice, and a refused completion stays refused;
  - held, cross-owner and cross-clinic completions are refused with no write.
- **Rollback** (last).

**Mutation check.** Deleting the plan-revision comparison fails 5 tests; making the redaction a no-op fails 2. The
candidate was restored to the pinned digest.

**`production-program-assignments.database.test.ts` (21, was 20).** It now runs against parent plus boundary. Its
assertions are unchanged, with these differences:

- the adapter needs both pieces of evidence (new assertions);
- each completion names the plan revision of the read it already makes;
- the direct-call test goes through the boundary entry point (still `production_program_disabled`) and adds that the
  parent is no longer executable by the API role;
- the preview carries no destination;
- the pinned completion is refused before the database.

**`src/contracts/programCompletion.test.ts` (3).**

**Failing before.** These were run on base `19beb703` with only the new test files and the new contract copied in; the
successor and the adapter change were absent.

- **The boundary suite.**
  - Both characterization tests pass: the API role is handed the destination, and the parent applies a completion
    against a changed review. That is the gap.
  - The 15 boundary tests did not run, because their setup cannot find the successor (`ENOENT`).
- **The updated program suite.** None of its 21 tests ran, for the same reason.
- **The mutation check above.** It shows the boundary tests fail when either repair is removed from the successor
  itself.

## Verification

Code heads: Desktop `f5278e372c3e4647e97c438c80be6545bb0b97e9`, V2 `6ad41ea1d8aea6ecb99c51c541c0c1f41b21d9e0`. The
commits after them change documentation and V2 release metadata only.

| Check | Desktop | V2 |
| --- | --- | --- |
| Full unit suite, base head | 547 files, 8,703 tests: 8,692 passed, 11 skipped (recorded at `e45b60cf`; `19beb703` adds only documentation) | not run at `b2681a4e` in this session |
| Full unit suite, code head | `npm run test:unit`: 549 files, 8,724 tests: 8,713 passed, 11 skipped, 0 failed | 314 files, 3,588 tests: 3,587 passed, 1 skipped (the existing hosted test), 0 failed |
| Typecheck and lint | clean (0 warnings) | clean (`expo lint`, 0 warnings) |
| Clinical build and `check:clinical-bundle` | passed; PASS, 327 client chunks | n/a |
| Gates | all pass (details below) | all pass (details below) |
| Launch-acceptance source cases | n/a | 8/8 passed (source digest `90e65096b6073a42d3b4b4daef236ba30b6dbd0fae22b081794ef4585e6daeab`); 9 hosted, device and human cases unobserved; acceptance withheld (exit 1, by design) |
| Store readiness | n/a | not submittable, the same 8 blockers (not touched) |
| CI on the pushed head | [run 38636695043](https://github.com/HolisticDrBright/AI_DESKTOP_PRO/actions/runs/38636695043) on `f5278e37`: success on attempt 2, all 11 jobs (see the note below); the deployed-backend job skips its suite without secrets and is not hosted evidence | [run 38636700247](https://github.com/HolisticDrBright/AI_LONGEVITY_PRO_V2/actions/runs/38636700247) on `53ee7981` (code `6ad41ea` plus the kit rebind): success, including typecheck, lint, the full suite and the kit regressions |

**Desktop gates (all pass):**

- `check:stub-reset` (142 bindings), `check:mock-imports`;
- `check:aws-clinical-core`, `check:aws-identity-consent`, `check:aws-authenticated-api`;
- `check:aws-desktop-compatibility-contract` (223 RPCs);
- `check:aws-desktop-operation-inventory` (228 operations, 0 enabled);
- `check:aws-production-clinical-core` (106 migrations, zero seeded rows);
- `check:aws-production-clinical-api`, `check:aws-core-launch-scope`;
- `test:migration-sql-bytes`, `test:e2e-order-config`.

**V2 gates (all pass):**

- `test:core-launch-scope`, `check:core-launch-scope` (mirror pinned, add-on programs unavailable);
- `test:store-readiness`, `check:store-readiness` (not submittable);
- `test:launch-acceptance` 22/22, `test:release-preflight` 10/10;
- `check:release-preflight` refuses as designed: 51 missing values, 0 refusals.

**Not run.**

- **The one-process browser battery.** None of the changed Desktop paths is reachable from it: an unapplied SQL
  candidate, an unrouted adapter, a new contract, the RDS classifier (used only by a hosted database), and tests. CI's
  contract-fixture browser jobs run on the pushed head; they are fixture evidence, not hosted.
- **Every hosted, device, provider, store and human case.**

**The 11 Desktop and 1 V2 skips** are the existing environment-dependent tests: 9 bridge round-trip tests, 2 tests
needing the external catalog package, and the V2 hosted recommendations test.

**One invocation slip, not a failure.** A first local full run made with bare `vitest run` reported 10 failures:

- one in `src/lib/dates.test.ts`, which asserts the `TZ` the `test:unit` script sets;
- nine in `program-step-purchase.database.test.ts`, whose setup had not yet loaded the boundary its adapter now
  requires. The setup was fixed and its assertions are unchanged.

The final run above is through `npm run test:unit`.

**The one CI re-run.** On attempt 1, contract-fixture browser shard 1 failed one test:
`e2e/live-capture-resume.spec.ts:115`, "cancelled resume ignores a late successful response". After the second resume
the recorder status went `resuming` then `paused`, never `recording`; 107 tests passed and 19 skipped.

- **Not this diff.** It touches nothing in `e2e/`, `src/components`, `src/app` or the stub.
- **It passes elsewhere.** The test passed in the base's CI and 6 of 6 times locally on `f5278e37`.
- **A likely mechanism.** `authorizeCaptureResume` sends the resume and then a heartbeat under an 8-second client
  deadline, and on expiry the app correctly stays `paused` (fail closed). A CI server slow on that one step crosses
  the deadline exactly as observed.
- **Not confirmed.** The failure artifact could not be fetched from this environment (the blob host is blocked by
  its proxy), so the mechanism is not confirmed.
- **The one re-run.** The failed job was re-run once, as the rules allow for a failure in untouched code, and passed.

This is recorded as an intermittent timing failure, not a pass: nothing was retried more than once and no test was
changed.

## Status

| | Work package 1, destination | Work package 2, bound completion | Work package 3, V2 bypass |
| --- | --- | --- | --- |
| Source implemented | yes (BLOCKED) | yes (BLOCKED, flag off) | yes |
| Locally verified | yes | yes | yes |
| CI verified | yes, at the code heads | yes, at the code heads | yes, at the code heads |
| Hosted verified | **no** | **no** | **no** |
| Device verified | **no** | **no** | **no** |
| Approved for PHI | **no** | **no** | **no** |

## Still unimplemented, or left for decision

- **The step-bound purchase route is not wired or qualified.** No app offers a program purchase. Before one does, the
  properties the removed V2 tests protected must be shown on that route:
  - current access verified first;
  - an action naming another product, or expired, never opened;
  - a session, account or background change discarding a late action;
  - the redemption check refusing an address outside the reviewed storefront.
- **The synthetic program family is unchanged.** It is the deployed staging service, fictional data only. Its own
  `complete` still does not compare the plan revision. That is why `PROGRAM_BOUND_COMPLETION_ACCEPTED` stays false.
- **Free text is not scrubbed.** An address typed into a program title or instruction is the practitioner's text, not
  a purchase binding. The boundary withholds the structured destination only. Whether authored text may carry an
  address is a content-review decision.
- **The production family stays disabled and unrouted.** Activating it needs both activation rows, both pieces of
  evidence, and the flag flipped in V2 in the same change.
- **The Windows full-suite hang is not reproduced here.** No Windows host was available; on Linux the full suite
  completed (see Verification). No test was changed, skipped or given a blanket timeout. The earlier proposal still
  stands: on the Windows host, run with `--reporter=verbose --reporter=hanging-process` to name the file, then bound
  only that file's synchronous child processes with `timeout` and `killSignal`. The interrupted run is not a pass.

## Codex: AWS-only packet

Nothing here asks for an AWS change during Core.

1. **Candidate order** (LF SHA-256):
   1. the 106-migration artifact;
   2. `lab-result-transfer-v2.sql` (`fa6ee162…be3b94`);
   3. `lab-observation-attestation.sql` (`d0423bce…94bb83`);
   4. `production-program-assignments.sql` (`78bd5b38…25b4f3`);
   5. **`production-program-consumer-boundary.sql`** (`ca0ce5a6…122d`), which needs 4.

   Independent of 5: `lab-attestation-review.sql` and `program-step-purchase.sql`. All stay unregistered and disabled.
   The rollback file (`d2a77bbd…5d68`) goes with 5, in the same reviewed change window.
2. **Activation, when decided.**
   - The boundary's own row: `program_consumer_boundary_activation`.
   - The parent's row: `production_program_activation`.
   - Adapter evidence: `production-program-activation/1` and `program-consumer-boundary-activation/1`, naming the
     parent and boundary digests.
   - V2's `PROGRAM_BOUND_COMPLETION_ACCEPTED`, flipped in the same change.
   - Never activate the family without the boundary.
3. **Hosted negative tests**, on the synthetic qualification stack with a seeded fictional destination:
   - **Grants.** The API role calling `production_program_assignment_request` directly gets `permission denied`.
     `select` on `program_assignments` or `program_versions` is denied.
   - **Disabled boundary.** It answers `program_boundary_disabled` for every action, with no audit row.
   - **No destination.**
     - The response bodies for `read`, `list`, `accept`, `complete` and workforce `preview`, for a held step and for
       an available step, contain no `purchaseUrl` value.
     - Cross-owner and cross-clinic refusals carry no destination.
     - The stored artifact still holds it.
   - **Pinned completion.** A completion without `planRevision` is `request_invalid`: no completion row, no audit
     row, revision unchanged.
   - **Stale review.** A completion after a new or corrected reading, or a plan change, made against the earlier
     read, is `409 program_review_stale`, with nothing written.
   - **Second device.** The second of two completions on one view is `409 program_revision_stale`.
   - **Rollback rehearsal**, on a disposable synthetic database only:
     - the family is disabled first;
     - the parent refuses with `production_program_disabled`;
     - stored rows are unchanged.
4. **RDS classification.** `program_boundary_disabled` is classified `operation_refused`, like
   `production_program_disabled`.
