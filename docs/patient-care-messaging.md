# Patient ↔ practitioner text messaging — 2026-09-29

## Status

Implemented as a **synthetic-only first release**. AWS database migration and the two authenticated API routes were deployed September 29; Desktop and mobile UI releases are still pending. This is not a PHI activation or commercial-readiness claim.
The existing email/SMS Inbox channel remains separate and provider-disabled. Ask ALP is not this feature.

## User journey

1. V2: You → Message my practitioner → Load / refresh messages.
2. If not connected, use Connect to my practitioner and claim the clinic invitation in the existing connection screen.
3. With a verified connection, enter a subject and a fictional message, explicitly authorize sharing, then Send message.
4. Desktop: Inbox → Patient app messages → Load / refresh app messages. Open the conversation and Send reply.
5. V2: refresh, then open the conversation to see the reply.

A stored receipt means the database accepted the message. It does **not** mean anyone read it.
This first release has manual refresh, no unread badges, push/email/SMS notifications, attachments, automated triage, or response-time guarantee.
It is not an emergency channel. Starting a new conversation is exposed in V2; Desktop can reply.
Account changes/backgrounding clear local text and pending commands. After an interrupted send and an app restart/background, refresh history before composing another message.
There is no plaintext disk cache or cross-account draft restoration.

## Contract and security

- POST /clinical-core/consumer/messages and /clinical-core/workforce/messages, JWT authorizers pinned to their respective pools.
- Actions: list (30 threads), read (50 messages), send. Stable sequence cursors; subject 120 characters, body 4,000; bounded request/response.
- API accepts unexpired, synthetic-attested identity claims only. Production handler denies this feature; V2 production channel refuses it too.
- Database rechecks active identities, persons, organizations, patient records and verified patient connection.
- Consumer is restricted to their linked record; active owner/admin/practitioner membership sees only its organization's verified connections.
- Paused/revoked links and disabled identities deny reads, sends and retry receipts.
- Per-sender idempotency keys are bound to canonical request hashes. Changed-payload reuse conflicts; exact retry returns the original storage receipt.
- SQL tables deny direct API-role access. Security-definer functions pin an empty search path; text/history and metadata-only audit are immutable.
- Browser proxy enforces same-origin requests, cookie session, pinned AWS destination and no-store. Response shapes and requested thread IDs are checked.
- Work remains required before PHI: reviewed message policy/consent, privacy export/retention/legal-hold integration, operational monitoring/delivery expectations, production migration and activation reviews. Do not transplant this migration into the isolated production-schema qualification database.

## Files

Desktop:
- src/contracts/careMessages.ts
- src/server/clinical-core/care-messaging.ts and aws-identity-api.ts
- infra/aws-clinical-core/migrations/20260929090000_synthetic_care_messages.sql (manifest production_transform:false)
- infra/aws-clinical-core/identity-api-extension.json (two routes on the existing function)
- src/app/api/live/care-messages/route.ts
- src/components/inbox/CareMessagesPanel.tsx; src/app/inbox/page.tsx
- src/server/clinical-core/care-messaging.database.test.ts; aws-identity-api.test.ts; e2e/care-messages.spec.ts

V2:
- expo/contracts/careMessages.ts (same contract)
- expo/lib/messages/awsCareMessages.ts
- expo/app/messages.tsx; app/_layout.tsx; app/(tabs)/profile.tsx
- expo/__tests__/care-messages.test.ts

## Verification and deployment boundary

Local database tests run actual SQL and the application adapter in PGlite with fictional identities, not Aurora.
API tests exercise claim validation and routing with a fictional database transport.
Chromium tests exercise UI reads, retry identity, authorization clearing and actual unauthenticated/foreign-origin proxy refusal; message responses are intercepted fictional responses, not AWS.
Mobile transport tests cover owner/session/environment binding, production refusal, destination pinning, errors, body timeout and request validation. No physical phone acceptance.

Deployment checklist (steps 1–3 completed September 29; remaining steps are not complete):
1. Renew AWS login and pin STS account 588966314750. Identify the actual consumer/workforce API, synthetic database and deployment stack before planning changes.
2. Inspect the synthetic migration ledger and approved migration process; apply the new synthetic migration only to that matching synthetic schema. Never apply it to clinical_core_qualification or production.
3. Build the exact source artifact; update the existing synthetic identity API's code and add the two JWT routes through its reviewed stack update. No additional Lambda reservations are required by this feature, but actual stack effects still require inspection.
4. Rebuild/deploy the matched Desktop source and V2 synthetic release. The running 3100 Desktop checkout is a different working copy; it has not been switched by this work.
5. With two fictional patients and a separate practitioner, perform send/reply, cross-patient/cross-clinic denial, pause/revoke, exact retry and malformed-request hosted tests. Capture source/API/database identities and evidence without logging message bodies or tokens.
6. Obtain explicit approval before a paid EAS/TestFlight build. Test native keyboard, foreground/background clearing and actual receipt on the phone.
7. Keep real patient data and production activation off. A successful synthetic messaging test is not PHI readiness.

Nothing in this increment merges branches, pushes GitHub, publishes a mobile build, approves clinical content, modifies the mock curriculum, or certifies commercial readiness.

## Hosted backend evidence — September 29

- Synthetic AWS account 588966314750, API wxv734oi12, database clinical_core only; PHI remains false.
- Migration 20260929090000 and two JWT messaging routes deployed. Existing identity Lambda checksum matches artifact 161747a85e416b523786341871daaa1032348887f05a52b7c859c67b29682dc5. No additional reservations or unrelated pending routes deployed.
- Actual Aurora rollback-only acceptance passed: consumer send, exact retry, changed-payload refusal, workforce inbox/read/reply, consumer reply read, other-patient and other-clinic denials, paused-link denial, direct-table denial. Stronger repeat requires expected database error codes, not arbitrary transport failure. Transaction rolled back; fixture organization absence verified. No persistent test messages/accounts.
- Follow-up after owner approval: three dedicated messaging test accounts created without resetting existing users. Actual Cognito JWT invitation/send/reply/retry/access-denial tests now pass. Fixed missing AWS database error translations discovered by hosted testing; replacement code artifact75aee02b0e3c3737b2a91b99f5606147989f4c048d5f1ff1de835b056b9c58b8 deployed and checksum verified. Local150/150 tests, typecheck and targeted lint passed.
- Exact V2 messaging transport → real AWS → local Desktop browser/proxy → reply → V2 transport verified, without intercepted responses. Four proxy responses200, no page errors, session-change text clearing verified. This does not replace native phone testing or a hosted Desktop release. Evidence and reusable test operators are linked in the root messaging handoff.
- Desktop UI and V2 binary unchanged. No full-suite CI, physical-device, commercial or PHI-readiness claim. Full resource/rollback details: root handoffs/2026-09-29-patient-care-messaging.md.
