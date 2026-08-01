# Operator procedure — loading practitioner knowledge

How to load the practitioner's spreadsheets, protocol documents and Obsidian
exports into the governed knowledge layer, later, without any private or
copyrighted file ever entering Git.

**Nothing has been imported.** No source material was available in the build
environment, and none was invented. Every count in the system is zero. This
document is the procedure for when the files exist, and the importer it
describes is built and tested.

---

## The rule that shapes everything below

> A practitioner's spreadsheet is evidence of what they *do*. It is not evidence
> that what they do is correct, and importing it must never make it look like it
> is.

Everything imported lands as a **non-approved draft**. Anything the source does
not state stays `NULL` and displays as **"Unknown."** A dose, an interaction, a
regulatory status or an evidence grade that is not in the source is not in the
system.

---

## 1. Where the files live

```
<repo>/private-import/          ← git-ignored, never committed
    2026-08-01-products.xlsx
    2026-08-01-protocols.docx
    obsidian-export/
    manifest.json               ← the only file that may be copied into docs/
```

`private-import/` is ignored by a wildcard in `.gitignore`, not by a list of
filenames. A list has to be updated every time someone adds a file, and
eventually is not.

**Check before every import:**

```bash
git status --porcelain private-import/     # must print nothing
git check-ignore -v private-import/manifest.json
```

If the first command prints anything, stop. Something in there is tracked.

---

## 2. The manifest

The manifest is the only artefact that may be committed, because it contains
**hashes and mappings, never content**. Its job is to make an import
reproducible and auditable: given the manifest and the original files, anyone
can verify that what was loaded is what the practitioner supplied.

```jsonc
{
  "manifestVersion": "1",
  "preparedBy": "operator name",
  "preparedAt": "2026-08-01T00:00:00Z",
  "schemaVersion": "clinical-knowledge-import-v1",
  "sources": [
    {
      "file": "2026-08-01-products.xlsx",
      "sha256": "<64 hex characters of the file as delivered>",
      "byteSize": 184320,
      "sourceKind": "product_spreadsheet",
      "sourceName": "Practitioner product formulary",
      "sourceRevision": "2026-08-01",

      // Which sheet maps to which governed entity, and which columns carry
      // identity. A sheet with no stable identity column cannot be re-imported
      // without duplicating, so the importer refuses it at validation.
      "sheets": [
        {
          "sheet": "Products",
          "entityType": "catalog_product",
          "identityColumns": ["SKU", "UPC"],
          "columnMap": {
            "name": "Product Name",
            "brand": "Brand",
            "sku": "SKU",
            "upc": "UPC",
            "manufacturerIdentifier": "Mfr Code"
          }
        }
      ],

      // Columns the operator has decided NOT to import, and why. Recording the
      // omission is the point: a silently dropped column looks identical to a
      // column that was never there.
      "excludedColumns": [
        { "column": "Notes to self", "reason": "free text, may contain PHI" },
        { "column": "Cost", "reason": "commercial; not clinical" }
      ]
    }
  ],

  "attestations": {
    "noPhi": true,
    "noCopiedSourceText": true,
    "reviewedBy": "practitioner name"
  }
}
```

### Hashing

```bash
shasum -a 256 private-import/2026-08-01-products.xlsx
stat -c '%s' private-import/2026-08-01-products.xlsx     # byteSize
```

The hash goes in the manifest **and** is carried on the batch, so a file that
is edited after import is detectable.

---

## 3. Converting a source file to import items

The importer takes JSON, not spreadsheets. Conversion happens on the operator's
machine and its output is also never committed.

Each item is:

```jsonc
{
  "entityType": "catalog_product",
  "externalKey": "row-14",           // optional; a generated id is used if absent
  "displayName": "Magnesium Glycinate 200 mg",
  "sourceSheet": "Products",
  "warnings": ["Dose column was blank in the source"],
  "payload": { /* mapped per columnMap above */ }
}
```

### Entity types the importer accepts

| `entityType` | Identity used for dedupe | Applied to |
| --- | --- | --- |
| `product_label` | `productCode` | `product_label_versions` |
| `catalog_product` | `sku` → `upc` → `brand\|name` | staged; no apply path yet |
| `knowledge_reference` | `code` + `revision` | staged; no apply path yet |
| `knowledge_claim` | `code` | staged; no apply path yet |
| `lab_suggestion` | `code` | `clinical_lab_suggestions` |
| `interpretation_rule` | `biomarkerCode` + `name` | `clinical_interpretation_rules` |
| `intervention_class` | `code` | `clinical_intervention_classes` |
| `graph_edge` | the five edge fields | `clinical_graph_edges` |
| `pathway` | `code` | `clinical_pathway_versions` |
| `protocol_template` | `name` | staged; no apply path yet |

**Rows whose type has no apply path are not silently swallowed.** Commit marks
them `skipped` with a note naming the type, and they stay staged and visible.
That is why the table above says "no apply path yet" rather than pretending
otherwise.

### What the validator will refuse

These are refusals, not warnings. A batch containing them cannot be committed.

- a graded evidence classification (`high`/`moderate`/`low`/`very_low`) with no
  `referenceCode` — unreferenced practitioner content must be imported as
  `practitioner_experience`, which is an honest status, not a lesser one;
- a `referenceCode` that does not resolve to a governed reference — the row is
  refused rather than quietly regraded, because silently downgrading a
  practitioner's claim misrepresents them;
- a `shortExcerpt` over 300 characters, or any `body` field at all — the
  registry stores structured summaries, metadata and hashes, never source text;
- a product with no SKU, UPC or manufacturer identifier — it could not be
  matched on the next import, so the next import would duplicate it;
- a lab suggestion with no `clinicalQuestion` — a test without a question is not
  a suggestion;
- a product label with no serving size, no ingredient amounts, or no
  manufacturer label URL.

---

## 4. Running the import

### Preview — writes nothing

```sql
select public.preview_knowledge_import(
  '<organization_id>',
  'product_spreadsheet',
  'Practitioner product formulary',
  'clinical-knowledge-import-v1',
  '<items json array>'::jsonb,
  true,                              -- no-PHI attestation, mandatory
  '2026-08-01-products.xlsx',
  184320,
  '2026-08-01');
```

Returns `added`, `changed`, `unchanged`, `conflicts`, `removals` and a
`batchId`. **No governed record is created or changed by this call** — the
acceptance suite asserts it by counting governed rows before and after.

Running it twice on the same bytes returns the first batch with
`"idempotent": true`. Nothing is staged a second time.

### Review

```sql
select public.get_knowledge_import_preview('<batchId>');
```

Read every `conflict`, every `validationErrors` entry, and the
`reportedRemovals` list. Removals are **reported and never performed** — this
pipeline has no delete path into governed content.

### Resolve conflicts

Two rows in one file claiming one identity is a conflict, not a race. Each needs
a decision and a reason:

```sql
select public.resolve_knowledge_import_conflict(
  '<itemId>', 'take_incoming', 'The later row is the corrected one.');
```

`keep_existing` and `skip` leave governed content alone. `take_incoming`
supersedes the earlier row.

### Commit

```sql
select public.commit_knowledge_import(
  '<batchId>',
  '{"added": 42, "changed": 7}'::jsonb,   -- the counts you actually reviewed
  'Reviewed against the 2026-08-01 formulary');
```

Commit refuses if any conflict is unresolved, if any applyable row has a
validation error, or if the counts you confirm do not match what is staged —
that last one is what stops a stale preview being committed after someone else
changed it.

Everything created is a **non-approved draft**. Approval is a separate
practitioner act.

### Abandon

```sql
select public.cancel_knowledge_import('<batchId>', 'Wrong file version');
```

---

## 5. Obsidian exports

Obsidian notes are prose. Prose is not a governed claim, and the importer will
not pretend it is.

1. Export to Markdown.
2. For each note, decide what it actually asserts and write **one item per
   assertion** — not one item per note. A note that says three things is three
   claims with three provenance records, or it is not importable.
3. `evidenceClassification` is `practitioner_experience` unless the note cites a
   source that is already in the governed registry. Import the references first.
4. Never paste note text into `body` or a long `shortExcerpt`. Write a
   structured summary in your own words and record the note's content hash.

If a note cannot be reduced to specific assertions, it is not ready to import.
Leaving it out is the correct outcome, not a failure.

---

## 6. Order of operations

Dependencies are real: a claim cannot cite a reference that has not been loaded,
and the commit will refuse with `P0002` naming the missing code.

1. `knowledge_reference` — the governed sources
2. `knowledge_claim` — statements citing those sources
3. `catalog_product` / `product_label` — exact products
4. `lab_suggestion`, `interpretation_rule`, `intervention_class`
5. `graph_edge` — the relationships between all of the above
6. `protocol_template` — last, because it references products and classes

---

## 7. After every import

- [ ] `git status --porcelain private-import/` prints nothing
- [ ] the manifest hash matches the file that was actually loaded
- [ ] every applied row is `draft` / non-approved
- [ ] rows that could not be applied are `skipped` with a stated reason, not
      missing
- [ ] `reportedRemovals` was read, and any genuine retirement was performed
      deliberately with its own reason
- [ ] the practitioner has reviewed and approved the drafts before any of it is
      used clinically

---

## 8. What this procedure cannot do for you

It cannot tell you whether the practitioner's content is correct. It enforces
that content is attributed, graded honestly, identified stably, reviewed before
it lands, and traceable back to a hashed file. Whether the underlying clinical
judgement is sound is a question for the practitioner, and no amount of schema
answers it.
