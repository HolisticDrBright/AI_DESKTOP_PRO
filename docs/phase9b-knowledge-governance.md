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
- **No governed intervention class, lab suggestion, interpretation rule or
  graph edge is loaded.** The tables and the pipeline that fills them exist and
  are tested; the content does not, because no source was available.
- **Four import entity types stage but do not apply yet** — `catalog_product`,
  `knowledge_reference`, `knowledge_claim` and `protocol_template`. A row of
  one of these is committed as `skipped` with a note naming the type, and stays
  staged and visible. It is not silently swallowed.
- **The protocol copilot is built but disabled by default**, and it produces
  drafts only.

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

Commercial data lives in three append-only link tables, each hanging off the
thing it actually concerns:

| Table | Subject | Written by |
| --- | --- | --- |
| `product_commercial_links` | `products_services` (inventory/billing) | Phase 8A |
| `product_label_commercial_links` | a product **label version** | `save_product_label_version`, the importer |
| `protocol_commercial_links` | a protocol **version** | `save_protocol_draft` |

An affiliate link with a URL **requires a commission disclosure** — a check
constraint, not a convention. Undisclosed commission is the failure mode the
whole separation exists to prevent.

Append-only is right here: a commercial relationship is a historical fact about
a point in time. Superseding one records a new row, so "what were we disclosing
in March?" stays answerable.

The protocol link is keyed to the protocol **version**, not the item, because a
draft autosave deletes and reinserts every item — a link keyed to an item would
be cascade-deleted on the next keystroke. The item label is carried as a human
locator and is deliberately **not** a foreign key, so it cannot become a second
path by which commercial data re-enters a clinical join.

### What is asserted, not assumed

1. **No clinical table carries a commercial column.** Nothing outside the three
   tables above has an affiliate, commission, payout or referral column.
2. **No function writes the dropped column.** plpgsql keeps a stale column
   reference in a function body until the day it executes, so this is checked
   against `pg_proc`, not inferred. `save_product_label_version` is the sole
   match and only as its parameter `_affiliate_url` — which is how the RPC keeps
   its Phase-1 signature while routing the value to the commercial model.
3. **The clinical read path serves no commercial field.**
   `private.protocol_version_json` no longer emits `affiliateUrl`. This is the
   load-bearing one: an affiliate link cannot influence clinical ranking because
   the clinical payload does not contain one to rank by.
4. **No eligibility, safety, ranking or evidence function references a
   commercial table** — `evaluate_protocol_safety`,
   `check_protocol_interactions`, `search_protocol_catalog`,
   `protocol_version_json`, `current_reference_status` and
   `catalog_verification_status` are all checked by name.
5. **The copilot cannot be influenced by commercial data** because its contract
   has no field that can carry any, and it contains no scoring function.

Reading commercial data is a separate call (`list_label_commercial_links`,
`list_protocol_commercial_links`), and each returns the database's own
disclaimer so a UI cannot soften it.

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

## The import pipeline

**Nothing is inserted silently.**

```
preview  →  review  →  resolve conflicts  →  commit  →  non-approved drafts
   ↑                                                          ↓
writes NOTHING governed                        approval is a separate act
```

`preview_knowledge_import` parses, hashes, validates, dedupes and classifies,
writing only into the staging tables. The acceptance suite proves this by
counting governed rows before and after the call rather than taking the
function's word for it.

`commit_knowledge_import` is the only path into governed tables. It refuses
while any conflict is unresolved, while any applyable row carries a validation
error, and when the counts the reviewer confirms do not match what is staged —
that last one is what stops a stale preview being committed after it moved.

**Idempotency works at two levels.** A unique index on
`(organization_id, source_sha256)` means the same bytes cannot produce a second
batch. `clinical_knowledge_import_state` remembers the last payload hash applied
per `(organization, entity type, dedupe key)`, so a row that has not moved is
classified `unchanged` and does nothing.

**A removal is reported, never performed.** A key previously imported from the
same kind of source and absent from the incoming file is surfaced for review.
There is no delete path from this pipeline into governed content — discovering
an absence in a spreadsheet is not consent to erase a clinical record. Scoping
removal detection to the source kind matters: a protocol document must never
appear to delete products because it does not mention any.

**A conflict is a question, not a race.** Two source rows claiming one identity
are both stored so a reviewer can see both, and each needs a written reason.
`take_incoming` supersedes the earlier row; `keep_existing` and `skip` leave
governed content alone.

The full operator procedure — where files live, how they are hashed, what the
manifest contains, and the order entity types must be loaded in — is in
[`phase9b-operator-import.md`](./phase9b-operator-import.md). Source files never
enter the repository: `private-import/` is excluded by a wildcard, and the
exclusion is verified rather than assumed.

## The protocol copilot

Disabled unless `PROTOCOL_COPILOT_ENABLED` is set. When disabled it **throws**
rather than returning an empty draft — an empty draft is indistinguishable from
"nothing to suggest", and the API reports it as `unavailable` (503) rather than
a fault.

There is no model behind it and no outbound call. Every suggestion is assembled
from records that already exist, deterministically, so the same inputs give the
same draft and the output is reviewable rather than merely plausible.

| It cannot | Because |
| --- | --- |
| write, approve, activate, order, send or charge | no function in the module has that shape, and it imports no adapter |
| invent a dose | `proposedDose` is only ever copied from a source named in `doseSource`; an item with no recorded dose emits a null dose and an explicit `dose_unavailable` suggestion |
| manufacture an interaction finding | every draft reports `interactionReviewState: "not_completed"` and names the specific missing input |
| hide an allergy conflict | conflicts are raised as suggestions; the item is never silently removed |
| favour an affiliate product | commercial data is not an input — the contract has no field that can carry one, and there is no scoring function |

Ordering is by clinical position from the source template.

## Deployment and rollback

Eleven migrations. Additive except three deliberate column drops
(`knowledge_sources`, `product_label_versions.affiliate_url`,
`protocol_items.affiliate_url` — each with its history copied across first), one
restore, and two duplicate indexes removed.

One environment variable is added: `PROTOCOL_COPILOT_ENABLED`, absent by
default, which leaves the copilot off. No worker. No outbound call.

Rollback: the new tables can be dropped without touching anything from earlier
phases; the columns added to `clinical_knowledge_sources`,
`supplement_products`, `supplement_product_versions`,
`clinical_knowledge_import_batches`, `clinical_knowledge_import_items`,
`differential_questions` and `protocol_items` are nullable additions and can be
dropped individually. The 22 new `clinical_domains` rows are additive and can be
deleted by code.

The one irreversible step is the two `affiliate_url` drops. Both copy their rows
into the commercial model first, so no data is lost, but restoring the columns
would mean reversing that copy — which is the point: the separation is meant to
be structural, and a structure you can casually undo is a convention.

## What the tests actually run

| Suite | Checks | Where |
| --- | --- | --- |
| `desktop_knowledge_catalog.sql` | 36 | governed references, claims, catalog, domains, safety core |
| `desktop_knowledge_import_graph.sql` | 52 | commercial separation, import pipeline, graph integrity |
| `clinical_knowledge_import_review.sql` | 10 | Phase-1 importer — the regression guard for the repaired RPC |
| `desktop_owned_protocols.sql` | 36 | protocol lifecycle, including the rewritten copy-forward path |
| `protocol-copilot.test.ts` | 22 | copilot boundary, including structural checks read from source |
| `live-knowledge-import.spec.ts` | 10 | the pipeline in a browser, against a stub that can refuse |

Three defects in this phase's own work were found by these tests rather than by
inspection, and are worth naming because each was invisible from the code:

1. the batch dedupe index made conflict resolution **impossible** — recording a
   conflict requires storing both rows, and the index forbade the second one;
2. the graph immutability trigger guarded UPDATE but not DELETE, so approved
   knowledge could be erased rather than edited;
3. platform-governed rows escaped uniqueness entirely, because two NULL
   `organization_id` values are never equal in SQL — the rows that most need to
   be unique were the ones the constraint did not police.

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
