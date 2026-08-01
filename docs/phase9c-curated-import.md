# Phase 9C — the curated import safety layer

Phase 9B built a pipeline that could stage, hash, dedupe and commit knowledge.
Phase 9C is what that pipeline needed before real practitioner material could go
through it.

The distinction this phase turns on:

> A synthetic **patient** in a staging project is a test fixture.
> A synthetic **product** in the protocol picker is a clinical recommendation
> nobody made.

An imported product is a claim about a bottle nobody in this system has held.
Everything below follows from refusing to treat that claim as a product.

## What 9B could not answer

| Question | What happened without an answer |
| --- | --- |
| Which files did we actually see? | "We imported the product database" and "we could not find the product database" looked identical afterwards. |
| What did the source actually say? | Normalisation is lossy. Nothing kept the original cell to check against. |
| Is this product safe to use yet? | A spreadsheet row was attachable to a patient protocol. |
| Is this item restricted? | Prescription drugs, peptides, IV therapy and vaccine-related material got the same default as a multivitamin. |
| Is this row the product we already have? | A near-match either duplicated a product or overwrote one, silently. |

## The inference boundary

Stated once, because everything in the classifier depends on it:

> A **declared** value carries authority. A **text signal** does not.

`private.import_restricted_flags` has two halves and they are not symmetric.

* **Declared** — the source stated a `regulatoryClassification`, a `route`, an
  explicit `restrictedFlags` entry, or `vaccineRelated`. That statement is
  recorded as the flag it is, because somebody asserted it.
* **Signalled** — a word in free text resembles restricted material. The single
  flag `suspected_restricted` is raised. No class is named, nothing is written
  to `regulatory_classification`, and the only consequence is that a human has
  to look.

Getting this backwards would let a product called "Peptide Support Blend"
acquire a regulatory status nobody assigned it, and let a product genuinely
containing a prescription peptide escape one because its name is "Recovery
Formula". Checks 6–9 of the acceptance suite hold the boundary in both
directions.

A suspicion can add review. It can never grant a capability or settle a fact.

## What an imported product is when it lands

`private.apply_catalog_product_item` is the only path from a file into
`supplement_products`. What it produces:

* **Never `active`.** The review state is `incomplete` when the source did not
  supply a serving size or ingredient amounts — the two things a dose is read
  from — and `needs_review` otherwise. `draft` is reserved for a capture-only
  path that does not exist yet.
* **Carrying its restricted flags**, uncleared.
* **Carrying a provenance row**: which file, which sheet, which line, the
  verbatim source values beside the normalised ones, and the facts the source
  did not supply.

Because it is not `active`, `private.catalog_product_is_selectable` refuses it,
and all three axes follow from one function.

### The three axes, and why only one is conclusive

| Axis | Enforced by | What it proves |
| --- | --- | --- |
| Not returned by search | `search_protocol_catalog` filters on `catalog_product_is_selectable` | It is not offered |
| Not selectable | `private.catalog_product_is_selectable` | The predicate agrees with search |
| **Not attachable by id** | `protocol_items_catalog_gate`, a trigger on `public.protocol_items` | It cannot reach a patient |

Only the third is conclusive. A row can be absent from search and still be
attached by id, which is how a "hidden" record keeps reaching patients.

The gate is a **trigger on the table**, not a check inside `save_protocol_draft`.
The draft writer is one caller of many — the copilot, a future route and any
worker reach `protocol_items` too — and a rule that lives in one RPC is not a
rule, it is a habit.

## Ambiguity is a change kind of its own

`ambiguous` is neither `conflict` (two rows of one file claiming one identity)
nor `add` (a row matching nothing). It is a row that matches no governed
identity but resembles a governed product closely enough that applying it blind
would either duplicate one or overwrite the wrong one.

Both failures are silent and both reach patients, so the row stops, names its
candidates, and waits. `commit_knowledge_import` refuses while any ambiguity is
unresolved, exactly as it refuses on an unresolved conflict.

`resolve_knowledge_import_ambiguity` takes three answers and no fourth:
`new_product`, `same_as_existing` (which must name one of the candidates the row
actually raised — an arbitrary id would point the row at a product nobody
compared it against), or `skip`. There is deliberately no "apply it and sort it
out later"; that state is unrecoverable once two near-identical products are
live.

## The source-file inventory

`public.clinical_import_source_files` holds one row per file the operator
**declared**, whether or not it could be read.

Two check constraints are the point of the table. `available` cannot be claimed
without a real digest and a byte size; `unavailable` cannot be recorded while
still carrying a digest. "We hashed it" and "we never saw it" cannot both be
asserted about the same file. An inventory that can be filled in optimistically
is not evidence of anything.

`declared_name` is a **file name, never a path**. Where the operator keeps their
clinical material is not this system's business and must not end up in a
database that gets dumped, replicated or supported.

An unreadable file leaves a record with a stated reason, because "not found" and
"withheld" are different facts.

## Provenance is append-only

`public.clinical_import_provenance` carries the raw source values beside the
normalised ones. A provenance record that can be edited answers "where did this
come from?" with whatever the last writer preferred — worse than not recording
it, because it looks like evidence. The trigger refuses `update` and `delete`
with `42501`.

## Two gates on approval, and neither implies the other

`approve_protocol_version` and `approve_protocol_template_version` both call:

1. `private.protocol_dose_provenance_gate` — Part 9. A dose reaching an approved
   protocol must name where it came from.
2. `private.protocol_label_identity_gate` — Phase 9C. An **import-derived**
   product must have a `verified` label version whose product code matches the
   product's SKU, UPC or manufacturer identifier.

Both paths, in the same migration. Part 9 already made this mistake in the other
direction — it gated the patient protocol and left the template ungated, which
is the wrong way round if only one can be: a template is what every future
protocol is copied from.

The label gate's scope is deliberately narrow. It fires for products carrying a
provenance row. A product a practitioner entered by hand was entered by someone
holding the bottle. Widening it to every catalog product would also be
defensible, but it would retroactively invalidate protocols approved under the
earlier rule, and inventing a verification event for them is the kind of
fabrication the rest of this system exists to prevent.

Clearing a restriction is **not** approval either. `clear_catalog_product_restriction`
requires an owner or admin and a stated reason, and the product remains subject
to its review state afterwards. Two independent gates; satisfying one must not
silently satisfy the other.

## Migrations

| Version | What it does |
| --- | --- |
| `20260801185637_desktop_curated_import_safety` | Source inventory, provenance ledger, staging extensions, review states, selectability, the catalog trigger, the classifier, the label-identity gate |
| `20260801190938_desktop_import_restricted_flag_casts` | Fixes `_flags \|\| 'literal'` resolving as array-append-array |
| `20260801224354_desktop_curated_import_apply_paths` | Missing facts, candidate matching, preview and commit rewritten, the `catalog_product` apply path, provenance writes |
| `20260801224508_desktop_imported_product_approval_gate` | Routes both approval paths through the label-identity gate |
| `20260801225514_desktop_curated_import_fk_indexes` | Leading indexes on the attribution FKs |

### The defect the probe found, and the argument for probes

`20260801185637` shipped `_flags := _flags || 'parenteral_therapy'` inside the
classifier. With an untyped literal on the right, Postgres resolves `||` as
array-append-array, then fails to parse the literal as an array — **at runtime**,
because a plpgsql body is only parsed when it executes. The migration deployed
cleanly and raised `malformed array literal` the first time it saw a declared
route.

It was found by running the refusal, not by reading the migration back. A
refusal that has never been triggered is a comment, not a control.

## Verification

`supabase/tests/desktop_curated_import_safety.sql` — 35 checks, rolled back at
the end. Run on `urcjiehlxoehievobezf`: **35 passed, 0 failed, 0 never
evaluated.**

Regressions run against the same project after the change:

| Suite | Result |
| --- | --- |
| `desktop_no_demo_catalog_content.sql` | 15/15 |
| `desktop_knowledge_import_graph.sql` | 52/52 |

Advisors: no new `ERROR`-level findings. The four new RPCs join the project's
existing `authenticated_security_definer_function_executable` set — each one is
`security definer` with a pinned empty `search_path` and its own membership
check, which is the established pattern here. The three `rls_enabled_no_policy`
INFO findings are pre-existing and unrelated (`patient_sync_invitations`,
`provider_callback_events`, `sync_callback_nonces`).

## Not done in this phase

* Parsers and normalisers for `.xlsx` / `.docx` (server-only). The pipeline
  accepts a normalised envelope with an optional `sourceRaw` object; nothing yet
  produces one from a real file.
* The Import Review Workspace surface — ambiguity resolution, restriction
  clearance and the source inventory currently have RPCs and no screen.
* No content has been imported. This phase is the set of refusals that make
  importing content survivable, and nothing more.
