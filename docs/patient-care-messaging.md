# Patient ↔ practitioner text messaging — 2026-09-29

## Latest receipt recovery checkpoint

The first messaging release is already deployed as Desktop `c6efae0` and submitted
as synthetic TestFlight build 71 from V2 `ed3ab67`. Older unreleased notes below are
historical. Build 71 does not contain the new receipt-only restart recovery.

The additive receipt migration `20260929100000` was applied to account
588966314750 / `clinical_core` on September 29, after inspecting the exact prior
31-entry ledger. The ledger now has 32 entries; no qualification or production
database was changed. SHA-256:
`b15cc1c0f84fe5121363983dfa21f493a20fc49b5c30d4942f76fb64d565117e`.

`node scripts/deploy-care-messages-migration.mjs verify receipt` passed 14 real
Aurora rollback checks: receipt absence stays unresolved, late send recovery,
metadata-only result, idempotency, changed-payload refusal, owner/workforce/clinic
isolation, paused-link refusals, and direct-table refusal. Fictional fixtures were
rolled back and absence verified. This is database evidence, not JWT/API or phone
acceptance. 64 focused local tests, typecheck and scoped lint passed. Full suite
and the matching API deployment are pending at this checkpoint. PHI remains off.

Rebuild the migration tools from `src/server/clinical-core/migrations.ts` before
using the operator. `inspect|migrate|verify receipt` selects the separate reviewed
receipt migration; the original reviewed migration/ledger file is unchanged.

### API checkpoint after the database check

- Source `43687b5a3573c54c430b3ba590f59fe8d376e09a`; artifact SHA-256
  `bacddfe421ca7a705c3e8acbb684190aa8b767fda66e86e53fc1d11ae90b0b13`.
  Change set `care-message-receipts-43687b5-20260929` changed only existing Lambda
  code and its integration reference. Stack UPDATE_COMPLETE; Lambda checksum
  matches, Active/Successful. Previous artifact `75aee02b…` remains for rollback;
  the additive receipt function need not be removed for old-code rollback.
- Full Desktop suite: 273 files, 3,308 passed, 11 skipped. Typecheck and scoped lint
  passed. Actual Cognito/JWT API acceptance passed 15 cases at
  2026-09-29T21:45:40Z, including unresolved/committed receipt, ownership and role
  isolation, paused-link refusal, and existing send/reply/idempotency behavior.
- Actual V2 journal/transport-to-AWS recovery passed at 21:47:09Z: simulated lost
  response, recreated journal, positive receipt reconciliation, one send total.
  Native storage/session injected, not physical-device evidence. Test fixtures
  are fictional, the paused link was restored, and existing dedicated accounts
  reused. Desktop web image remains `c6efae0`; this increment required only API
  deployment. TestFlight 71 remains unchanged. No PHI or production activation.

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

### Restart-safe receipt lookup (source-only follow-up)

Additive synthetic migration `20260929100000_synthetic_care_message_receipts.sql` introduces a consumer-only receipt lookup through the same consumer messages route. It is **not yet deployed or hosted verified**. The prior migration and reviewed deployment ledger remain unchanged.

Request: `{action:'receipt', requestId:UUID, connectionId:UUID}`. A committed result returns precisely `action`, `requestId`, `connectionId`, `status:'committed'`, `threadId`, and `messageId`. Otherwise it returns only the first three fields and `status:'unresolved'`. Unresolved is a point-in-time absence, **not** cancellation or permission to create a replacement send: an in-flight request may still commit. No subject, body, digest or clinical content is returned.

Every lookup checks the active synthetic consumer identity, organization, linked record, exact verified connection, sender ownership and request ID. Cross-owner, workforce, switched-clinic, revoked and archived access is refused; another valid connection never exposes the old receipt. Receipt access is audited without content. Production remains unavailable; this migration must not be applied to the qualification or production schema.

- Synthetic AWS account 588966314750, API wxv734oi12, database clinical_core only; PHI remains false.
- Migration 20260929090000 and two JWT messaging routes deployed. Existing identity Lambda checksum matches artifact 161747a85e416b523786341871daaa1032348887f05a52b7c859c67b29682dc5. No additional reservations or unrelated pending routes deployed.
- Actual Aurora rollback-only acceptance passed: consumer send, exact retry, changed-payload refusal, workforce inbox/read/reply, consumer reply read, other-patient and other-clinic denials, paused-link denial, direct-table denial. Stronger repeat requires expected database error codes, not arbitrary transport failure. Transaction rolled back; fixture organization absence verified. No persistent test messages/accounts.
- Follow-up after owner approval: three dedicated messaging test accounts created without resetting existing users. Actual Cognito JWT invitation/send/reply/retry/access-denial tests now pass. Fixed missing AWS database error translations discovered by hosted testing; replacement code artifact75aee02b0e3c3737b2a91b99f5606147989f4c048d5f1ff1de835b056b9c58b8 deployed and checksum verified. Local150/150 tests, typecheck and targeted lint passed.
- Exact V2 messaging transport → real AWS → local Desktop browser/proxy → reply → V2 transport verified, without intercepted responses. Four proxy responses200, no page errors, session-change text clearing verified. This does not replace native phone testing or a hosted Desktop release. Evidence and reusable test operators are linked in the root messaging handoff.
- Desktop UI and V2 binary unchanged. No full-suite CI, physical-device, commercial or PHI-readiness claim. Full resource/rollback details: root handoffs/2026-09-29-patient-care-messaging.md.

### Server-authoritative settlement (source-only follow-up)

Receipt lookup could report a delivery but could not resolve its own absence, so
an owner whose send was interrupted and whose text could not be reconstructed had
no exit. Migration `20260929110000_synthetic_care_message_settlement.sql` (ledger
entry 33, `production_transform: false`) adds the decision the server has to make.

- `clinical_core.care_message_settlements` — tombstones keyed `unique(sender_id,
  request_id)`, RLS on, revoked from `clinical_core_api`, immutable by trigger.
- `clinical_core.care_message_settle(jsonb)` — consumer pool only. Takes the same
  `pg_advisory_xact_lock(hashtextextended(_actor::text,0))` the send branch takes,
  which is the single point that serialises the two. Returns `committed` (with
  thread and message IDs), `cancelled`, or `withheld`.
- `clinical_private.refuse_settled_care_message()` — a `before insert` trigger on
  `care_messages` raising `40001 care_message_settled`. Put there rather than in
  the send function so every insert path is covered, now and later.
- `care_message_receipt` is replaced (not edited in place) to add `cancelled`, so a
  second device converges instead of reporting an unresolved send that can no
  longer commit.

Existence is deliberately checked by `(sender_id, request_id)` alone and **not**
narrowed to the connection the caller named: narrowing it would answer `cancelled`
for a send that committed on a link the owner named wrongly, which is a false
cancellation. The named connection decides disclosure only — hence `withheld`,
which confirms delivery without naming a thread the owner can no longer read.
Ownership of the link authorises settling it; current verification does not, so a
revoked or replaced clinic cannot strand an owner with an unresolvable send.

Verification: `care-messaging.database.test.ts` 21/21 against real PostgreSQL via
PGlite, covering both race orders, the late-admission refusal, idempotent
settling, the replaced-link disclosure rules, cross-owner/clinic/workforce
refusals, SQL shape validation and table sealing. **Not applied to any AWS
target and not hosted-verified** — Codex owns application, in ledger order, and
hosted acceptance. V2 counterpart and client behaviour:
`expo/docs/patient-care-messaging.md`.
