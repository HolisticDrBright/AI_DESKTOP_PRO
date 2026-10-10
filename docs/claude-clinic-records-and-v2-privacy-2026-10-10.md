# Claude Code clinic records and V2 privacy engineering handoff

Complete the production-shaped clinic-record privacy workflow across Desktop
and V2. Patients need to request their clinic-held records, track fulfillment,
receive an authorized copy, and raise a correction or dispute. Practitioners
need to review and fulfill those requests without overwriting signed records or
claiming a retained original was deleted. This is the next major source work
package, not another video-screen redesign or a request to activate PHI.

V2 is the product priority. Implement the required server authority and wire the
actual patient screens in the same increment; do not stop at a typed stub or a
presentation-only component. Keep this a separate clinic-data workflow: do not
quietly widen the existing personal-storage export.

## Division of work

Claude owns the clinic privacy contracts, production-shaped source port, V2
request and fulfillment screens, Desktop practitioner fulfillment and amendment
integration, tests, blocked candidate packaging and documentation in this handoff.
Finish successive working increments on separate branches and return source
evidence to Codex.

Codex owns the admission-expiry completion repair, clinic-specific Zoom host
and exact secret authority integration, shared schema/release numbering and
preserving operators, AWS configuration/deployment, hosted qualification and
matched release coordination. Do not edit or replace those source lanes.

The owner reviews retention, disclosure/export scope, legal and provider
coverage, consent wording and activation evidence. Neither agent may invent
those decisions, reviewer signatures, approval hashes or deletion guarantees.

## Exact source and working copies

Desktop repository: `HolisticDrBright/AI_DESKTOP_PRO`. Your latest returned
branch is `claude/telehealth-chart-lifecycle-20261010` at
`13b38d33f63aaa4d41ab1e02616e70ee2307c234`. Fetch and verify that exact head,
then create a new branch such as `claude/clinic-record-privacy-20261010` in your
own clean clone/worktree. Do not merge into main.

Codex integration branch `agent/telehealth-canonical-integration-20261009`, PR87,
has documentation head `9f9509969dddfdc2c5f00b2f49cde7b2c31b0af3`; its runtime
includes the separate clinic-host source registry and resolver at `5fd2f4e`.
Use it as a coordination reference, not as permission to discard your chart work.

V2 repository: `HolisticDrBright/AI_LONGEVITY_PRO_V2`. Start your V2 branch from
`agent/v2-program-response-integrity-20261008` at exact head
`15301ee8eba3b79ca6d0a62d8a595d483a8538d5`, PR22. Runtime is `4620165`; the
latest increment adds mounted-plan verification tests, not a deployment. Create
a separate branch such as `claude/v2-clinic-record-privacy-20261010`.

Do not edit these Codex checkouts:

- `C:\Users\Brand\Documents\Codex\2026-08-18\referenced-chatgpt-conversation-this-is-an\work\DESKTOP_TELEHEALTH_REVIEW_e1cc340`
- `C:\Users\Brand\Documents\Codex\2026-08-18\referenced-chatgpt-conversation-this-is-an\work\DESKTOP_CLAUDE_LIFECYCLE_REPAIR_7ff170b`
- `C:\Users\Brand\Documents\Codex\2026-08-18\referenced-chatgpt-conversation-this-is-an\work\DESKTOP_CLAUDE_EXPIRY_RECHECK_13b38d3`
- `C:\Users\Brand\Documents\Codex\2026-08-18\referenced-chatgpt-conversation-this-is-an\work\V2_PROGRAM_INTEGRITY_20261008`
- The mock Desktop working copy, which contains unrelated user curriculum edits.

The `/3` chart candidate from `13b38d3` is not registered, approved or deployed.
Its original 20 embedded SQL tests pass, but Codex's two added late-write tests
fail: expiry inside the actual note write or transfer audit still returns
`created:true`. Codex is closing that gap on
`agent/telehealth-admission-expiry-repair-20261010` with a distinct `/4` proposal.
That proposal passes all 23 SQL tests, all 365 cases in six surrounding suites,
and the 18 candidate tests. Its exact source identity is
`20261010190000_production_telehealth_chart_lifecycle.sql`, SQL SHA-256
`78f03a282b3f5ba97af2f50683aeab0fc1e20d19d77ec7111fc28116ede7bab7`.
Full-suite, CI, hosted and device evidence must be recorded separately; these
focused passes do not authorize a merge or deployment.
Do not reuse an existing candidate version or hash for different SQL. Treat the
selected chart predecessor as a coordination dependency; do not register 113
or assume the proposed chart artifact has become the live database.

## Read before implementing

Read the local `AGENTS.md` instructions and use the AST graph when present.
Inspect the existing code before replacing anything; reuse implemented authority,
journaling and device-erasure boundaries rather than creating parallel versions.

Desktop starting references:

- `docs/telehealth-chart-lifecycle-2026-10-10.md` and the actual chart candidate SQL.
- `src/server/clinical-core/care-data-lifecycle.ts`: explicitly synthetic-only;
  its historical `care_data_export` and erasure functions are not a production port.
- `src/contracts/careDataLifecycle.ts` and the existing staging domain export tests.
- `src/server/clinical-core/owned-privacy-export.ts`: personal export currently
  excludes `clinic_records_and_messages`. Keep that exclusion unchanged.
- `owned-privacy-export-job.ts`, `aws-cross-store-export-reader.ts`,
  `privacy-external-inventory.ts`, `privacy-external-purge.ts` and their tests.
- Production care connection, messaging, clinic-dispute, note-signature and
  append-only addendum paths. A dispute is not an amendment and an owner correction
  is not authority to change a clinician-authored signed record.
- `src/contracts/telehealthRecordInventory.ts` and telehealth inventory routes:
  inventory is not fulfilled export, purge or backup/provider deletion.

V2 starting references:

- `expo/app/privacy-center.tsx`, `CareDataLifecycleCard.tsx` and
  `RetainedMessagePrivacyCard.tsx`. Production currently renders the retained-message
  card; the broader lifecycle card remains synthetic-only.
- `expo/lib/clinicalData/awsCareDataLifecycle.ts`, `careDataExportFile.ts`,
  `personalPrivacyExport.ts`, `privacyOperationBoundary.ts`,
  `privateViewLifecycle.ts`, `devicePrivacyExport.ts` and device erasure modules.
- Current care connections, owner/session-epoch fencing, recovery journals,
  strict received-byte handling and native fetch deadlines.
- `expo/docs/telehealth-patient-consent.md`: patient consent review, self-signing,
  withdrawal and uncertain-outcome recovery already exist in source. Do not rebuild
  them or claim they remain a missing screen. Deployment and physical acceptance
  are separate.
- `expo/docs/six-phase-current-evidence-2026-10-05.md`: all six original completion
  requirements remain in scope, including hosted and physical acceptance.

## Deliverable 1 Define clinic privacy contracts and authority

Create explicit, versioned contracts for clinic-data requests, request discovery
and status, practitioner fulfillment, bounded export reading/download issuance,
and correction/dispute requests. Bind every response and cursor to the owner,
organization, patient record, request, selected scope and source revision.
The server derives the actor and patient authority from verified identity and
canonical relationships; never trust a patient ID or clinic ID supplied by the UI.

Use separate consumer and workforce routes. A consumer may act only for their
own linked patient identity. A workforce caller must have current organization
membership and the appropriate record/privacy authority. Cross-patient and
cross-clinic access, including receipt metadata, must be refused. Do not add
guardian/representative access or child signup.

Active sharing authority and authority to receive a retained clinic record are
different. Do not automatically allow access because a historical link exists,
or automatically erase a retained record because sharing was withdrawn. Define
the necessary retained-record authority explicitly and fail closed until it is
reviewed. Preserve historical original identity when a calendar appointment is
corrected or a successor appointment is created.

Keep source revisions and reviewer decisions explicit. Unsigned notes,
unreviewed AI drafts, private clinician text and clinical records not approved
for disclosure must not silently become a patient-visible export. Pending
disclosure-policy decisions remain pending; use only clearly fictional review
fixtures to exercise positive paths.

## Deliverable 2 Implement the production clinic export port

Build the canonical production-shaped clinic-data export authority rather than
enabling the old synthetic `care_data_export` handler against the qualification
database. Refactor section selection into an explicit registry with documented
ownership, authorization, projection, revision and retention behavior.

Account for the applicable clinic domains: shared lab observations and provenance,
published protocols/program assignments, retained clinic correspondence, intake
and check-in records, disclosed signed notes and append-only amendments, and
telehealth visit text and its chart-transfer receipt. Every section must either
have an authorized reader or an explicit exclusion with a reason. Do not claim
the manifest covers a section that was skipped or refused.

For telehealth, include every disclosed source revision, practitioner text,
approved/dismissed action-item state, AI-summary provenance and chart lineage
required by the selected scope. Do not treat a source visit signature as a chart
signature or turn an action-item text into an order. Do not include admission
secrets, tokens, host credentials, private signing material or unrelated patient
metadata.

Use stable keyset pagination and bounded received bytes, bind cursors to the
request/owner/clinic and exact release, and state snapshot versus live-read
semantics honestly. Refuse duplicate, unrelated, malformed or incomplete pages.
Reuse the existing export-job integrity/recovery machinery where appropriate;
do not introduce an unbounded collect-all path, zero-byte completion, a whole
object buffer, swallowed storage abort or false deletion certification.

If a new export object/store is required, supply source-only configuration and
default-blocked template parameters. Do not create buckets, keys, service
identities, release rows or timers. Storage and cleanup releases must have their
own reviewed authority, not a fabricated configuration digest labeled approval.

The separate clinic export does not widen the personal account export or its
exclusions. Whether clinic text later joins that personal export remains an
owner decision. Preserve holds, provider-copy and backup exclusions, and do not
invent a retention deadline or promise deletion after the download expires.

## Deliverable 3 Add Desktop practitioner fulfillment and amendments

Give authorized clinic staff a real inbox/workflow for these patient requests:
review the requested scope, decide disclosure, prepare and verify a copy, fulfill
or refuse with a reason, and show progress and failure/recovery states. Show
which records and revisions are included, excluded, retained or unresolved.
Do not report a submitted request as fulfilled or an uploaded object as delivered.

Integrate correction and dispute requests with existing clinician review and
append-only amendment APIs. Preserve the original signed content, signature,
revision and attribution. Require current authority, expected revision, explicit
reason and a confirmed action. Retries and concurrent decisions must converge
without a duplicate amendment, overwritten decision or false success.

Requests to delete clinic-held material are review/retention workflows, not an
owner purge endpoint. If no reviewed disposition policy covers a store, show it
as retained or awaiting review. A legal hold blocks deletion. Unknown outcomes,
Zoom copies and backups must never be certified deleted by local ALP inventory.

## Deliverable 4 Wire the V2 Clinic Data Center

Add a clear entry from the Privacy Center for connected-clinic data. Let a patient
choose the clinic and request an authorized copy or a correction, see the exact
request and decision history, inspect uncertain outcomes, and receive/share a
fulfilled copy under fresh authorization. Keep personal account operations and
clinic-held records clearly separated in the wording.

Use actual current consent/disclosure artifacts where needed; never generate
consent copy locally, precheck agreement, infer a signature from a profile, or
grant an unrelated scope. A saved signature does not authorize every record or
future request. The independent Core app must remain usable without a clinic;
show the applicable state rather than sending requests for a nonexistent link.

Pending mutations need a durable owner/clinic/environment-bound encrypted command
or authoritative request-discovery recovery. A lost response is uncertain, not
permission to create a second request or retry fulfillment blindly. Status from
another device must settle the same request. Do not fabricate a cancellation or
deletion receipt from local erasure.

Clear opened clinic text, prepared copies and private request details on account,
clinic, environment, destination, authorization, background, unmount and device
erasure changes. A late response must not reopen them. Account for any new device
keys/files in export and erasure, refuse unattributed legacy data, and bound all
identity reads, storage operations, response streams and hashing under deadlines.

## Deliverable 5 Package source candidates and qualification tests

Any new SQL is a distinct forward source candidate. Do not change historical
migration bytes, the exact 112 parent, existing registrars, deployed ledger
definitions or the admission-expiry candidate. Declare the exact source parent
and SQL hashes, blocked activation, PHI off and no seeded approvals/consents.
Coordinate migration numbering with Codex; do not reserve or register the next
position merely by increasing a count. Changes to coverage and inventory must
reflect actual new operations, not counts that hide a missing port.

Implement real handler/role/database paths, not only zod types, UI mocks or
configuration refusals. Keep provider calls outside transactions and operation
identity/recovery durable. Add a synthetic qualification runner/report contract
for Codex with mandatory cases and explicit target binding. A skipped, refused,
unconfigured or unobserved positive step cannot produce an acceptance verdict.

Required acceptance tests:

1. Actual restricted-role SQL: two clinics, two same-clinic patients, consumers,
   practitioner/staff/admin roles, missing/revoked authority and replaced links.
   No cross-user rows, transcript text or receipt metadata may leak.
2. Every included export section, every exclusion, all disclosed revisions and
   provenance; strict byte budgets; malformed/stale/duplicate cursors; interrupted
   assembly and exact recovery without a falsely complete manifest.
3. Patient request and practitioner decisions in both race orders, lost receipt,
   retry, second-device discovery and supersession. Embedded serial order tests
   must not be described as actual PostgreSQL interleaving.
4. Signed-note immutability, append-only amendment history, correct attribution,
   refusal of stale revisions and preservation of the original patient identity.
5. Holds/withdrawal/disposition: stop new processing when required, preserve retained
   originals, and report provider/backups separately. No fake erase receipt.
6. Mounted V2 and Desktop browser journeys through the actual controllers:
   request, review, fulfillment/refusal, copy sharing, correction and recovery;
   keyboard/accessibility and private-state removal during pending responses.
7. Every new device copy/journal/file included in the exact owner-scoped device
   inventory, export and erasure; lost or unconfirmed mutations remain inspectable.
8. Preserve personal export exclusions, existing messaging/booking/consent recovery,
   Core-only paid launch boundaries, clinical holds and source-verification gates.

Run the relevant full suites, typecheck, lint, contract/inventory/coverage and
bundle gates. Record every failure and skip. Do not waive the known consent-copy
CI ordering failure or other unrelated failures by calling them green; isolate
and report them if they recur. Do not weaken a test to get a completion claim.

## Boundaries and human gates

No AWS writes, secret retrieval, Zoom or other provider calls, migration
application, hosted fixtures, paid mobile builds, deployment, activation or PHI
enablement. No real patient information or audio in fixtures. No new provider,
billing product, pediatric/guardian authority, clinical approval, catalog
approval or retention policy. Do not change Core $19.99/month or enable peptide
and longevity tiers for the initial launch.

The first positive source journeys use fictional authority/release fixtures.
Their presence does not approve real patient disclosure, production retention,
provider coverage or a production pilot expansion. Present the pending decisions
in the return handoff with the exact fields/configuration that require review;
do not solve them by hardcoding permissive defaults or narrowing the phase scope.

## Return to Codex

Commit only your changes, push both new branches and return full commit IDs,
file lists, contracts, candidate/parent hashes, migration proposal, operations,
device-copy inventory and recovery semantics. Include terminal commands/results,
CI links and the exact AWS deployment/qualification inputs and mandatory positive
and negative cases Codex must execute.

Distinguish implemented, locally verified, CI verified, hosted verified, device
verified and approved for PHI. Source completion is not commercial readiness;
the original six-phase objective remains unchanged. Provide an explicit list
of any unfinished source work rather than assigning it to a human by default.

Update your AST graph after source changes. Append only to the shared Markdown
project map after a fresh modification-time/content-hash guard; preserve earlier
bytes and leave the canvas untouched:

`C:\Users\Brand\OneDrive\Desktop\Obsidian Vaults\Graphify\AI Longevity Pro V2\AI Longevity Pro V2 - Graphify.md`

At handoff preparation the map ends at section505. Check its current tail before
choosing the next section; Codex is appending concurrent evidence. Do not fork a
second map or paste an old section number over newer work.
