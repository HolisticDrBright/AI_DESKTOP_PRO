# Phase 9F - Research Completion

## Status

Phase 9F now has a complete consumer-side preview path for all five governed
data streams in the authorized Product Research Handoff v2 package:

1. product-label research;
2. evidence-source records;
3. commercial links;
4. archived evidence-artifact metadata; and
5. conflict-resolution packets.

The package remains draft research. Previewing it does not verify a label,
approve a clinical claim, activate a product, attach anything to a patient,
resolve a conflict, or make any item available to the copilot.

## Authorized Package

The package is read from the operator's workstation and is never copied into
Git. Independent consumer preflight reports:

- 37 checks passed, 0 failed;
- 172 clinical research rows;
- 172 commercial rows;
- 642 evidence-source rows;
- 583 artifact-index rows, with all artifact bytes re-hashed locally;
- 199 conflict packets, all requiring a practitioner decision;
- 141 restriction-flagged records;
- 77 exact-identity candidates; and
- 0 records marked clinically approved, practitioner verified, or imported.

The 583 archived evidence files total about 89 MB. Their bytes remain on the
operator's workstation. The application receives only the bounded index
metadata (relative path, digest, byte count, source identity, and supported
fields). A digest proves which archived bytes were reviewed; it does not prove
that a current physical product label is unchanged.

## Runtime Boundary

`POST /api/live/knowledge/research-handoff` parses only files explicitly
selected by the signed-in practitioner. The parser:

- verifies exact filenames, SHA-256 values, and manifest counts;
- enforces bounded file and row sizes;
- rejects malformed or duplicate identifiers;
- rejects absolute paths and path traversal;
- verifies every artifact and conflict reference against the clinical and
  evidence streams;
- rejects clinical rows that claim approval, verification, or import;
- preserves clinical and commercial separation; and
- requires every conflict packet to remain practitioner-gated.

The route invokes `preview_research_handoff_v2` using the caller's practitioner
JWT. The RPC creates five batches atomically and idempotently. It is executable
only by `authenticated`, and the existing knowledge-editor gate enforces tenant
membership and role. `anon`, `PUBLIC`, and `service_role` cannot execute it.

The artifact-index and conflict-packet batches carry explicit `preview_only`
flags. A database trigger prevents either batch from entering `committed`, and
the generic item-review path cannot apply those entity types. Conflict packet
proposals are research inputs, never practitioner decisions.

## Practitioner Workflow

Open **Settings -> Import Review -> Research handoff** and select:

- `handoff-manifest-v2.json`;
- `product-label-enrichment-v2.jsonl`;
- `commercial-links-v2.jsonl`;
- `evidence-sources-v2.jsonl`;
- `evidence-artifact-index.jsonl`; and
- `conflict-resolution-packets.jsonl`.

The Preview button remains disabled until the practitioner manually checks the
no-PHI attestation. The attestation is never defaulted, synthesized, or made
through an administrative database connection.

On success the workspace displays all five batch IDs, safe aggregate counts,
and runtime posture. A retry with identical bytes returns the same batch IDs.

## Verification

- Package preflight: 37 passed, 0 failed.
- Parser tests: 23 passed.
- Phase 9F SQL acceptance: 21 passed in one rolled-back transaction, zero
  residue.
- Browser workflow: manual attestation, six-file requirement, five-batch
  response, idempotent retry, and preview-only commit refusal.
- Full order-independence battery: 269 passed in forward order and 269 passed
  in reverse order, 0 failed (32 environment-gated skips in each order).
- Unit suite: 666 passed.
- Typecheck, lint, clinical production build, stub-reset, mock-import, and
  clinical-bundle gates: passed (lint retains 9 pre-existing warnings).
- Security and performance advisors: no new findings after the migration.

## Remaining Human Decisions

The code and database ingestion boundary can be completed independently, but
the real package cannot be previewed without the practitioner's signed-in
no-PHI attestation. After preview, all 199 conflict packets and every restricted
or incomplete clinical row remain unresolved until a practitioner records an
individual governed decision. No bulk approval or conflict resolution exists.

Phase 10, AI Longevity Pro, vAIne, the demo repository, rork, and mobile
repositories are outside this phase and were not modified.
