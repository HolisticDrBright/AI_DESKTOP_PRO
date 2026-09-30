# Program approval binding: repair of the two release blockers

September 30, 2026. Claude Code executed this repair. PHI remains disabled, nothing was
deployed, and no mobile or Desktop web build was made.

## Both findings reproduced before anything was changed

`node scripts/audit-program-assignment-release.mjs` — Codex's own diagnostic, unmodified —
reported all three findings against the 34-migration artifact in PGlite:

```
PROGRAM_SOURCE_NOT_BOUND            assignmentAccepted: true, unpublishedLessonAvailableToConsumer: true
PROGRAM_SQL_REQUIRED_FIELD_MISSING  field: days
PROGRAM_SQL_REQUIRED_FIELD_MISSING  field: items
verdict: blocked
```

Both are real. The diagnostic was not modified, disabled or re-scoped, and it now reports
`findings: [], verdict: "pass"` against the corrected artifact.

## Finding 1 — published approval was not bound to delivered content

The service checked that a version was published, hashed the caller's request body, and
stored that. A digest of a request body proves the body was hashed; it says nothing about
where the body came from. So a practitioner could name a published version whose own
content was empty and deliver any phases they liked, including a lesson marked `released`
that no reviewer had seen.

**The repair is not a stricter check on the request. The request no longer carries content.**

- `assign` is now `{action, connectionId, programVersionId}`. Title, phases, instructions,
  released flags, ingredient keys and purchase destinations are gone from the request
  shape, in both repositories' copies of the contract, so a caller cannot express them.
- A new `clinical_private.program_consumer_content(jsonb)` reads the patient-facing program
  out of the published version's own `content` under `consumerProgram`, validates it
  against the same content contract, and returns the compiled `{title, phases}` or null.
- `assign` stores that compiled artifact and digests **it**, not the request. A published
  version that carries no valid consumer program has approved nothing for patients, and
  assignment refuses (`program_assignment_unpublished`) rather than falling back to
  whatever arrived — the fallback was the bypass.
- Republishing different content under a version that is already assigned refuses with
  `program_assignment_conflict` instead of rewriting an artifact the patient may have
  reviewed. Verified: the existing assignment keeps its digest and its phase titles.
- Draft, in-review, approved and superseded are all refused, as is a version belonging to
  another organization.

The Desktop panel is replaced, not re-labelled. Its old comment claimed it authored
nothing while it asked for a pasted version UUID and a block of phases JSON with no
authenticated source lookup behind the claim. It now has:

- a **published-program picker** (`programs` action) listing the clinic's published
  versions, with the ones that approve nothing patient-facing shown as not assignable and
  the reason said out loud, rather than hidden;
- a **server-resolved preview** (`preview` action) showing the compiled title, phases and
  the review the server would produce, including which steps are held — created by looking
  and creating nothing, which is asserted;
- a Share button disabled until a preview has come back.

Both new actions are workforce-only, organization-scoped, and refused for a consumer
caller. The picker returns another clinic's own empty list rather than a refusal; a preview
of this clinic's version from another one is refused outright.

Supplement holds are untouched. `program_plan_inventory` still reports
`inventoryComplete: false` with `governed_ingredients_unavailable_in_target`, every
supplement step is held, a phase containing one does not advance, and the preview says so
on screen. A positive flow that bypassed that hold would be a defect, and none exists.

## Finding 2 — required fields passed the validator when absent

Exactly as diagnosed: the function was one long boolean, `jsonb_typeof(x) <> 'number'` is
NULL when the key is absent, NULL is not true, and the `if` did not fire.

`clinical_private.program_content_valid` is rewritten as a sequence of explicit statements.
Every level — phase, item, product — first requires its key set to be present with `?&`,
then rejects unreviewed extra keys, then checks each field's JSON type before any cast.
The rewrite also fixes a second latent case the audit did not reach: a non-string element
inside `ingredientKeys` is now rejected rather than coerced by `jsonb_array_elements_text`.

New direct SQL negative tests in `program-content-validation.database.test.ts`, 14
assertions against the real migration in PostgreSQL, cover every required field of every
level in three states — absent, JSON null, wrong type — plus non-integer and out-of-range
day counts, a product on a non-supplement, unreviewed extra keys at each level, duplicate
phase and item ids, and the empty and oversized programs. `program_consumer_content` has
its own negatives, including the audit's exact `{}` shape.

## Corrected artifact

Migration 34 was unapplied in the inspected target, so it is corrected in place rather
than superseded. **Migration 33 is unchanged and was not touched.**

| File | SHA-256 |
| --- | --- |
| `20260929110000_synthetic_care_message_settlement.sql` (applied, unchanged) | `7777a42ab16df9d487e27914c59740230f72fbca6c183c44f18493e9dcd3929a` |
| `20260929120000_synthetic_program_assignments.sql` (corrected) | `8d6bcac8dfbe5582e7ee63d5f7ed6a5b4466760195f251d10780f08e3fb4a1d8` |
| `20260930100000_synthetic_external_calendar_connections.sql` (new, unapplied) | `d6ca115e4ee3093859569e7a18f51867fb2204fb550795bc29a8e76ddaa486be` |

Ledger is now **35** entries. Composite of all 35 `version:sha256` lines:
`b669ff72e6250e37f5e9628b217ca06322912817bea67b028423b35a959fa626`. Recompute from the
checkout before applying; do not trust this line alone.

If migration 34 has been applied in any environment other than the inspected one, do not
use this file — say so and an additive correction will be supplied instead.

The API extension now declares **38** routes: the two program routes and one new workforce
calendar-connection route. The route-count gate and its script were moved together. Deploy
the program routes only after re-reviewing the corrected migration.

## Verification level

Local source and database-harness only. V2 2,068 passed / 1 existing skip across 188
files; Desktop 3,507 passed / 11 existing skips across 287 files; both typechecks; both
lints (Desktop with its five pre-existing warnings); TestFlight gate over 328 files;
authenticated-API, provider-configuration, operation-inventory (226 operations, 0 enabled),
covered-entity (202 tables) and mock-import gates.

No hosted deployment, no physical device run, no paid build, and no PHI flag changed. The
corrections to the incoming handoff are accepted as recorded: the concurrency quota is 10
with no approval observed, the personal-storage stack is `IMPORT_COMPLETE` and must be
updated rather than recreated, and the alarm topic lists one confirmed subscription which
is not two independent responders.
