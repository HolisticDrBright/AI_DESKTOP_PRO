# BLOCKED EMR note-save settlement candidate

This branch contains a source-only, unregistered SQL candidate and six PGlite tests for a durable, idempotent draft-save receipt. It is **not** applied to AWS, enabled in the API, exposed to the composer, or approved for PHI. Do not merge or register it as a release without the remaining work below.

Base source commit: `e45b60cf0ae8ceeffccd839a43e5955e0cea8d46`. Candidate file SHA-256 over its current bytes: `68cdc0e1c5738be53083ba07b9a2d9d8f8c7e26bd57cf57033bf9e86d55d7cd2`. This digest is **not** a registered production migration identity.

## Why it exists

Desktop CI run `38633207512` failed its first browser attempt after a conflict: the final save request had no observed response, and the composer remained on `Saving…`. The rerun passed, but a lost response after a first draft creation can make a blind retry create a second draft. The current composer has no request deadline, durable write identity or explicit unconfirmed state.

## What this candidate proves locally

- A UUID request ID and a fingerprint of the exact save inputs are recorded in `clinical_private.note_save_receipts` in the same transaction as the clinical draft/version/audit event.
- Repeating the same save returns the first receipt without another draft or version. Changing the payload under the same ID is refused. A failed first transaction has no receipt and can be retried safely with the same ID.
- A scoped receipt query returns `unconfirmed` or a saved note/version; it does not claim an absent receipt proves failure. A different practitioner or clinic cannot read another actor's receipt. The API role has no direct table access.
- `npx vitest run src/server/clinical-core/emr-note-save-settlement.database.test.ts`: 6/6 passed on the complete production migration artifact. `npm run typecheck` passed.

## Required before any registration or activation

1. Review schema retention, deletion, export and audit treatment of the receipt (it stores identifiers and a request digest, not note text). Review actual PostgreSQL concurrent insert behavior; PGlite's one-connection test is not a lock-wait test.
2. Add the exact candidate digest, parent migration identity, rollback/preservation checks and operator approval packet. Keep the candidate BLOCKED until reviewed.
3. Wire the API dispatcher and adapter to accept and validate a stable request ID; gate the new path off until the matching migration is applied. Retain old route compatibility for clients that do not send an ID.
4. Give the browser a bounded save deadline and an explicit unconfirmed state. On a lost reply, query the authorized receipt and exact note content; never infer failure from a timeout or launch a fresh-id retry. A practitioner may explicitly retry the **same** request ID after an unconfirmed status, and signing/review must stay disabled until authoritative settlement. Serialize autosave and manual save and fence late replies after navigation or account/clinic change.
5. Add browser and hosted negatives for no response, committed/lost response, uncommitted timeout, first-create retry, two-tab conflict, late reply after identity change and refusal to sign during uncertainty. Preserve the existing `Saved v3` conflict-recovery assertion; do not lengthen it to hide a hang.

This candidate is one component of the repair, not the repair's completion. The production pools, real patient data and mobile builds are outside this branch.
