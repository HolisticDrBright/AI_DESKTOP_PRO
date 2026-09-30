# A contestable record, and a delivered record that can be corrected

**Date:** 2026-09-30 · **Boundary:** synthetic only · **PHI:** disabled · **Status:** implemented and locally verified; nothing deployed.

## Why

Two gaps, both about what happens *after* something is already wrong or already out of date. The
review pipeline governs the clinician before a record is made; nothing governed what came next.

**A patient could not say "this is wrong about me."** They could ask for a stored *value* to be
corrected through the privacy path. They could not contest a *conclusion* — an interpretation, a
protocol, an answer the clinic recorded for them. No competitor in the two September teardowns has
any path for this; Jane and Practice Better have co-signing, which governs the clinician, not the
output.

**When a clinician published a corrected program, everyone already holding the old one kept holding
it, silently, forever.** That is the most dangerous quiet failure in the product: a patient following
a protocol the clinician has since changed. Jane, Practice Better and Biocanic all publish and forget.

## Migration 41 — `20260930160000_synthetic_clinical_disputes_and_revisions.sql`
`sha256 24c4e70c9e28cbd27a1df42a069de0c2de3425e62c9fc3bb9fe37b685fadbdfe`

### Contesting a record
`clinical_disputes` + `clinical_dispute_statements`, with
`clinical_core.clinical_dispute_consumer(jsonb)` (raise / add_statement / withdraw / list) and
`clinical_core.clinical_dispute_workforce(jsonb)` (list / **summary** / acknowledge / resolve).

The rules that make it more than a suggestion box:

- **Resolution never removes it.** `summary` reports resolved disputes too, so any screen showing a
  contested item can show that it is contested. `corrected` is the only resolution that means the
  clinician agreed; `upheld` means the record stands and the disagreement is now part of it — the
  same shape as a statement of disagreement recorded alongside a denied amendment.
- **A resolution requires written words** the patient sees. A resolution with no answer is a
  dismissal wearing a decision's clothes, and the check constraint refuses it.
- **An answer cannot be rewritten** once given. An amended answer is a new dispute.
- **The patient's words live in their own table.** An erasure takes them; the fact that an item was
  contested and what the clinician answered is the clinic's record and survives.
- Subjects are validated per kind (assignment / lab observation / form response) against the
  connection, because one column cannot carry a foreign key to three tables. A rejected observation
  is not a subject: there is nothing to contest in a record that was never accepted.

### Correcting a delivered record
`content_revision_notices`, with `clinical_core.content_revision_workforce(jsonb)`
(list / **preview** / publish_notices) and `clinical_core.content_revision_consumer(jsonb)`
(list / acknowledge).

- **Delivered content is never mutated.** The compiled artifact stays immutable and digest-bound; a
  revision produces a notice and re-assignment stays a separate deliberate act. Swapping a protocol
  under someone mid-course would change what they are doing without anyone deciding to. A test
  asserts the stored content and digest are byte-identical after a notice is published.
- **Notices are not automatic on publish.** The clinician states the class, because no machine can
  tell "we reworded this" from "stop taking that".
- **`safety_withdrawal` requires a statement** in the clinician's own words and is flagged
  `requiresAcknowledgement`; the practitioner view calls out any that the patient has not
  acknowledged and says to contact them directly.
- Counts come from per-item digests, computed from the published version's own content. Only a
  published version may be announced.
- Reading marks `delivered`; acknowledging marks `acknowledged`. The clinic can tell "has not seen
  it" from "has seen it and not replied", which are different clinical situations.

### Two defects this work found in code shipped earlier today

1. **`program_assignment_audit.assignment_id` had no delete action**, so an account closure for
   anyone who had ever been assigned a program failed outright on the foreign key. Same remedy as the
   consult audit: release the reference, and narrow the audit's refusal to permit exactly that one
   update. A test asserts every other update and every delete is still refused.
2. **`program_item_digests` read only one of the two content shapes.** A published version compiles
   to `{title,phases}`; an assignment stores the phases array alone. Reading one of them reported
   every item as added. The first test caught it.

### One design error of mine, corrected before it shipped
I first made revision notices "retained" on a domain erase, as the clinic's record of having told
someone. They cannot be: a notice hangs off the assignment it is about, and an assignment is erased
on either scope, so a retained notice would be a dangling row nothing could read. Notices now follow
their assignment. Disputes genuinely can stand alone and are retained on a domain erase.

### Lifecycle, in the same migration as the domain
Export sections `disputes` and `revision_notices`; erasure counts for statements, disputes and
notices; the retained reason `dispute_records_a_decision_and_the_disagreement_with_it`.

**Design debt, stated:** this is the third migration to carry a near-identical copy of
`care_data_export`. The next domain added should refactor it into one function per section with a
registry rather than a fourth copy.

## Surfaces
- **Desktop:** `contracts/clinicalDisputes.ts`, `server/clinical-core/clinical-disputes.ts`,
  `POST /api/live/care-governance`, and `DisputeQueuePanel` mounted **first** on the Inbox — a patient
  saying a record is wrong about them is the one inbound item that cannot wait behind ordinary
  messages.
- **App (V2):** `contracts/clinicalDisputes.ts`, `lib/clinicalData/awsClinicalDisputes.ts`,
  `CareUpdatesView` (pure, rendered in tests), `CareUpdatesCard`, screen `app/care-updates.tsx`,
  reached from the profile menu. A safety withdrawal sorts first, is outlined, and its button reads
  "I have read this and stopped".
- **Infrastructure:** four new authenticated routes — **49 total, 48 authenticated and still exactly
  one declared public.**

## Ledger
Synthetic `clinical_core`: **41** migrations, composite
`65f79de3b46794b5eda02e0817c449600a482c8492a10e71bfde9fbaeafccbcc`.
Migration 33 applied and untouched. **34–41 unapplied.** Production family unchanged at 103,
`8a9a8f321fafc1f4e2c20b44825845cc64bb291c1746b1cdacfe7f23bfa3c9c2`.

## Local verification
- Desktop: 3,647 passed / 11 skipped (298 files); typecheck clean; lint clean, zero warnings; all AWS
  gates pass, including the 49-route authenticated-API check, operation inventory (226 operations, 0
  enabled), production clinical-core (103), clinical-bundle and mock-imports.
- App: 2,150 passed / 1 skipped (197 files); typecheck clean; lint clean; surface-disclosure gate.
- New tests: `clinical-disputes.database.test.ts` (13, real migration SQL under PGlite),
  `DisputeQueueView.render.test.ts` (5, rendered), `care-updates.test.ts` (8, app-side rendered).

## Not done, and not claimed
- **Nothing is deployed.** No hosted check has run against any of this and no device has seen the app
  screens.
- **Publishing a revision notice has no Desktop UI yet.** The function, contract, service and route
  exist and are tested; the practitioner-facing "you have published v2, tell the 6 patients on v1"
  flow belongs in the program panel and is the next increment. Until then notices can only be created
  through the API.
- The patient cannot yet *raise* a dispute from the app UI — the transport and contract are there and
  the list is rendered, but the raise form is not built. That is the other half of the next increment.
- Lab-observation and form-response disputes are supported by the SQL and untested through a UI.
