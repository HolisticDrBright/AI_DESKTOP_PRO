# Clinical Knowledge Registry

The Clinical Knowledge Registry is the governed source for practitioner-authored
clinical pathways used by the patient Clinical Copilot. It keeps pathway logic,
exact product candidates, lab strategy, nutrition guidance, safety stops, and
source references versioned and reviewable.

## Current preview

`/settings/knowledge` provides a complete mock-mode workflow:

1. Review one of the seeded clinical pathways.
2. Create a new version from the current approved version.
3. Edit its change summary, differentiating questions, and source references.
4. Save the draft.
5. Explicitly approve the draft.
6. Confirm that the prior approved version becomes superseded.

Preview edits live in browser session storage and are labeled accordingly. The
patient Clinical Copilot reads only the approved pathway version and snapshots
that version into each generated run.

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
2. Apply the migration to a disposable or staging Supabase project.
3. Run `supabase/tests/clinical_knowledge_registry.sql` in a rolled-back test
   transaction.
4. Deploy the backend router that exposes `clinical.knowledge.*`.
5. Replace the mock adapter bodies with live calls behind the existing
   live-data flag.
6. Run the mock regression suite and a gated live browser workflow before
   promotion.

The migration is committed as deployable work but is not automatically applied
to staging or production.
