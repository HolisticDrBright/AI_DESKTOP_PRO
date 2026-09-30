# Erasing the contact details of someone who enquired and never became a patient

**Date:** 2026-09-30 · **Boundary:** synthetic only · **PHI:** disabled · **Status:** implemented and locally verified; nothing deployed.

## The defect

The public consult link shipped earlier today. Both erasure scopes delete a consult request the
same way:

```sql
delete from clinical_core.consult_requests q using clinical_core.patient_connections c
 where c.id=q.connection_id and c.consumer_person_id=_actor;
```

`connection_id` is nullable and stays null until a request is converted. So an enquiry from
someone who never became a patient matched **neither** scope, no retention sweep touched the
table, and their encrypted contact details stayed indefinitely. They had no account to ask from
either — the erasure path belongs to owners, and an enquirer is not one. A person who wrote once
and never came back could not be forgotten.

The erasure worked correctly for everyone it could see. The people it could not see were exactly
the ones with no other route. The first test in `consult-contact-retention.database.test.ts`
reproduces it by running the erasure's own join and asserting it matches nothing.

## Migration 45 — `20260930200000_synthetic_consult_contact_retention.sql`
`sha256 727c6b212cde6441dafa4e8b393d1ae9dbd7caaec02af519b32884ba40ec56fe`

`consult_retention_settings`, with `clinical_private.consult_purge_refusal(...)` and
`clinical_core.consult_contact_retention(jsonb)` (settings_read / settings_set / pending / purge
/ sweep).

- **Two mechanisms, deliberately separate.** The clinic can purge a *finished* request now —
  declined and withdrawn are finished. Received and accepted are not, and the manual path refuses
  them, because purging those destroys the clinic's ability to answer someone still waiting.
- **A retention window with no default.** Unset means nothing is purged automatically, and the
  screen says that in so many words: "That is a choice, not a default." How long a clinic keeps an
  enquiry is its own compliance posture in its own jurisdiction, and a number invented here would
  quietly become that posture. The sweep returns `skipped: 'no_retention_window_is_set'` rather
  than falling back to anything.
- **A refusal is a value, not an error.** `purge` returns `{purged: false, refusal: '…'}` so the
  screen can say "you have not answered this one yet" instead of showing a failed button that
  gets retried.
- **The envelope goes; the row stays.** All four contact columns are nulled together — a
  ciphertext with no tag is not a partly-erased record, it is an unopenable one — with
  `contact_purged_at` appearing in the same statement, enforced by an all-or-nothing constraint.
  Which link, what kind of visit, when it arrived and what the clinic decided survive: that is
  the clinic's record of having been asked and having answered, and it identifies nobody.
- **Opening a purged envelope is refused, not answered with nulls.** The guard lives on the audit
  insert, because writing that row is the one thing every open does before returning the
  envelope — so a purged row cannot be read by any path that records having read it, and a path
  that did not record it would be the worse bug. A test asserts no `contact_opened` row is
  written when the refusal fires.
- **A converted request is out of scope here** and says so: it belongs to a patient now, and the
  owner's own erasure reaches it.

## A second defect, introduced and caught inside this change

The first draft replaced `clinical_private.protect_consult_request()` starting from migration
20260930130000's body — which **silently removed the delete-inside-the-erasure-window allowance
that migration 20260930150000 had added**. The symptom would have been an account closure failing
for anyone who had ever enquired. Two existing tests in `intake-data-lifecycle.database.test.ts`
caught it immediately.

This is the third time in two days that replacing a whole SQL definition dropped something a
later migration had added (the consent scope list, twice, and now this). Two mitigations are in
the file: the function carries a comment naming **both** allowances and telling whoever replaces
it next that both must survive, and `consult-contact-retention.database.test.ts` now asserts the
erasure-window delete as well — so a future replacement that drops it fails in two files instead
of one.

## Surfaces
- **Contract:** `contracts/consultRetention.ts`. `purgeContactAfterDays` is required and
  nullable, not optional: null is a decision and omitting the field is not the same thing. There
  is no consumer request shape at all.
- **Service, transport, route:** `server/clinical-core/consult-retention.ts`,
  `consultRetentionCall`, `POST /api/live/consult-retention`.
- **Screen:** `ConsultRetentionView` (pure, rendered in tests) and `ConsultRetentionPanel`, on
  the telehealth requests page beside the public-enquiry queue — the only queue it applies to.
- **Infrastructure:** one new authenticated route — **55 total, 54 authenticated and still
  exactly one declared public.**

## Why there is no patient-facing erase-by-contact endpoint
An enquirer has no account, so the only unauthenticated design available would take a contact
address and erase whatever matched — which is a way to ask a clinic which addresses have written
to it. The same reasoning refused the no-login tracker URL earlier. Erasing an enquirer's details
is therefore the clinic's to do, which is also how a paper enquiry form works.

## Ledger
Synthetic `clinical_core`: **45** migrations, composite
`8cb8e9dd4049d198000209ec096805ef9a0727a165c5912fca54419f3b8f0ccb`.
Migration 33 applied and untouched. **34–45 unapplied.** Production family unchanged at 103,
`8a9a8f321fafc1f4e2c20b44825845cc64bb291c1746b1cdacfe7f23bfa3c9c2`.

## Local verification
- Desktop: 3,773 passed / 11 skipped (308 files); typecheck clean; lint clean, zero warnings;
  gates pass — clinical-core, the 55-route authenticated-API check, operation inventory (226
  operations, 0 enabled), production clinical-core (103, release hash unchanged),
  clinical-bundle, mock-imports, Core launch scope.
- New tests: `consult-contact-retention.database.test.ts` (18, real migration SQL under PGlite,
  including the reproduction of the original defect and the carried-forward erasure allowance),
  `ConsultRetentionView.render.test.ts` (7), four new marker rows in `rds-data-database.test.ts`.

## Not done, and not claimed
- **Nothing is deployed.** No hosted check has run and no practitioner has used the screen.
- **The sweep is not scheduled.** It is a button and an API call; nothing runs it on a timer, so a
  practice that sets a window must still trigger the sweep. Wiring it into the retention service
  is the next increment and is the difference between a policy and an enforced policy.
- **The sweep is bounded at 500 requests per call**, so a long backlog needs several calls. The
  screen does not yet say how many remain after a partial sweep.
- **A purge is not offered per row in the queue.** `ConsultRetentionPanel` accepts a
  `purgeRequestId` and handles the refusal, but the queue does not render a per-request button
  yet, so today a single purge goes through the API.
- The reference code and the audit trail survive a purge by design. Neither identifies anyone on
  its own, but a clinic that wrote the reference code down next to a name elsewhere has
  re-created the link outside this system, and nothing here can prevent that.
