# Phase 9E-A — Governed Curation Workspace (scope)

## Baseline

Fresh `main` at merge SHA `7835b202d79d1a9eeca08abbb6269fe2098ba039`
after the Phase 9D merge. Branch:
`claude/clinical-runtime-phase9e-curation-workspace`.

Staging: `urcjiehlxoehievobezf`. Real preview state at this branch's
open (must remain untouched during 9E-A):

- 8 active preview batches
- 979 candidates
  - 941 non-conflicted
  - 38 conflicts
  - 506 restricted
  - 310 warning-bearing
  - 172 missing-fact catalog candidates
- 32 cancelled audit batches
- 0 committed, applied, approved, selectable, attachable, or clinically
  active

## What Phase 9E-A ships

One unified curation workspace at `/settings/imports`, replacing the
duplicate review experience under `/settings/knowledge`.

Nine sections behind a single navigation header:

1. **Overview** — counts, progress bars, workflow-stage indicators,
   next-action pointer.
2. **Source files** — inventory of declared files with SHA and byte
   size; refuses paths, refuses macro-bearing / XXE-bearing files at
   declaration time (defence in depth against the parser gate).
3. **Preview batches** — batch-level status and the entry point for
   the batch-scoped views (conflicts / restrictions / labels / etc).
4. **Conflicts** — every ordinary conflict (not only "ambiguous"),
   with side-by-side rows, field-level diff, source provenance,
   restrictions/warnings, and the three governed decisions (keep /
   use incoming / skip) — each requiring a stated reason.
5. **Product labels** — versioned label editor; unknown fields stay
   `Unknown`; verified versions become immutable; corrections open a
   new version. Data entry, verification, restriction review, and
   clinical approval are separate actions.
6. **Knowledge references** — reference-level review (claim, source,
   author, date, citation, evidence grade, jurisdiction, warnings,
   restricted flags). Practitioner-authored material without an
   external citation reads `Practitioner experience`, not
   evidence-based. Dose text is reference metadata until backed by
   an exact label or governed citation.
7. **Restricted review** — filters by vaccine-related / peptide /
   prescription / IV / device / jurisdictional / suspected-restricted.
   Five outcomes: retain restricted, request evidence, defer, reject,
   clinician-reviewed for a stated jurisdiction. Clinician review is
   not approval.
8. **Commercial matching** — 91 Affiliate rows attached only to an
   independently verified clinical product identity, exact SKU/UPC or
   exact manufacturer identity, human decision + reason. Commercial
   data cannot reach eligibility / evidence / safety / interaction /
   ranking / reasoning / protocol code paths.
9. **Provenance & history** — append-only decision log per batch /
   item / label / reference / commercial link.

## The workflow the UI enforces

`preview → resolve conflicts → commit as draft → complete missing
facts → restriction/evidence review → label verification →
clinical approval → selectable`

No UI, API, direct table write, or malformed request may skip a
stage. No curation action creates an order, charge, patient
attachment, recommendation, message, protocol, or sync event.

## Constraints on this implementation phase

- Real staging previews are read-only for this branch. The eight
  batches must remain preview after this PR merges — the merge does
  not authorize commit.
- Never fabricate or infer product facts from a name.
- Restrictions may compose (client + source + server-text union) but
  cannot silently downgrade.
- Immutable audit trail for every decision.
- Additive SQL only; verify the ledger before applying anything.
- All tests use rolled-back DB fixtures or the deterministic contract
  fixture (`scripts/live-stub-server.mjs`).

## Verification (this PR proves)

- Tenant/role isolation on every new RPC and read path.
- All three conflict decisions (keep / use incoming / skip) preserve
  restrictions and warnings.
- Incomplete labels are refused for verification.
- Verified/approved versions are immutable; corrections open a new
  version.
- Commercial data is only reachable via the commercial route, never
  via any clinical read function (asserted on function bodies).
- Practitioner-authored material never gains an evidence grade it
  did not carry into the system.
- Restricted-review outcomes require appropriate authorization.
- Stale-write conflicts are refused rather than overwritten.
- Full acceptance battery (SQL, units, typecheck, lint, gates, both
  E2E orders, backend-down, advisors, secret/PHI/private-path
  scans) passes.
- Real staging preview counts are unchanged before-and-after the
  branch.

## What Phase 9E-A does NOT do

- Does not commit any preview batch.
- Does not resolve the 38 real conflicts.
- Does not verify any of the 172 real incomplete labels.
- Does not review any of the 506 real restricted items.
- Does not attach any of the 91 real affiliate rows.
- Does not begin Phase 9E-B.

Those actions are the operator's, from within the workspace this PR
delivers.

## Scope split — Phase 9E-A.1 (this PR) vs Phase 9E-A.2 (next authorized slice)

The 9E-A slice is delivered in two authorized PRs. This is a scope
split, not a reduction of the requirements — every section is still
in-scope for 9E-A overall; A.1 lands the governed database RPCs and
the primary workflow UI, A.2 lands the three heavier authoring
surfaces (label editor, commercial-matching queue, reference
curation) on top of the RPCs A.1 delivers.

### Phase 9E-A.1 — delivered

- **Database**
  - Five-outcome restricted-review RPC
    (`record_restricted_review_outcome` + `get_restricted_review_history`)
    with append-only history, role gate, jurisdiction requirement on
    `clinician_reviewed_for_jurisdiction`, and preserved restrictions
    on every outcome.
  - Governed commercial-matching RPCs
    (`attach_commercial_link_to_verified_product` +
    `revoke_commercial_link`) with exact SKU/UPC/manufacturer+name
    match, verified-only, stated-reason required, isolation from
    clinical read paths.
  - Ordinary conflict resolution RPC
    (`resolve_knowledge_import_conflict`) covering keep_existing,
    take_incoming, and skip.
- **Acceptance suite**
  `supabase/tests/desktop_curation_governance.sql` — 18 checks,
  all passing.
- **Unified workspace at `/settings/imports`** (five working sections
  + one entry-point tab + three deferred placeholders + provenance):
  - Overview (composite counts, five-stage workflow pointer)
  - Source files (unchanged)
  - Read a file (unchanged)
  - Preview batches (renders the batch review surface)
  - Conflicts (side-by-side diff, three governed decisions, reason
    required, restrictions preserved)
  - Restricted review (five outcomes, seven category filters,
    per-item append-only history)
  - Product labels — placeholder, states precisely what remains
  - Knowledge references — placeholder, states precisely what remains
  - Commercial matching — placeholder, states precisely what remains
  - Provenance & history (unchanged)
- **Retire the duplicate `/settings/knowledge` import-review tab**
  through a clear contextual redirect that names where the workflow
  now lives.
- **Preserve all eight real preview batches** unchanged. Rolled-back
  DB fixtures and deterministic contract fixtures back every test.
- **No dead buttons**; every deferred section names precisely what is
  not yet available and what remains for A.2.

### Phase 9E-A.2 — next authorized slice

Mandatory follow-up work; not to be started in the 9E-A.1 session.

- Product Label versioned editor (writes on top of the versioned
  label tables and the existing verify/approve RPCs).
- Commercial-matching practitioner UI (writes on top of the A.1
  attach/revoke RPCs; queue view, exact-match affirmation, disclosure
  edit, revoke via supersede).
- Knowledge Reference curation (evidence grade, citation, jurisdiction,
  reviewer identity, warnings, restricted flags, practitioner-experience
  labelling for uncitated material).
- Migrate the three E2E specs that this PR left `.skip`-labelled
  (11–13) onto the A.2 surfaces they exercise.
