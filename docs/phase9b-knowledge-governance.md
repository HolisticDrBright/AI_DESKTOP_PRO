# Phase 9B — knowledge governance

What the governed knowledge layer guarantees, where each guarantee is enforced,
and what it deliberately does not claim.

## What has not been done

Stated first, because it is the part that matters.

- **No source material has been imported.** No product spreadsheet, affiliate
  sheet, protocol document or Obsidian vault was available in this environment.
  None was invented. Counts of imported products, claims and protocol
  components are therefore **zero**.
- **No governed interaction reference is loaded.** The safety core reports
  *"Interaction review not completed"* and names the missing input.
- **The protocol copilot is not built.** Parts 6, 7, 9, 11 and 12 are not
  delivered — see the PR for the exact split.
- **`product_label_versions.affiliate_url` is still a defect.** It is recorded
  as outstanding in the authority map with a migration path, not silently
  carried as fixed.

## Evidence classifications

| Grade | Means | Requires a reference? |
| --- | --- | --- |
| `high` / `moderate` / `low` / `very_low` | graded against a governed source | **yes** |
| `practitioner_experience` | a clinician's own observation, labelled as such | no |
| `unclassified` | not yet graded | no |

The constraint `claim_graded_needs_reference` enforces the right-hand column.
Anything stronger than practitioner experience **cannot be stored** without an
exact `reference_id`. This is the single rule that makes "evidence-based"
mean something in this system: it cannot be asserted by typing it into a form.

Practitioner-authored protocols without governed references are
`practitioner_experience`. That is not a lesser status to be hidden — it is an
honest one to be displayed.

## Source and claim versioning

A reference row **never changes**. `clinical_knowledge_sources` has carried
`private.forbid_mutation` since the Phase-1 registry, and this phase keeps that
rather than weakening it. A new edition is a new row; `code` + `revision`
already express that.

Lifecycle lives beside the row in `clinical_knowledge_source_states`, which is
append-only:

```
draft → approved → superseded | withdrawn | expired
```

`current_reference_status(reference_id)` reads the latest state, falling back to
the status the row was created with. Recording `superseded`, `withdrawn` or
`expired` marks every claim citing that reference **stale** — `stale_at` and
`stale_reason` are set, and nothing else about the claim changes. A practitioner
keeps reading the same words and additionally learns the ground moved.

Superseding must name its successor (`superseded_by_id`); the other terminal
states do not pretend to know one.

## What is never stored

No copyrighted document. No long copied passage. The registry holds metadata, a
structured summary, a content hash, and — where quoting is genuinely necessary —
a `short_excerpt` capped at 300 characters by a check constraint. The cap is the
compliance boundary, enforced rather than trusted.

Unknown attributes stay `NULL` and display as **"Unknown"**. Nothing defaults to
a plausible value, because a populated field reads as a fact somebody
established.

## Product verification

```
incomplete → verified → stale | discontinued | conflicted
```

- Default is `incomplete`. A row cannot become verified by being created.
- `verified` requires `verified_at` **and** `verified_by` together or neither.
- `conflicted` requires a `conflict_note` saying what conflicts.
- A published label version is frozen, and so are its ingredient amounts —
  otherwise amounts could be edited underneath a published label.

Nothing is inferred from a product name. Regulatory classification, ingredients,
dosage and warnings are recorded from a real label or left `NULL`.

An unverified, stale, conflicted or discontinued product **may** appear in the
catalog — hiding it just pushes practitioners to a worse source. What it may not
do is enter an approved protocol without a `catalog_use_exceptions` row: a
reason, a named approver, a specific product version, and at most one live
exception per organization per version.

## Affiliate separation

The catalog spine this phase builds on — `supplement_products` and
`supplement_product_versions` — carries **no commercial column at all**. The
acceptance suite asserts this rather than assuming it.

Commercial data lives in `product_commercial_links`, which hangs off the
organization's `products_services` row: commerce beside commerce, never beside a
label fact. It carries supplier, commission disclosure, last verification date
and availability.

`evaluate_protocol_safety` reads no commercial table, and says so in its own
output. Affiliate data cannot influence eligibility, ranking, safety or evidence
scoring because the clinical path never joins to it.

**Outstanding:** the legacy `product_label_versions.affiliate_url` column. See
the authority map for why deletion was the wrong fix and what the right one is.

## The deterministic safety core

`evaluate_protocol_safety(version_id)` reports **three** states per check and
never a fourth:

| State | Means |
| --- | --- |
| `ok` | the check ran and found nothing |
| `finding` | the check ran and found something specific |
| `not_completed` | the check **could not run**, and says why |

The third state is why the function exists. An empty findings list from a check
that never ran is indistinguishable on screen from an all-clear.

Checks: recorded allergies, duplicate ingredients, duplicate products,
medication interactions, demographics and paediatric status, label verification,
jurisdiction-sensitive classes, and commercial separation.

**Interaction limitations.** Where no governed interaction reference exists the
report says *"Interaction review not completed"* and names the missing input —
no structured ingredients, no recorded medications, no coded identifiers, or no
governed reference loaded. It never manufactures a finding. "No active
medications are recorded" is reported explicitly as *not* evidence the protocol
is interaction-free.

**Lens invariance.** The function takes no paradigm argument. No clinical lens —
Western, functional, naturopathic, TCM, biohacking or synergistic — can suppress
urgent safety content, because none of them is an input.

**Jurisdiction.** Prescription, peptide and device classes are flagged for
review with an explicit statement that the system makes *no determination that
any intervention is legal where you practise*.

## Reviewer roles

| Authority | Scope |
| --- | --- |
| **Platform curator** (`platform_curators`, `private.is_platform_curator()`) | paradigms, domains, governed references and claims, reference templates |
| **Organization practitioner** (owner / admin / practitioner) | org protocol templates, org catalog notes, org claims, use exceptions |

Platform-governed tables carry **no `organization_id`** — that is what makes the
distinction structural rather than conventional. Organization content carries
one and is isolated by RLS. Claims with a null `organization_id` are
platform-governed and readable by any member; claims with one are visible only
to that tenant.

Before this phase, platform tables had a read policy and **no write policy** —
writes were closed but nobody could curate. `platform_curators` is the missing
half.

## Import procedure

The importer is **not built** in this phase. The knowledge import tables
(`clinical_knowledge_import_batches` / `_items`) exist from Phase 1 and are the
intended home; the product importer is not yet written.

When it is built, the operator procedure must be: place source files outside the
repository, hash each file, run a preview that writes nothing, review additions
/ changes / conflicts / removals, then commit under a reviewer's name. Source
files are never committed, and no credential or raw private document enters the
repository or the database.

## Deployment and rollback

Six migrations, all additive except two deliberate drops (`knowledge_sources`,
verified as having no dependents) and one restore. No environment variable is
added. No worker. No outbound call.

Rollback: the new tables can be dropped without touching anything from earlier
phases; the columns added to `clinical_knowledge_sources`,
`supplement_products`, `supplement_product_versions` and
`product_commercial_links` are nullable additions and can be dropped
individually. The 22 new `clinical_domains` rows are additive and can be
deleted by code.

## npm audit

Reported as found, not smoothed over. `npm audit` at this checkpoint:

| Package | Severity | Note |
| --- | --- | --- |
| `brace-expansion` | high | DoS via unbounded expansion. A non-breaking fix is available and should be taken. |
| `sharp` / `next` | high | libvips CVEs inherited through `sharp`. The offered fix **downgrades Next.js from 15 to 14.2.35** — a semver-major move backwards that would break the App Router usage this product is built on. |

3 high, 0 critical, 0 moderate, 0 low.

The `sharp` chain is **not** fixed here, deliberately: taking the offered
remediation would trade a transitive image-processing CVE for a framework
downgrade across the whole application, which is a larger change than this phase
should make and needs its own decision. It is recorded so the choice is visible
rather than absent.
