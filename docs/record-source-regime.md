# Per-record provenance (source regime)

September 22, 2026. Source only; nothing deployed, PHI disabled.

## Why

Two populations are governed by different regimes: a consumer who enters records for themselves, and a clinic's patient
whose records exist under that clinic's authority. The separation has always been structural here — different tables,
different identity pools, different APIs, different consent — but structure is an argument, not evidence. A reviewer
asking "show me which rows are consumer rows, and show me that none of a clinic's protected information landed among
them" could only be answered by reasoning about table names.

Migration 102 makes the answer readable from the row.

## What it does

`clinical_core.owned_consumer_record_versions` gains `source_regime`, and the owner-scoped consumer store admits exactly
one value, `consumer_self_entered`:

- The **ingestion path sets it**. `write_owned_consumer_record` states the regime explicitly rather than leaning on the
  column default, so provenance is decided where the record enters and that decision is visible in the function body. The
  writer returns it, so a caller can record what was stored rather than what it assumed.
- **Nothing else can.** A clinic-authority row cannot be inserted into this table at all: the check constraint refuses
  any other value, whatever the caller claims.
- **It cannot be reclassified.** A later revision of the same record may not restate the regime differently, and a stored
  row may not be updated to another regime. Both are refused by triggers with `owned_record_regime_immutable`.

The clinic side keeps its own separation: those records live in organization-scoped tables reached only through workforce
identity, and the consumer actor cannot address them.

## What it is not

It is not a claim that the two populations are correctly separated everywhere in the product, and it is not a hybrid
entity designation. It is one control: the consumer store is provably consumer-only, and its provenance cannot drift.
Whether a given deployment's data flows respect the boundary elsewhere is a separate review.

## Verification

`owned-record-provenance.database.test.ts` runs the real SQL from the built artifact in PGlite: the regime is set on every
revision and returned to the writer; a clinic-authority insert is refused; a second revision that restates the regime is
refused; an update to another regime is refused; and the store afterwards holds exactly one regime. Locally verified only.
