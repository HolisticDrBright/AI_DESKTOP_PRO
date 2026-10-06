# Synthetic AWS qualification evidence — 2026-10-05

This is narrow, fictional-data evidence, **not** commercial acceptance or PHI approval.

## Target and posture

- AWS account `588966314750`, region `us-east-2`; `ai-synthetic-staging` sign-in verified by STS.
- Isolated database `clinical_core_qualification` had 103 migrations, latest `20260928010000`.
- Qualification foundation reports `PhiAllowed=false`. The recovered personal-storage candidate reports `Activation=blocked`, `QualificationExecution=enabled`, and source `a300c633ac81909842503ad37e77170ad63ed605`.
- The account's observed Lambda concurrency quota is 150. The current candidate capacity preflight passes for 35 requested reservations. It does not prove all candidates can deploy or run.

## Personal-storage recovery

The previously rolled-back `ai-clinical-core-qualification-personal-storage` stack retained only its log group. A reviewed change set added the Lambda, role, routes and alarms without deleting or replacing that group. The stack reached `UPDATE_COMPLETE`; the Lambda became Active, and its code digest matched the reviewed `personal-storage.zip` artifact. Anonymous posture access returned 401.

The owner approved **only** this exact fictional-test consent copy in this chat:

> I agree to store and use fictional test intake and lab-history data in the isolated ALP qualification service for software testing. No real personal or health information may be entered.

The guarded operator `scripts/register-aws-qualification-consent.mjs` registered that copy in `forms_checkins` and `lab_history`, version `qualification-test-2026-10-05`, SHA-256 `4dba561f24d61172401f6ce70e067458ee114e0caf530ef81c2a17adeeba86e5`. A repeat invocation returned `already_registered` without replacing the release. This is not a production patient consent or PHI activation.

## Hosted observations

All authenticated responses below carried `x-clinical-execution: qualification`:

- Two fictional Cognito consumers each saw the exact forms and lab release and granted revision 1.
- Consumer A saved one fictional wellness profile: HTTP 200, revision 1. An identical replay returned HTTP 200 with `duplicate=true`.
- Consumer A reread that record. Consumer B's read of its ID returned no data; Consumer B's list returned zero items.
- Consumer A saved one fictional lab observation: HTTP 200, revision 1. Consumer A reread it; Consumer B's read returned no data.
- No real personal information, health information, wearable data, or recording was entered.

The first attempted wellness write was refused `request_invalid` because the test payload included an extra fixture field. The test was corrected to the published schema before the successful run. This is evidence of schema refusal, not evidence of a production failure.

## Hosted synthetic program assignment — later October 5

The guarded program migration changed only staging `clinical_core`, not the isolated qualification database. A reviewed change set then updated `ai-clinical-core-synthetic-staging-authenticated-api`: two JWT routes were added (`POST /clinical-core/consumer/programs`, `POST /clinical-core/workforce/programs`) and the existing Lambda code was updated in place. No resource was replaced. The stack reached `UPDATE_COMPLETE`, the Lambda was Active/Successful, and its immutable S3 artifact is `clinical-core/authenticated-api/58f5978301be218896b269a44438fecb8ae89a690bee6671008b64f215f14247.zip` (SSE-KMS, bucket version `GsDkhEuyC.7rZk63usQjzzoUU5Pcc._3`). The previous artifact remains available for rollback. Staging `PhiAllowed=false` and its exact 35-row migration ledger were rechecked before preparing the change.

`scripts/verify-synthetic-program-routes-hosted.mjs` ran through the real API with existing fictional, synthetic-attested Cognito users. It observed authenticated consumer/workforce reads, role and anonymous refusals, a published fictional version, practitioner assignment, consumer read and acceptance, cross-owner refusal, and a refusal to complete an unresolved supplement. The program review reported `inventoryComplete=false` with that supplement held; no product link or catalog approval was invented. The test fixture is fictional and retained for replay. An initial attempt using older fictional identities was refused because their immutable synthetic-attestation claim was absent. That guard was not weakened; the successful run used previously designated attested fictional accounts.

This is a synthetic staging journey, not a qualification execution for the other ten candidate stacks, a current mobile/Desktop release, or PHI approval. The governed catalog is not reachable from this program target, so every supplement step remains held. No device journey or real patient data was tested. The user instructed us to hold TestFlight/paid mobile builds until the remaining updates are complete.

## Hosted synthetic lifecycle and calendar reads — later October 5

`syntheticLifecycleMigrations` pinned the exact 35-row synthetic staging ledger and three source SQL digests: `20260930100000` external calendar, `20260930110000` owner care-data lifecycle, and `20260930120000` external-busy booking. It executed all three in a transaction, rolled them back, verified no ledger change, then applied only those three. A second inspect verified the exact 38-row ledger. The isolated qualification database was not changed.

A second reviewed CloudFormation change set, `synthetic-lifecycle-routes-20261005`, added only `POST /clinical-core/consumer/care-data` and `POST /clinical-core/workforce/calendar-connection` as JWT routes. It made no Lambda code, IAM or resource replacement change; the stack reached `UPDATE_COMPLETE`. The deployed Lambda artifact is still the program release ZIP above.

Hosted checks with fictional attested identities passed: consumer erasure-history read, own assignment export, zero foreign-consumer assignment export, workforce calendar read reporting disconnected, and anonymous calendar refusal. A repeat of the program journey still held the unresolved supplement and refused a foreign owner. These checks did not erase data, connect Google OAuth, prove busy-time ingestion, book an appointment, verify a physical device, or qualify production-shaped candidates. Focused local calendar/booking/care-data tests passed 54/54. The source test runner is pinned to the deployed Lambda digest and synthetic account.

## Hosted synthetic consult/intake reads — October 5–6

`syntheticIntakeMigrations` checked the exact 38-row staging ledger, the synthetic-only foundation and the SHA-256 digests of `20260930130000` public consult requests, `20260930140000` pre-visit forms/signatures, and `20260930150000` their owner data lifecycle. A transaction rehearsal rolled back all three; a subsequent inspect still reported 38 rows. Applying only those three then produced a verified 41-row ledger, latest `20260930150000`. The qualification database was unchanged. Focused local consult/intake, retention, note-template, outcomes and cart tests passed 89/89.

The reviewed CloudFormation change set `synthetic-intake-jwt-routes-20261005` added exactly five JWT routes: workforce consult links, consult requests, intake forms, intake packets, and consumer intake packets. No Lambda, IAM, integration, public route or other resource changed. The stack reached `UPDATE_COMPLETE`; its Lambda artifact remained the exact prior synthetic program artifact. The public consult intake route was **not** added: an unauthenticated staging form could collect a real visitor's contact despite the fictional-data banner, so it needs a separate safe qualification design.

Hosted real-JWT checks with the existing fictional accounts passed list reads on all five routes, a consumer-versus-workforce refusal, anonymous refusal, and an HTTP 404 on the withheld public route. All lists were empty; no consult request, form, response, signature, patient invitation or clinical data was created in this hosted run. The existing program journey still passed and held its unresolved supplement. This is route/read authorization evidence, not an end-to-end intake, public consultation, device, provider or PHI acceptance.

## Hosted fictional forms-consent and completed packet — October 6

The owner subsequently approved **only** this exact staging-test copy in this chat:

> I agree to store and use fictional test intake data in the ALP synthetic staging service for software testing. No real personal or health information may be entered.

The guarded hosted runner verified account `588966314750`, `PhiAllowed=false`, the exact 41-row staging ledger, fictional attested identities, the verified patient connection and its fictional practitioner membership before registering the `forms_checkins` artifact. Version `fictional-intake-2026-10-05` carries SHA-256 `419479f3bef2104852ae1ece32cf94467cb3fe235582932cca830f190351edc5`. The artifact's `approved_by_person_id` is the fictional workforce test facilitator required by the staging schema; the actual authorization for this *test copy* is the owner's answer in this chat, not a clinical or production consent approval. The database holds the content hash, not a text copy. The runner compared the API-visible artifact ID, version and hash with the exact approved text before the fictional consumer granted the scope through the real authenticated API.

The same runner first proved that packet assignment without consent returned `consent_required` and persisted no packet. After the fictional grant, assignment of the unpublished draft was refused. The fictional practitioner then published that exact nonclinical, one-question version and assigned one packet; the fictional consumer opened it, a second consumer was refused, a wrong content digest was rejected, and the owner submitted `Option one`. The practitioner reopened the packet and observed `completed` with that answer. A second hosted run replayed the completed journey without creating another artifact or packet. The public consult intake route still returned 404. No real identity, health data, form signature, device UI, or production consent was used or verified.

The runner is `scripts/verify-synthetic-program-routes-hosted.mjs --confirm-fictional-only --identity-dir <existing fictional identity directory> --approved-fictional-intake-consent`; without the final flag it cannot register the artifact or grant consent. This is a narrow synthetic staging acceptance, not qualification-fleet or commercial-release evidence.

## Not proven

- These requests exercised an older `a300c63` personal-storage candidate, not an exact matched current V2/Desktop release.
- The other qualification candidates, full hosted harnesses, retention schedule, export delivery, recording/transcription/drafting, cross-clinic access, and exact matched release candidates were not accepted by this narrow run. Program assignment now has a separate fictional staging run above; that does not imply qualification-target or mobile acceptance.
- Synthetic staging `clinical_core` now has 41 ledger rows, latest `20260930150000`. The source manifest lists 45 migrations; a historical alias in the live ledger accounts for one extra row. Five manifest-listed migrations remain unapplied. The isolated qualification database remains separate at 103 migrations.
- No physical iOS/Android journey, store billing, provider live-mode acceptance, or complete security/privacy/retention review was performed.
- PHI remains disabled. Do not infer commercial readiness, HIPAA compliance, or readiness for real patients from this document.
- At source HEAD, the full Desktop dependency audit still reports high findings through a development-only `braces` dependency chain and `source-map-js`. A runtime-only audit reports zero findings, but the full CI security gate is not green and must not be silently weakened.

## Narrow staging migration rehearsal

The source-bound program-assignment audit now reports no findings, and focused program and specimen-context tests pass. The staging ledger has 33 entries. Its only source-version alias is the previously reviewed `20260902230000` workforce directory row, whose digest matches source `20260821049700`. The source manifest also contains an older-numbered, unapplied lab-specimen-context migration; it must precede program assignments.

`syntheticProgramMigration` is a guarded, synthetic-only operator for exactly those two migration digests. It checks the STS account, foundation posture, exact 33-row predecessor ledger including the alias, and the selected SQL hashes. `inspect` is read-only. `rehearse --confirm-synthetic-only` executed both migrations in one Aurora transaction, intentionally rolled them back, and verified the ledger remained at 33. Then `apply --confirm-synthetic-only` committed only `20260916080000` and `20260929120000`; subsequent inspect verified the exact 35-row ledger. No other migration was included. These database changes do not deploy the program API routes or constitute a hosted program journey.
