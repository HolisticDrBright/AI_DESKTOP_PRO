# Synthetic messaging deployment and program release blockers

September 29, 2026 Pacific time; hosted acceptance completed September 30 at 01:54:36 UTC. Codex executed this checkpoint. PHI remains disabled, and no production, mobile or Desktop web release occurred.

## Outcome

Synthetic messaging settlement is deployed and has passed the hosted API acceptance below. Program assignments are deliberately **not deployed**: an independent negative test reproduced an approval-bypass flaw in the supplied program service. The larger qualification fleet is still blocked by capacity.

| Item | Verified state |
| --- | --- |
| AWS identity | Synthetic account 588966314750, us-east-2, profile ai-synthetic-staging |
| Original staging database | clinical_core, ledger 32 → 33 |
| Separate qualification database | clinical_core_qualification, 103 entries; latest 20260928010000, unchanged |
| Migration applied | 20260929110000_synthetic_care_message_settlement.sql |
| Migration SHA-256 | 7777a42ab16df9d487e27914c59740230f72fbca6c183c44f18493e9dcd3929a |
| Migration withheld | 20260929120000_synthetic_program_assignments.sql; not applied |
| Runtime source | b55e7740e2c56fa20fda55ef149f6a7e4f8f0244, integrated from Claude without rebasing |
| Identity bundle SHA-256 | 6cec1bcdc82aa1760d16f47359bb3f39e03b09c8a356def804f645943105ae4a; reproduced Claude's build |
| ZIP SHA-256 | e960709e08d219ea2142a8c0e76281cf440ffd6d921f36a18327ee89cd97f91e |
| Deployed Lambda CodeSha256 | 6WBwngjSGeohQqjA52KBz0QP/W2SHzahgyfuic2X+R4= |
| Stack | ai-clinical-core-synthetic-staging-authenticated-api, UPDATE_COMPLETE |
| Change set | care-message-settlement-b55e774-20260930 |
| Deployed route template | Existing 35-route identity template retained using UsePreviousTemplate; not the new 37-route source template |
| Function configuration | Active, update Successful, 15-second timeout, 256 MB, no reserved concurrency |
| Installed mobile / hosted Desktop web | Still TestFlight 71 / ed3ab67 and Desktop c6efae0; neither was rebuilt |

The reviewed change set modified only IdentityApiFunction and IdentityApiIntegration, without replacements. IAM, route resources and reservation configuration were unchanged. The bundle contains the new program implementation, but the two program routes remain absent and the API has no default/proxy route that would expose them. Authenticated requests to both program URLs returned 404 in acceptance. Do not add those routes before fixing the findings below.

## Capacity and recovery corrections to the incoming handoff

Lambda get-account-settings still reports total concurrency 10 and unreserved concurrency 10. No quota approval was observed. The fleet needing 35 reserved executions remains blocked; do not confuse 35 reserved with a total quota of 35, or remove function caps to get past it. The repository capacity checker also requires locally generated templates and initially refused because recording-cleanup-execution/template.json was absent; that tool failure was not counted as a capacity pass. Actual AWS account settings were checked independently.

The personal-storage qualification stack is already **IMPORT_COMPLETE**, holding only `/aws/lambda/6zt8e9qz04-personal-storage`. There is no working candidate implied by that status. Recovery must not be repeated as if the stack were still ROLLBACK_COMPLETE; preserve its retained logs and use an update after capacity is available.

The alarm topic currently lists the confirmed BrandonBright@gmail.com subscription only. No info@ subscription was returned in this inspection; do not report it as confirmed or currently pending without a new observation. Earlier owner-confirmed alarm delivery remains recorded, not repeated here. Two addresses for Brandon are not two independent responders.

## Database and hosted acceptance

The new operator first verified all 32 historical ledger rows against the earlier reviewed history and local normalized SQL, preserving the historical alias already in the ledger. It rehearsed migration 33 inside a transaction, tested it, rolled it back and verified the fixture organization and ledger changes were absent. It then committed only migration 33 and repeated the rollback-only fixture suite against the applied database.

Database verification covered RLS with no direct API SELECT grant, send-before-settle returning committed IDs, settle-before-send, idempotent settlement, late-send refusal, a new database context reading cancelled, foreign-owner/workforce refusal and withholding inaccessible delivery identifiers. This is seven grouped assertions, not seven independent physical-device tests.

The real Cognito JWT and API Gateway harness then passed ten grouped assertions:

1. Send first, then settle reports the committed message.
2. Settle first and repeated settlement return cancelled.
3. A late send using the cancelled request ID returns conflict.
4. A new HTTP client observes cancelled through receipt lookup.
5. Foreign consumer and workforce callers cannot settle the owner's request.
6. An overlapping send/settle pair returns mutually consistent outcomes.
7. Replacing the fictional clinic link produces withheld without message/thread IDs; naming the replacement link does not falsely report cancellation of an already delivered request.
8. Receipt lookup through the revoked old link is refused.
9. The exact original fictional link is restored and its committed receipt works again.
10. Both withheld program routes remain unavailable even with valid JWTs.

The two sequential orderings and one overlapping pair were exercised. This is not a proof of every possible scheduler ordering. A second physical phone was not used: new-client convergence is API evidence only. The old fictional link was restored; the temporary replacement was retained revoked. Fictional messages, audit rows and cancellation tombstones were retained as test evidence, not deleted. No real health data or new consumer accounts were used. Existing fictional credentials remain DPAPI-protected and out of Git.

Local source checks in this turn: authenticated API gate passed; 42 messaging/program/infrastructure tests and 158 identity/driver tests passed. Provider-configuration fixture tests and its gate passed after the repair below. A full application suite or new phone build is not claimed for this increment.

Generated local evidence is under `dist/settlement-qualification/`: rehearsal.json, apply.json, verify.json, deployment.json and hosted.json. These reports distinguish database, API and physical-device evidence.

## Program fixes required from Claude before migration 34

Run `node scripts/audit-program-assignment-release.mjs` from the Desktop repository. This uses the real 34-migration SQL artifact in PGlite with fictional identities, without AWS or credentials. Exit 1 is the current, intentional blocked result; do not disable this diagnostic to green the release.

### Published approval is not bound to delivered content

The audit creates a published program version whose source content is empty, then assigns unrelated caller-supplied phases with a lesson marked released. The assignment succeeds and the consumer read puts that unpublished lesson in review.add. The service only verifies version status and hashes the request body; the digest does not prove that body came from the published artifact.

Required repair: resolve or compile the assignment server-side from the pinned, published source version, or require a separately persisted, reviewed compiled artifact bound to that version. Do not trust caller title, phases, instructions, released flags, ingredient keys or purchase destinations as proof of source approval. Reject mismatches before persistence; preserve immutable version and provenance bindings on read/mutation. Test altered lesson/diet/habit text, released flags, title, product/destination, foreign clinic and superseded versions. Keep every supplement held while the governed catalog is unavailable.

The current Desktop panel also asks the practitioner to paste a version UUID and phases JSON. Its comment says it authors nothing, but there is no authenticated source lookup behind that assertion. Replace this with a published-program picker and server-resolved preview. Do not label the current JSON form a completed patient-program publishing experience.

### Required fields pass the database validator when absent

The same audit removes `days` and then `items` from an otherwise valid phase. `clinical_private.program_content_valid` returns true for both. SQL comparisons using `<>` against a missing JSON value become NULL, and the IF does not reject them.

Required repair: explicit key/type/null validation, using null-safe predicates throughout nested phase/item/product checks. Add direct SQL negative tests for every required field missing or null, wrong JSON type and nested malformed values. The HTTP Zod check reduces current exposure but does not satisfy the documented database contract or protect future callers. Do not merely catch a later response-parser failure.

Migration 34 is still unapplied in this inspected AWS target. Coordinate any source rewrite with other environments; if it has been applied elsewhere, supply an additive correction instead. **Migration 33 is now applied and must never be edited.** Send Codex the corrected migration file/release hashes, matching contracts/UI, passing negative tests and exact source commit. Codex will re-review before applying 34 and exposing its routes.

## CI repair and remaining source work

Desktop run https://github.com/HolisticDrBright/AI_DESKTOP_PRO/actions/runs/36654958762 failed its main job; its browser jobs passed. The provider-configuration gate had gained a dependency on externalCalendarSync.ts, but its test fixture did not copy that file. Codex added the missing fixture file and negative cases for write scopes and network calls; the test now passes locally without weakening the gate. A fresh hosted CI result is still needed for the follow-up commit.

Claude's latest return handoff also explicitly leaves the external-calendar OAuth exchange, token storage, real provider HTTP transport, connect UI and template unbuilt. Messaging/program production privacy lifecycle is deferred. These are source tasks, not AWS credentials alone. The app is not commercial or PHI ready because the synthetic messaging path passed.

## Operator use and rollback

Operators added in this increment are narrowly pinned to runtime source b55e774 and the synthetic account. Because these operator files are saved in a subsequent commit, preserve them externally when preparing the pinned source checkout; do not weaken the source check to run against a different candidate. Generated bundles/evidence are not credentials and can be reproduced. Do not copy the credential envelope to another machine.

- `node scripts/deploy-care-message-settlement.mjs inspect|rehearsal|apply|verify` acts on migration 33 only. Apply requires a fresh successful rehearsal. It refuses another ledger, target or migration digest.
- `pwsh -NoProfile -File scripts/deploy-settlement-api.ps1 -Mode prepare|execute|verify` uses the existing template and refuses program/default/proxy routes. The completed change set and artifact must be inspected before any retry; do not overwrite them. This is a record/reproduction operator, not an instruction to redeploy the completed release.
- `node scripts/verify-settlement-hosted.mjs --confirm-owner-approved-synthetic-plan` uses the existing fictional identity envelope and requires the recorded deployed checksum. Refresh the owned synthetic sign-ins through the existing preparation operator if expired; never paste codes or tokens into Git/chat.

Previous Lambda artifact remains `clinical-core/authenticated-api/bacddfe421ca7a705c3e8acbb684190aa8b767fda66e86e53fc1d11ae90b0b13.zip` in the same artifact bucket. A reviewed code-only change set can restore that key if necessary; this live rollback was **not exercised** in this turn.

Do **not** drop settlement tombstones or the late-insert trigger during rollback. Once a request has been cancelled, deleting that authority would permit its late admission and break the cancellation promise. Older code may refuse the new receipt/action shape, but database cancellation authority must survive. Any database rollback design requires explicit compatibility and data-preservation review.

## Next AWS actions

After Claude's source repairs: inspect current ledger, apply the corrected program migration in order, rebuild from exact reviewed source, review the changeset adding only the intended JWT routes, and run program acceptance. All supplement steps must remain held until the governed catalog exists in the same target. A positive flow bypassing that hold is a defect.

Separately, after capacity approval: update the recovered qualification candidate, validate target manifest and exact artifact/source/migration binding, deploy the remaining fleet in dependency order, and run export, retention, scheduled cleanup, recording, transcription/drafting and rollback harnesses. Model authority, service releases and provider/policy evidence must be authentic; no approvals were fabricated or activated here. Keep production account 173535830222 out of scope.
