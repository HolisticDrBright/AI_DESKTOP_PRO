# Public consult link, request queue, and pre-visit forms with signatures

**Date:** 2026-09-30 · **Boundary:** synthetic only · **PHI:** disabled · **Status:** implemented and locally verified; nothing deployed.

## Why this exists

Until now a person could only reach this clinic by installing the app, signing in, and claiming an
invitation the clinic had already created for them. That is backwards for a first consult: the clinic
cannot invite someone it has never heard from. There was no way in, and the practitioner queue could
only show people who were already patients.

There was also no way for a clinic to send its own forms. It could read the consumer app's onboarding
questionnaire once a patient linked, and it could record that a patient granted a consent *scope*, but
it could not ask its own questions about this visit, and it had nowhere to record that a patient had
read and agreed to a document.

Both are now built, in source, against the synthetic target.

## What was added

### Migration 38 — `20260930130000_synthetic_public_consult_requests.sql`
`sha256 adad3ed62e62f80e3f96eea70e39acfbd75d18fe3dd6e78f99a7cfa15a8ab167`

- `consult_links` — a clinic-published slug, the visit types and reason codes it offers, an
  `accepts_new_requests` flag separate from `status` (a clinic that is simply full should be able to
  stop taking requests without retiring a link it has already printed), and an optional expiry.
- `consult_requests` — append-only in substance: a trigger refuses deletes and refuses any change to
  what the request said when it arrived. Only the clinic's handling of it moves.
- `consult_request_audit` — content-free; which link, which request, what happened.
- `clinical_core.consult_intake_public(jsonb)` — **the one unauthenticated function.** Its authority is
  the slug. It can describe a link and add one request; it reads no patient, no connection and no
  clinical record, and it returns nothing about the clinic beyond what the clinic published. An unknown,
  disabled or expired slug gives one refusal (`consult_link_unavailable`), so it cannot be used to
  enumerate clinics.
- `clinical_core.consult_link_admin(jsonb)` and `clinical_core.consult_request_review(jsonb)` — ordinary
  verified workforce authority: list/create/update/disable/enable, and list/open/accept/decline/convert.

Two decisions are deliberate and are not softened elsewhere.

**The public form does not accept free text about health.** A visitor picks a visit type and one of the
reasons the clinic published. This is narrower than the commercial products offer, and that is the
point: an unauthenticated endpoint accepting "describe your symptoms" would be an unauthenticated
clinical intake channel, opened before any consent exists and before anyone has agreed to receive it.
The page says so, in those words, rather than leaving a visitor to discover it.

**A throttled submission is returned, not raised.** Raising would roll back the audit row in the same
transaction and leave an unauthenticated endpoint's limiter with no trace. The refusal is safe to
return because it is the *absence* of an inserted request, not a permission the caller could proceed
without. Ceilings: 20 per link per hour, 3 per contact digest per day.

### Migration 39 — `20260930140000_synthetic_intake_forms_and_signatures.sql`
`sha256 4cdb7042fc2fd7d83911ad024e9f9f2b07075441ea138f9f447fbfded887b64e`

- `intake_form_versions` (clinic-authored, draft → published → retired; published text immutable),
  `intake_packets`, `intake_packet_items`, `intake_form_responses` (append-only),
  `document_signatures` (append-only).
- `clinical_core.intake_form_admin(jsonb)`, `clinical_core.intake_packet_workforce(jsonb)`,
  `clinical_core.intake_packet_consumer(jsonb)`.

Three things are load-bearing:

1. **A packet only ever delivers a published version.** The assignment refuses a version that is not
   published (`intake_form_unpublished`) and the delivered content is compiled from that version's own
   row, never from anything a caller sends. This is the same mistake the program path shipped.
2. **A response and a signature record the content digest they answered, and the submitter must send
   back the digest of what it rendered.** A mismatch is refused (`intake_form_changed`) rather than
   recorded. Without this, "the patient agreed" means only "the patient pressed a button near some
   text", and which text is unknowable later.
3. **A signature binds to the agreement statement, digested on its own** (`intake_agreement_changed`
   on mismatch), because a document body may be long and a screen may abridge it, but the sentence
   agreed to must be provable.

Assignment also requires a granted `forms_checkins` consent for the connection
(`intake_consent_absent`). Paperwork is a disclosure in both directions.

**The typed name is stored as typed, not sealed.** This was considered and rejected: the answers
recorded next to it are far more sensitive and are stored as text under the same row-level boundary,
the clinic must display the name on every signed document, and sealing would mean handing the
patient's own API a decryption key it has no other use for. The digest is stored beside it, and the
server recomputes it over the same normalisation and refuses a mismatch, so the record cannot name one
person while attesting to another.

### A defect class found and closed while writing these

`jsonb_typeof()` returns SQL NULL for an absent key, and `NULL <> 'string'` is NULL — so a plain
`jsonb_typeof(x->'k') <> 'string'` guard **does not fire for a field that is simply missing.** That is
exactly how the earlier program validator accepted phases whose required fields were absent. Both new
migrations now route every field-kind check through `clinical_private.jsonb_kind()`, which names the
absence. The first draft of the questionnaire validator had the bug and the test caught it.

### Sealing, and where it is used
`src/server/consult/consultContactEnvelope.ts` seals a visitor's contact details (AES-256-GCM, the
link slug and contact digest as additional authenticated data) before anything is stored, and opens
them again when the clinic asks. The digest is over a normalised address, because a person who typed
`A@Example.test` on Monday types `a@example.test` on Tuesday and means the same inbox. The service
test captures every parameter sent to the database and asserts the visitor's name, address and phone
appear in none of them.

### Surfaces
- Desktop: `/consult/[slug]` (public page, rendered outside the practitioner shell — a stranger on a
  phone should not be handed clinic navigation, and that shell is desktop-only),
  `POST /api/public/consult` (seals, then calls the public clinical route — so the clinical route
  cannot receive plaintext contact details at all), `POST /api/live/consult-requests` (links, queue,
  and opening one contact; the browser is given the name and address, never the envelope or the key),
  and the request queue panel on the Requests page.
- App (V2): `contracts/intakePackets.ts`, `lib/clinicalData/awsIntakePackets.ts`,
  `components/IntakePacketItemView.tsx` (pure, rendered in tests),
  `components/IntakePacketCard.tsx`, screen `app/pre-visit.tsx`, reached from the profile menu.
- Infrastructure: `identity-api-extension.json` now declares **45 routes — 44 authenticated and
  exactly one unauthenticated** (`POST /clinical-core/public/consult-intake`, `AuthorizationType:
  NONE`, no authorizer). The gate and the infrastructure test both name that route explicitly and
  assert it is the only one, so a second unauthenticated route cannot appear unnoticed.

### Migration 40 — `20260930150000_synthetic_intake_data_lifecycle.sql`
`sha256 3dae779f3f84db058142c3d77dd6b5681c68113760d20eb42b50767af3f8fb78`

The two domains above shipped with no lifecycle, which is the same failure the messaging
domains had before migration 36: an owner asking for a copy of their data would have been
handed messages and programs and told that was everything.

Four export sections added — `intake_packets`, `intake_responses`, `signatures`,
`consult_requests` — and the erasure extended, following migration 36's rules rather than
inventing new ones:

- Their **answers** are their own words, so a domain erase removes them.
- A **packet and its items** are the clinic's record that it asked, so a domain erase keeps
  them and says so (`packet_is_the_clinic_record_of_what_was_asked`), exactly as a thread the
  clinic has written in is kept.
- A **signature** is retained by a domain erase and removed only by account closure
  (`signature_is_the_recorded_basis_for_care_already_given`), the same shape as a settlement
  tombstone. **This is a retention decision, not a legal opinion** — if a real obligation
  requires a signature to outlive the account, that is your decision with counsel, and the
  comment in the migration names the one place to change it.
- A **consult request** is removed only by account closure, and only when it was converted,
  because an unconverted request is not reachable from any account: nobody proved it was
  theirs. Unconverted requests are therefore **not covered by any lifecycle**, and there is no
  retention sweep for them. That gap is real and is not claimed as closed.

The signature export carries the document body and the agreement sentence, not only a digest,
because a copy of what they signed is the thing a person most needs to be able to keep.

Two defects the closure test found, which reading had not:

1. `consult_request_audit.request_id` referenced the request, so an account closure failed
   outright — the request could not go while a row pointed at it. Keeping the request to keep
   the audit would defeat the closure; dropping the audit would destroy the record that a link
   received anything. The reference is released instead.
2. Releasing it failed too: `on delete set null` is an update, and the audit refuses every
   update. The refusal is now narrowed rather than lifted — one update is permitted, releasing
   a reference to a request that has gone, and a test asserts every other update and every
   delete is still refused.

## Ledger

Synthetic `clinical_core`: **40** migrations, composite
`97ee291988db4a4243f6b57918d399400fe8de04fc2e59e5d6a2bc7d4cb6a6c9`.
Migration 33 remains applied and untouched. **34–40 are unapplied.**

The production/qualification family is untouched: 103 migrations, release hash
`8a9a8f321fafc1f4e2c20b44825845cc64bb291c1746b1cdacfe7f23bfa3c9c2`, unchanged. Both new migrations
carry `production_transform: false`.

## Local verification

- Desktop: `test:unit` 3,620 passed / 11 skipped (296 files); typecheck clean; lint clean, zero
  warnings; authenticated-API gate (45 routes, one declared public); clinical-core, identity/consent,
  provider-configuration, core-launch-scope, operation inventory (226 operations, 0 enabled),
  covered-entity (202 tables), production clinical-core (103), clinical-bundle, stub-reset,
  mock-imports, data-plane-migration — all pass.
- App: 2,142 passed / 1 skipped (196 files); typecheck clean; lint clean; surface-disclosure gate;
  TestFlight readiness gate (339 files). `expo-doctor`'s four network/config checks fail in this
  container as they did before this change, and no dependency or `app.json` entry was touched.
- New tests: `consult-intake.database.test.ts` (17, real migration SQL under PGlite),
  `consult-service.test.ts` (7, services + sealing + PostgreSQL),
  `intake-data-lifecycle.database.test.ts` (8, export and erasure under PGlite),
  `ConsultRequestView.render.test.ts` (4, rendered), `intake-packets.test.ts` (10, app-side).

## Not done, and not claimed

- **Nothing is deployed.** No hosted API check has been run against any of this, and no physical
  device has seen the app screens.
- The public route is a **new unauthenticated surface on the clinical API** and should be reviewed as
  one before it is deployed. API Gateway throttling for that route is not configured here.
- `CONSULT_CONTACT_KEY_ARN` (a 32-byte key in Secrets Manager, field `CONSULT_CONTACT_KEY`) and
  `CLINICAL_AWS_PUBLIC_API_ORIGIN` / `NEXT_PUBLIC_SITE_ORIGIN` are unset, so the public form answers
  `consult_not_configured` rather than pretending to accept requests.
- There is still **no calendar time offered to a visitor**: the public link produces a request, and a
  practitioner schedules it from the queue. Self-service slot selection by a stranger is not built.
- No email is sent to the visitor. SES production access is still not granted, and the clinic replies
  to the address it opens.
- The §4D production port remains owed and sequencing-blocked behind the 103-migration pin.
- **Consult requests that were never converted have no lifecycle.** They hold a sealed contact
  envelope and age indefinitely; no account can reach them and no sweep removes them. A
  retention period for them is an owner decision and then a small amount of work.
- The signature retention rule above is a decision to confirm, not a conclusion to rely on.
