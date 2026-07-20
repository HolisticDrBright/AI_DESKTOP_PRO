# Supplement product reconciliation report

Status: **authoritative list NOT FOUND — every product is `pending_verification`**
Registry: `expo/registry/registry-content.v1.json` (`supp.v1`)
Also vendored in: `AI_DESKTOP_PRO/registry/registry-content.v1.json` (byte-identical, sha256-pinned in both repos)

## Search performed

The product owner's authoritative supplement list was searched for and **not
found** in any of:

- Both repositories' working trees (docs, mocks, constants, prompts, fixtures)
- Full git history of both repositories (`git log -S` for each product name,
  e.g. `Adrenal Restore`, `GlucoPrime`, `Gut Shield`, across all commits)
- Repository documentation and previous prompt/instruction files
- Session materials and attachments available to this task

Per instruction, **no resolutions were invented**. All 15 products found in
code were captured into the registry exactly as they appeared, marked
`pending_verification`, and the approval gate (database trigger +
`create_protocol_draft` / `approve_protocol_draft` RPCs + registry helpers)
refuses to let ANY of them into an **approved** protocol until the owner
verifies them. Drafts may reference pending products; approval may not.

## Where the 15 products came from (provenance)

### In the structured catalog AND the AI prompt (8) — `structured-catalog`

Source: `expo/mocks/curatedProducts.ts` (doses/ingredients) and the lab
extraction prompt in `expo/providers/LabsProvider.tsx`.

| Registry id | Name | Brand (claimed) |
|---|---|---|
| prod_proomega_2000 | ProOmega 2000 | Nordic Naturals |
| prod_glucoprime | GlucoPrime | Healthgevity |
| prod_protect_plus_10 | Protect+ 10 | Healthgevity |
| prod_liver_sauce | Liver Sauce | Quicksilver Scientific |
| prod_liposomal_glutathione | Liposomal Glutathione Complex | Quicksilver Scientific |
| prod_glutaryl | Glutaryl Transdermal Glutathione | Auro Wellness |
| prod_mitocore | MitoCore | Orthomolecular |
| prod_nac_900_plus | NAC 900+ | Healthgevity |

### AI-prompt only (7) — `ai-prompt`

These existed ONLY inside the hardcoded prompt text; they had no structured
catalog entry, no ingredients, and no governance before this change.

| Registry id | Name | Brand (claimed) |
|---|---|---|
| prod_gut_shield | Gut Shield | Healthgevity |
| prod_probiota_histaminx | ProBiota HistaminX | Seeking Health |
| prod_sleep_deep | Sleep Deep | Healthgevity |
| prod_magnesium_glycinate_300 | Magnesium Glycinate 300 | Healthgevity |
| prod_methyl_b_complex | Methyl B Complex | Healthgevity |
| prod_d3_k2_5000 | D3+K2 5000 | Healthgevity |
| prod_adrenal_restore | Adrenal Restore | Healthgevity |

### Desktop-only synthetic inventory items

The desktop practitioner-OS mock fixtures (billing/inventory demo data on the
`claude/practitioner-os-ui-overhaul` branch) contain synthetic product names
used for UI demonstrations only. They are **not** clinical candidates, are not
in the registry, and must never be merged into it without owner review.

## Conflicts found between the two in-repo sources

These are the discrepancies that existed BEFORE the registry unified them.
Each needs an owner decision at verification time:

1. **Name variant** — the single-file prompt said "Liposomal Glutathione"
   while the structured catalog says "Liposomal Glutathione Complex"
   (Quicksilver Scientific). The registry keeps the catalog name; the
   name-normalization resolver accepts both spellings.
2. **Missing product in one prompt** — the multi-image (screenshot) prompt
   listed 14 products, omitting Glutaryl Transdermal Glutathione; the
   single-file prompt listed 15. Both prompts are now generated from the
   registry, so they can no longer drift.
3. **Dose text as the only dose information** — no product had structured
   dose bounds; only free-text like "1-2 capsules daily". Registry keeps the
   verbatim text in `doseText` and leaves `doseBounds` null pending owner
   input.
4. **Indication hints lived only in prompt prose** — "for blood sugar,
   insulin resistance…" etc. Captured verbatim as `indications`, pending
   verification like everything else.

## Unverified fields on every product

- Brand attribution (claimed in code, not confirmed by the owner)
- Dose text and (absent) dose bounds
- Ingredients (present for only 5 of 15)
- Cautions / interactions / monitoring (present for 1-2 products, absent
  otherwise — absence does NOT mean "none")
- Vendor/order links: none stored in the registry at all. The legacy
  affiliate-link table remains an app-level, practitioner-owned mapping and is
  applied only to registry-validated names.

## What the owner needs to decide (open questions)

1. Which of the 15 products are actually on the approved dispensary list, and
   under exactly which names/brands/doses?
2. Are the 7 prompt-only products intentional, or leftovers to remove?
3. Should herbs/botanicals get registry coverage? Today NO herb is in the
   registry, so all AI herb suggestions render as advisory text with no
   product identity and no purchase link.
4. Lab order links are all `reviewStatus: 'unreviewed'` — which links, if
   any, are approved for practitioner (never patient) use?
5. Dose bounds, cautions, interactions, and monitoring requirements per
   product.

## How approval is enforced until then

- `approvalState` for all 15 products is `pending_verification`; the value
  `approved` can only be set by a privileged registry update (owner action),
  not by any app or API code path.
- Database: `private.protocol_draft_approval_guard` blocks a protocol draft
  from transitioning to `approved` while ANY item references a product whose
  `approval_state` is not `approved` (SQLSTATE 22023), and blocks
  approved→draft rewrites (new versions supersede instead).
- API: `createProtocolDraft` rejects unknown/invented product ids before any
  write; `clinical.registry.listApprovedSupplements` returns an empty
  approved list today, plus the pending list clearly labeled for drafting.
- Mobile/AI: prompts are generated from the registry; AI supplement output is
  post-validated — anything that does not resolve to a registry product is
  labeled an unverified suggestion, carries no product identity, and can
  never render as purchasable.
