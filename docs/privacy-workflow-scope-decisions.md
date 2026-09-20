# Privacy workflows: what is built, what is verified, and which launch-scope decisions block the rest

September 20, 2026. Source status for the remaining privacy workflows (original phase 3), written so
that nothing is narrowed silently. Status words: **implemented** (source on the branch), **locally
verified** (PGlite, unit or Chromium tests on fictional data), **hosted verified** (run against the
synthetic AWS account), **device verified** (physical phone or browser against a hosted backend),
**awaiting approval** (a human decision, agreement or policy is required before the work can be
finished or activated). Nothing below is hosted or device verified. A partial personal-storage export
is never labelled complete account fulfillment. Signed Desktop notes keep their addendum workflow and
are never corrected through any consumer path.

## 1. Corrections

| Correction shape | Status | Notes |
|---|---|---|
| Scalar field of a personal record (top level) | implemented, locally verified | Desktop migrations 87 and 90; exact-delta verification by the assigned operator; owner-applied successor in V2. |
| Nested scalar leaf by dotted path | implemented, locally verified | Migration 90; six segments. |
| Whole plain-value list; plain value inside a list of entries by index | implemented, locally verified | Migration 94; at most 200 plain values; negative and zero-padded indexes refused. |
| **Whole structured-entry list** (replace a list of flat entries such as medications or supplements as a whole) | **implemented, locally verified** (Desktop migration 98 `20260920160000_production_owned_correction_entry_lists.sql`; shared contract `personalCorrection.ts`) | A saved leaf that is a list of flat entries (each entry a record of 1–40 plain values or lists of plain values, no nesting) may now be replaced by another such list. Submission requires the same shape on both sides; the existing exact-successor verifier (`jsonb_set` of the whole leaf) still decides `applied`. The operator detail shows an entry-by-entry review (matched by unique string `id` when every entry on both sides carries one, otherwise by position: unchanged / changed fields / added / removed) and must verify every changed entry against the consumer's reason. The V2 form edits entries individually against the saved list's field set and value types (remove, add, change; ids kept unique; a new entry in an id-keyed list receives a fresh id, every other field is what the owner typed), shows the same per-entry summary before submission, and the owner's device writes the exact successor. Provenance per entry is not carried by the contract; the operator's review and the resolution evidence are the record. Still human decisions: whether whole-entry-list corrections are inside the Core launch scope and how the privacy notice describes them; hosted verification of migration 98 has not run. |
| **Source laboratory or document disputes** (processed lab results, source documents, voice transcripts, whole personal records) | **implemented, locally verified** (Desktop migration 99 `20260920170000_production_owned_disputes.sql`; shared contract `personalDispute.ts`) | A consumer still cannot write a clinical record. What exists now is a reviewed dispute: the owner names the store and reference (lab job id, voice job digest or record id), optionally the content digest they saw, states what is wrong and asks to amend, annotate or remove. Submission changes nothing. The assigned operator sees the target and statement in the privacy operations workspace, verifies against the store (lab or voice inventory, or the record), and records `amended`, `annotated` or `removed` with the evidence digest of what was done, or `declined` with an explanation; the outcome returns in the owner's ledger. V2 offers the dispute from the lab screen for panels with a linked processing job and lists disputes with their outcome in Privacy requests. Still human decisions: who performs amendments in the lab store and under which procedure (the dispute records the ask and the outcome, it does not execute the amendment), whether clinic-authored records are in scope, and hosted verification of migration 99. |
| **Clinic-specific amendments** (records the clinic authored) | awaiting approval | Desktop clinical notes carry their addendum workflow; a consumer correction request never edits them. Whether consumers can request an amendment of clinic-authored records through the app, and who fulfils it, is a clinic policy decision. |
| **Correction propagation** to saved plans and Ask ALP context | implemented, locally verified (this commit) | See section 4. |

## 2. Cross-store export and deletion coverage

The nine stores the deletion ledger tracks, with export and deletion coverage as built:

| Store | Export | Deletion | Notes |
|---|---|---|---|
| Personal records (stored categories) | yes, inline and prepared copy | yes, tombstone then preview-bound purge | Export is the inline export's coverage statement (`completeAccountExport:false`). |
| Personal consents | yes | yes (purge) | |
| Active plan pointer and adoption history | not in export | yes (purge) | Decision: whether the export should include plan lineage. |
| Lab jobs and documents | **not exported** | operator inventory and purge (`purgeExternal`) with reconciliation | Export of processed documents and results is unbuilt. |
| Voice jobs and transcripts (chat audio) | **not exported** | operator inventory and purge; late writes re-cleaned by the cleanup watch | |
| Identity (Cognito) | n/a | operator `purgeIdentity`, last step | |
| Clinic records | not exported (clinic tier) | recorded disposition only, never a purged claim | Clinic records are a separate clinic-tier request. |
| Device caches and recovery archives | n/a | recorded disposition; device erasure is the owner's own action (`deviceAccountErasure`) | |
| Backups and audit | n/a | retained by policy with evidence | Retention policy text is awaiting approval. |

**Decision needed:** whether the Core launch's data-access right is met by the personal-storage
export plus per-store disclosure, or whether lab documents, processing results and transcripts must be
exportable before launch. The second option is new engineering (object listing and signed delivery per
store, with the same integrity and retention rules the personal export now has). Until decided, every
export surface states its coverage and never claims completeness.

## 3. Partial failure, retry, legal hold and consent withdrawal

| Concern | Status |
|---|---|
| Deletion partial failure and retry | implemented, locally verified: per-store receipts, bounded purge batches, executor failures recorded as refused, completion only when every store has a receipt. |
| Export failure, retry and late writes | implemented, locally verified: settlement, reconciliation after certification, backoff (Desktop migrations 95 to 97). |
| Legal hold | implemented, locally verified for deletion (held requests refuse fulfillment; holds re-read under the owner lock). Export copies are removed regardless of a hold under the current policy default (`retained_under_hold` is defined and unused); **awaiting approval** as a policy statement. |
| Consent withdrawal during processing | implemented, locally verified for recordings (migration 92 cancels jobs and schedules processing objects); consent withdrawal does not delete stored personal records, which is stated in the app. |
| Guardian / caregiver access | **awaiting approval**: a separate requirement. Sign-up refuses child accounts and says pediatric access needs verified guardian authority; no acting-as entry point exists. Deferral out of the Core launch requires the owner's explicit approval and a matching statement in the launch scope; it is not assumed here. |

## 4. Correction propagation (implemented in this commit)

An owner-applied correction writes a new revision of a personal record on the service. Plans and
Ask ALP answers on a device are generated from that device's intake copies, so the corrected record
makes every derived output stale until the device restores it. V2 `expo/lib/clinicalData/correctionPropagation.ts`
keeps a per-owner device ledger of corrections awaiting refresh (only the five collections that feed
the analysis context propagate):

- applying a correction to one of them records the entry and tells the owner to restore the record in
  Personal data storage;
- plan generation refuses with `correction_refresh_required` while any entry is pending (the protocol
  screen says why, and the current plan is not replaced);
- Ask ALP shows the staleness notice on its screen;
- the intake restore settles an entry once the restored revision is at least the applied one;
- a corrupt ledger reads as pending, never as clean.

This makes stale outputs visible and blocks new clinical derivations. Saved plans are never rewritten
in place. Once the restore settles a correction, the entry moves to a per-owner regeneration ledger
(`correction_regeneration:<owner>`): the protocol screen marks the active plan "out of date after a
correction", opens the plan input review once on its own, and the owner confirms before a replacement
is generated; the current plan stays available until the new one completes. A successful generation
clears the ledger; with no active plan there is nothing to regenerate and the ledger is cleared.
Regeneration therefore stays an explicit, reviewed action (implemented, locally verified in
`correction-propagation.test.ts`; the screen flow is not device verified).
V2 `expo/__tests__/correction-propagation.test.ts` covers recording, blocking, settlement, per-owner scope and
corruption. Device verification is outstanding.
