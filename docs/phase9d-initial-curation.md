# Phase 9D — initial practitioner-content import and curation review

Phase 9C built the machinery: local-only parsers, the governed import pipeline,
and the Import Review Workspace. Phase 9D is the first attempt to put real
practitioner material through it.

## Ground rules restated

- **Only explicitly authorized sources.** The operator supplies exact file
  locations; nothing is crawled, searched for, or guessed at. An Obsidian vault
  is explicitly out of scope until a future manifest names an exact export path.
- **Sources are never altered**, and nothing raw ever reaches Git: no
  documents, no spreadsheet values, no private paths, no affiliate credentials,
  no copied protocol text. File identity in this repository and in PR text is
  by sha256 hash and declared *name* only.
- **Refusal over redaction.** A source containing patient identifiers,
  credentials, unsafe document structure, or exceeding parsing limits is
  refused and reported. It is not "cleaned".
- **Drafts only.** Nothing imported in this phase is published, selectable,
  attachable, sold, delivered, or visible to the copilot. Restricted content
  (peptide, prescription, IV, device, jurisdiction-sensitive, vaccine-related)
  lands in `restricted_review` and stays there pending clinician and
  jurisdiction review.

## Status

_This document is completed as the phase progresses._

| Part | Status |
| --- | --- |
| 1. Close Phase 9C (merge PR #26) | done — merged at `35c76a142edfcba22ae9713e7e635739c976b390` |
| 2. Phase 9D branch + draft PR | in progress |
| 3. Source access check | pending |
| 4. Pre-import privacy/safety scan | pending |
| 5. Import batches A/B/C | pending |
| 6. Review workflow | pending |
| 7. Clinical-safety proofs | pending |
| 8. Verification battery | pending |
| 9. Final report | pending |
