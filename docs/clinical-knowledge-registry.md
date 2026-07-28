# Clinical Knowledge Registry

The Clinical Knowledge Registry is the governed source for practitioner-authored
clinical pathways used by the patient Clinical Copilot. It keeps pathway logic,
exact product candidates, lab strategy, nutrition guidance, safety stops, and
source references versioned and reviewable.

## Current workspace

`/settings/knowledge` provides the same governed workflow in demo and live
modes:

1. Review one of the seeded clinical pathways.
2. Create a new version from the current approved version.
3. Edit its change summary, differentiating questions, and source references.
4. Save the draft.
5. Explicitly approve the draft.
6. Confirm that the prior approved version becomes superseded.
7. Load the practitioner authoring pack or a compatible JSON bundle.
8. Attest that the source contains no patient-identifiable information.
9. Stage every item in an immutable import batch.
10. Accept a valid item only into a draft/pending workflow, reject it, or return
    it to the source owner when validation blocks acceptance.

Demo edits live in browser session storage and are labeled accordingly. Live
edits pass through same-origin routes to authenticated tRPC procedures and
database RPCs. The patient Clinical Copilot reads only the approved pathway
version and snapshots that version into each generated run.

The prepared, de-identified bundle is stored server-side at
`data/clinical-knowledge/authoring-pack-core.json`. It is deterministically
derived from the Obsidian authoring workbook and currently contains 27 pathways
and 133 product-label candidates. The bundle contains no patient records. In
live mode it is available only through an authenticated, organization-bound
route with private/no-store caching. Affiliate links remain separate metadata
and never establish clinical eligibility.

## Persistent contract

Migration `20260728030307_clinical_knowledge_registry.sql` adds:

- versioned clinical pathways with immutable approved content;
- versioned product labels with immutable verified content;
- immutable Clinical Copilot input, output, knowledge, and safety snapshots;
- explicit practitioner review metadata;
- organization and patient-scoped row-level access;
- role-gated RPCs for drafting, approval, verification, run recording, and
  review;
- audit events for meaningful governance changes.

Migration `20260728165840_clinical_knowledge_import_review.sql` adds:

- immutable import batch and item source snapshots;
- SHA-256 hashes for source and item payloads;
- a mandatory no-PHI attestation;
- deterministic source validation;
- explicit item accept/reject review state;
- draft-only pathway application and pending-only product-label application;
- a role-gated draft-update RPC;
- organization-scoped RLS, direct-write revocation, and safe audit events.

Direct client writes are revoked. Mutations pass through the security-definer
RPCs, which pin their search path and verify organization membership or patient
access.

## Clinical safeguards

- Only an approved pathway version can power a normal Copilot run.
- Product candidates are not patient selections.
- A current, exact manufacturer label must be verified before product
  selection.
- Affiliate links are excluded from clinical eligibility decisions.
- Missing allergies, medications, pregnancy status, demographics, or other
  required safety context blocks the proposed protocol.
- Copilot output remains a draft until a practitioner explicitly reviews it.
- Source, schema, rules, pathway, product-label, prompt, and model versions are
  captured so prior output can be reproduced and audited.
- Later source changes mark output stale; they do not silently rewrite a prior
  run.

## Deployment sequence

1. Review the migration and acceptance SQL.
2. Apply both migrations to a disposable or staging Supabase project.
3. Run `supabase/tests/clinical_knowledge_registry.sql` and
   `supabase/tests/clinical_knowledge_import_review.sql` in rolled-back test
   transactions.
4. Deploy the backend router that exposes `clinical.knowledge.*`.
5. Run the mock regression suite and a gated live browser workflow before
   promotion.

Both migrations are committed as deployable work but are not automatically
applied to staging or production.
