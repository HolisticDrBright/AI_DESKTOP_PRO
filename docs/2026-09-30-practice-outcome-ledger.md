# What happened in this practice: a treatment-outcome ledger

**Date:** 2026-09-30 · **Boundary:** synthetic only · **PHI:** disabled · **Status:** implemented and locally verified; nothing deployed.

## What you asked for, and the one correction

You asked to track what treatments are working and what are not, saved "in a HIPAA compliant way
where it doesn't save their name just their age, sex, and history", usable as a research tool to
tell doctors "what has been proven to work".

Two corrections are built into this rather than argued about:

**Removing the name is not de-identification.** HIPAA's Safe Harbor requires eighteen identifier
categories gone, ages over 89 aggregated and dates reduced to a year — and a rich longitudinal
history is itself a re-identification vector. More importantly, a revocable consent needs a link
back to the person, and a link is precisely what Safe Harbor forbids. So this is **not** a
de-identified data set and nothing calls it one. It is a limited data set held inside the clinic,
with the protections below, and its reports are aggregate-only.

**"Proven to work" is a claim this cannot make.** One practice's records are observational,
uncontrolled and self-selected: the people who came back are not the people who did not, and the
practitioner who chose the treatment also recorded the result. So the report itself carries
`interpretation: 'what_happened_in_this_practice_not_evidence_of_efficacy'`, the screen prints that
sentence in full **above** the numbers, and a render test asserts the word "proven" never appears.
What you get is a real, honest instrument: "of the 26 people I treated this way, 14 improved and 12
did not" — which is worth having, and is not efficacy.

## Migration 44 — `20260930190000_synthetic_practice_outcome_ledger.sql`
`sha256 e45fa0fc37452e3b94ce0b1ff37199f3ede8532714380af64b2eda69d835586e`

`outcome_vocabulary`, `outcome_observations`, with
`clinical_core.outcome_ledger_workforce(jsonb)` (vocabulary / declare_code / retire_code /
contribute) and `clinical_core.outcome_report(jsonb)` (report).

The protections, each one a thing the schema makes impossible rather than a rule to remember:

- **Nothing free-text is ever stored.** Conditions and treatments are codes the practice declared
  in advance; outcome and follow-up are closed sets. A test tries
  `'a_43_year_old_teacher_from_denver'` — correctly shaped, undeclared — and it is refused.
- **An exact age is never stored.** The contribution takes age in years and the database bands it,
  five years wide, with 90+ collapsed into one band. A test asserts there is no `age_years` column
  and that 90, 97 and 118 all land in `90_plus`. Under 18 is refused outright.
- **No dates.** The row carries `recorded_at` for operational reasons and no report may group or
  filter by time at all; a request carrying `since` is refused.
- **The API role cannot read the rows.** `revoke all on clinical_core.outcome_observations from
  clinical_core_api` — the only read is the aggregate function, which runs as the owner. A test
  confirms a direct select as the API role is denied.
- **Small-cell suppression with complementary suppression.** Eleven is the threshold. A cell below
  it is dropped; when exactly one cell was dropped, the smallest survivor goes with it, because one
  hole beside a known total is not a hole; and **no total is returned at all** whenever anything was
  suppressed. At most two extra dimensions per report, so nobody can slice to uniqueness.
- **Its own consent, revocably.** `research_practice_outcomes` is a new scope on the existing
  consent framework, so there is one revocation path and it is the one patients already use.
  Revoking it deletes the contributions, via a trigger on the consent row itself. So does any
  erasure the owner asks for, on either scope, via a trigger on the erasure ledger row every
  erasure already writes. Nothing has to remember to call either.

## Two defects this work found
1. **`outcome_consent_current` returned NULL, not false, for an absent grant.** `_status='granted'`
   where `_status` is null is null, and `if not null` does not fire — so a patient who had never
   consented would have been counted. Exactly the same class of bug as the `jsonb_typeof` one
   `jsonb_kind` was added for. Now `coalesce(..., false)`, and a test covers it.
2. **An empty `groupBy` was rejected.** `array_length` of an empty array is null, so the
   distinct-count comparison rejected the simplest and most useful report — outcome alone.

## One near-miss worth recording
The first draft of this migration rewrote the consent scope CHECK constraints with only the scopes
it cared about, which would have **silently dropped `reproductive_health`, `lab_results_import` and
`lab_specimen_context`** — the first symptom would have been a reproductive-health revocation
failing. The migration now carries the whole list forward with a comment saying why, and a test
asserts every pre-existing scope still inserts.

## Surfaces
- **Contract:** `contracts/practiceOutcomes.ts`. A contribution has no field for an exact age, a
  name, a date or a note; `total` is nullable and the screen never recomputes it.
- **Service, transport, route:** `server/clinical-core/practice-outcomes.ts`, two workforce calls,
  `POST /api/live/practice-outcomes`. The service deliberately re-implements none of the banding or
  suppression: a second implementation is a second chance to get it wrong.
- **Recording:** `OutcomeRecordView` (pure, rendered in tests) and `OutcomeRecordPanel`, mounted in
  `AppProgramAssignmentsPanel` once a linked patient is chosen. A render test asserts the form has
  no `<textarea>` and exactly one non-checkbox input — the age.
- **Reporting:** `PracticeOutcomeView` and `PracticeOutcomePanel` on `/reports`, which until now
  said practice reports "need real, access-scoped aggregate queries". This is one.
- **Infrastructure:** two new authenticated routes — **54 total, 53 authenticated and still exactly
  one declared public.**

## Ledger
Synthetic `clinical_core`: **44** migrations, composite
`e4c5078109e0ed87b7cf0c70649eca4e7a0b0bef6e729b507ee8a210002e7289`.
Migration 33 applied and untouched. **34–44 unapplied.** Production family unchanged at 103,
`8a9a8f321fafc1f4e2c20b44825845cc64bb291c1746b1cdacfe7f23bfa3c9c2`.

## Local verification
- Desktop: 3,744 passed / 11 skipped (306 files); typecheck clean; lint clean, zero warnings; gates
  pass — clinical-core, the 54-route authenticated-API check, operation inventory (226 operations, 0
  enabled), production clinical-core (103, release hash unchanged), clinical-bundle, mock-imports,
  Core launch scope.
- New tests: `practice-outcomes.database.test.ts` (15, real migration SQL under PGlite),
  `PracticeOutcomeView.render.test.ts` (6), `OutcomeRecordView.render.test.ts` (8), five new marker
  rows in `rds-data-database.test.ts`.

## Not done, and not claimed
- **Nothing is deployed** and no patient has been asked for this consent, because there is no
  consent artifact text for the new scope yet. A practice cannot honestly collect this until
  somebody writes what the patient is agreeing to; the schema requires an approved artifact, so the
  gap is enforced rather than merely noted.
- **This is a limited data set, not a de-identified one.** The revocation link is real and
  deliberate. It must not leave the clinic, and nothing here exports it.
- **No cross-practice pooling.** Every count is one organisation's. Pooling would need a data use
  agreement, an honest broker and a much stronger de-identification step, and none of that exists.
- **No time dimension at all**, so no trend. That is the strict reading of "no dates" and it does
  cost something: you cannot yet see whether this year is better than last.
- **No adjustment of any kind** — no severity, no adherence, no comorbidity, no baseline. Two
  treatments with different counts may simply have been given to different people, and the report
  says nothing about that beyond the interpretation line.
- **The practitioner records the outcome, not the patient.** That is deliberate (a clinical judgement
  in a counted ledger should be the clinician's), and it is also the study's main bias, stated.
