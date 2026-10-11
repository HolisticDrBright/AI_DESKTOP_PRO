# Telehealth appointment authority source candidate

The missing API-role observation of current appointment sharing is implemented as a separate blocked 118 source candidate on the exact 117 parent. It adds a read-only function and a compiled server port. It does not implement or deploy the complete telehealth request service, admit a booking, activate Zoom, or approve PHI.

The managed fictional database was independently observed at 112 after the separately approved upgrades. This candidate has not been applied. The earlier approval covers neither 112 to 117 nor 117 to 118. Existing 117 and historical runtime pins remain unchanged and must refuse this new release.

## Source identity

Base commit: `4fdb524dce222df14fb518e361da2dc2e4f57b81`. Branch: `agent/qualification-successor-telehealth-requests-20261011`.

| Item | Exact identity |
| --- | --- |
| Parent migrations | 117 |
| Parent ledger | `34037e1ff05d583868c9a3796f673937777f88bcf4cebc2d589c6604626e9364` |
| Parent assembly | `d73f67f2197886cf24360f773018a72c92d666789891e679e151ae2c65bd796a` |
| Source contract | `telehealth-request-authority-candidate/1` |
| Extension file | `20261011180000_production_telehealth_request_authority.sql` |
| Extension SQL | `1ae4fd954760af204be732313730174a845c0558f24a5a84703d9ee548078e86` |
| Function body | `7004b97b7fdcf849308856bbe304df068100a41d0f62e29c42b420d35ed8ca86` |
| Candidate migrations | 118 |
| Candidate ledger | `5c69c7353680aa9d2690b99dc57afb5eb33955ba8eeb51bde24138077807a6de` |
| Candidate assembly | `1a97814cfce369cfbc711669d74084cd8eaab42d8debd81e2c2a1d07f943ac46` |

Every parent filename and SQL byte is preserved. The candidate builder accepts only the exact parent and normalized extension bytes. DDL refuses a non-exact 117 ledger and assembly before creating the function. No table, identity, review, consent, provider release or admission key is seeded.

## Observation contract

`clinical_core.production_telehealth_request_authority(jsonb)` accepts only `consumer_appointments` or `workforce_appointments`. Workforce may name an optional patient record. Actor, clinic, pool and subject come from the established database request context, never from the body.

A consumer observation requires a current active, production-bound identity; an active clinic; exactly one verified connection to an active patient in that clinic; and the latest patient-app self grant for the current approved appointments artifact. A newer approved release without registered copy is a refusal, not permission to use an older copy. Workforce requires current clinical clinic membership and independently authorizes the optional active patient in that clinic. It does not invent a consumer grant.

The function returns the actor, clinic, pool, subject, patient and connection bindings, consent artifact and grant metadata, database name, observation time, and the complete ordered migration ledger. No name, email, medical content, consent copy, secret or provider token is returned. The response is internal service metadata, not a patient-facing HTTP response.

The compiled port requires the isolated `clinical_core_qualification` database and the entire exact 118 ledger. It checks the real API role, the inherited care functions and consent-copy protection, plus the new function's exact body, signature, owner, language, volatility, definer mode, empty search path and execution ACL. Direct migration-ledger reads remain denied to the API role. No administrative credential or Fullscript worker role is substituted.

The production-shaped context flags in the port are existing database contract conventions. They are not PHI permission. The port has no exported deployment handler or activation path.

## Limits of the observation

This is a point-in-time observation for new appointment sharing. It is not a capability token or durable distributed write admission. Database/provider actions that occur later need their own revalidation and settlement. No provider or network work belongs inside the database transaction.

Appointments consent is separate from telehealth-recording consent. Do not apply this new-sharing observation as a blanket gate on cancellation after withdrawal, or on independently authorized retained visit records and chart transfers. The existing retained-record and chart-transfer contracts remain unchanged.

## Verification commands

```text
npm run test:telehealth-request-authority
npm run build:telehealth-request-authority-candidate
npm run typecheck
npm run lint
npm run test:unit
npm run build:clinical
npm run check:clinical-bundle
```

The two new suites passed 67 tests using the actual 118 SQL assembly and the real embedded API role, plus source, request, ledger and refusal-mapping tests. The original diagnostic failed on the exact 117 parent with the missing function; raw ledger permission denial already passed. Tests cover positive consumer/workforce observations, cross-owner and cross-clinic refusals, current identity/membership status, connection and patient status, withdrawal, retirement and supersession, malformed requests, missing/extra/changed receipts, changed live function bodies or ACLs, and denied raw ledger reads. The read journey leaves grant and audit counts unchanged.

Typecheck, lint, candidate build and the clinical production build passed. The strict client-bundle scan passed for 308 chunks. The direct `npx vitest run` invocation finished with 7,658 passing tests, 11 skips and one failure: the unchanged dates test asserts `process.env.TZ` is `America/Los_Angeles`, but that invocation omitted the timezone supplied by the repository's `test:unit` script. All seven dates tests pass unmodified under `npm run test:unit -- src/lib/dates.test.ts`. That first full run remains failed, not retrospectively green.

The complete normal `npm run test:unit` invocation at unchanged `5640e153d9ef5aafc607e71998957821e0327d59` subsequently completed with 469 files passed, 7,659 tests passed and 11 skips in 945.39 elapsed seconds. Exact-head GitHub run [38164004576](https://github.com/HolisticDrBright/AI_DESKTOP_PRO/actions/runs/38164004576) completed successfully across eleven jobs. No tests, deadlines or skips were weakened. The deployed-backend steps are gated by secrets; a successful CI job is not managed application acceptance.

These are local source, embedded-database and CI results, not managed PostgreSQL, Cognito, provider or physical-device evidence. The later complete-list repairs have their own source and verification status in `docs/telehealth-complete-lists-2026-10-11.md`; the 5640e15 results must not be attributed to those subsequent source changes.

## Remaining Codex engineering

1. Complete the distinct telehealth request-service factory and native entry point. Bind independently verified Cognito identities, current workforce MFA, dedicated restricted credentials, actual target resources and compiled artifact identities before a request can run. Do not turn on the historical handler with `phiAllowed=true` or manufacture synthetic claims.
2. Design and test durable request admission, current authority rechecks, replay, cancellation, rescheduling, consent withdrawal and settlement across the database, DynamoDB and provider. Keep retained-record authority separate.
3. Reconcile a matched source profile for the entire required fleet at the chosen exact release. The existing 117 fleet must continue refusing 118; do not accept a superset or widen its pins. If this candidate changes, give it a distinct source identity and regenerate all affected artifacts.
4. Prepare the preserving transition from the actual managed 112 target with rollback, ownership, definition, row-preservation and custody evidence. Seek a new review of the exact proposed transition before applying any schema. The completed 107 to 111 to 112 approval is not reusable.
5. Build, review and deploy the complete matched qualification fleet, then execute positive and negative hosted journeys. Consent wording, provider releases, security and retention reviews need their own real approvals. No invented review hashes.
6. Run matched Desktop and mobile release qualification and physical device journeys after Brandon authorizes the consolidated paid build. Keep all clinical holds, source verification, adult Core launch scope and PHI restrictions.

Claude's current application integration, program products, education publication and current-access packages remain separate. This source prerequisite does not replace or finish that assignment. All six original commercial-readiness scopes remain incomplete.
