# Catalog read integrity and remaining program integration

The catalog reader and review service had reproducible read-authority defects.
This source repair preserves product holds, clinical source verification and
separate commercial approval. It does not activate PHI, deploy a candidate,
complete program supplement adoption or qualify a mobile release.

## Reproduced defects and repair

Nine of the first thirteen real PostgreSQL cases failed before repair. Old
approved offers remained visible after the current product became restricted,
practitioner-gated, non-orderable or an oral peptide. Rejecting an active product
or offer wrote a review event but left the registry approved and selectable.
Privileged reader transports could also return another environment's records.

The reader now binds products, labels, templates, steps and offers to the requested
environment explicitly. Offers also require the current approved, unrestricted,
open, directly orderable supplement version. This matches the existing commercial
activation scope; it does not approve peptides or create a destination. Template
steps are explicitly joined to the active template version, including when the
transport is privileged rather than subject to API-role row-level security.

Rejecting or requesting changes to the active version now clears its active read
pointer and updates the status. Rejecting a different, unapproved successor leaves
the prior approved version intact. Immutable content and append-only review events
are preserved. Three additional negative cases reproduced an approval service
that accepted reapproval of destinations for currently ineligible products. That
approval now refuses before writing an event.

Eligible, separately approved source destinations and tracking metadata remain
unchanged. This repair adds no label requirement to the existing synthetic
catalog-owner commercial approval path. Product and dose appropriateness remain
separate from permission to display a purchase destination.

## Database guard and release mapping

`infra/aws-clinical-core/source-candidates/catalog-offer-current-product.sql`
contains the corresponding API-role RLS guard. Its LF-normalized SHA-256 is
`3d63f4a04b8168818844736ea5143115ca1e01fc9b2c96f0da6d5889938a6117`.
The local database suite explicitly applies it to a disposable database. It is
not registered in the reference migration ledger and has not run against AWS.

The registered reference ledger remains the original two migrations, SHA-256
`83d51dc056b41f47b5fb3d6020201163915faa2116004e3692af9bb41aad0f62`.
Canonical source 47, live 48 and the active standalone routing run remain pinned
to that history. Do not insert this candidate into the ledger to make an old
artifact pass. A forward catalog upgrade needs an exact predecessor/target
descriptor, preserving inspector/apply operator, migration receipt and rebuilt
matched application release. Keep the current routing custody undisturbed.

The API query repair works on the unchanged two-migration schema. A compatibility
test also proves that historical *raw* RLS reads still expose an obsolete offer;
API repair is not a claim that the database guard is deployed.

## Verification

The dedicated suite passes eighteen cases using the real importer, review service,
reader SQL, catalog migrations and API role against PGlite. It covers inert imports,
separate destination approval, restriction transitions, active withdrawal, preserved
approved predecessors, forbidden API-role writes, missing environment, explicit
environment filtering, current template steps and the unchanged registered schema.
These are local SQL results, not Aurora, concurrent, provider or device acceptance.

The full local suite completed with 346 files, 4,378 passed tests and eleven
existing skips in 513.48 seconds, one worker and unchanged deadlines. Typecheck,
focused lint, both catalog boundary checks and the catalog API build passed.
The unit environment used `TZ=America/Los_Angeles` and no
`CLINICAL_SUPABASE_ANON_KEY`, as required by the existing edition fixture.

The initial nine failures and subsequent three failed reapproval cases remain in
the recorded tool output. Hosted CI is still separate evidence.

The production-dependency audit returned one moderate Next.js finding at the
installed and locked version 15.5.25, not a clean security report. The maintainer
identifies 15.5.27 as the patched 15.x version for the self-hosted cache advisories.
Update and verify dependencies in a separate checkout with its own installation;
the current checkout shares dependencies with other worktrees and the active AWS
run pins frozen source. [Maintainer advisory](https://github.com/vercel/next.js/security/advisories/GHSA-4jqv-mc3x-m676),
[related advisory](https://github.com/vercel/next.js/security/advisories/GHSA-mcj8-r9mp-w47p).

## Corrected target evidence and remaining work

Read-only AWS metadata and count queries on October 8 returned zero updated rows.
In `588966314750/us-east-2`, database `clinical_core`, they proved:

- `clinical_reference.catalog_products`, `catalog_product_versions`,
  `product_labels` and the reference migration ledger exist in this target.
- The synthetic catalog contains 847 products with approved active pointers.
- It has 98 label records, of which 21 have approved active pointers.
- The reference migration ledger has two entries.
- `consumer_clinical_record_versions` exists, but
  `owned_consumer_active_plans` and `owned_consumer_record_versions` do not.

This supersedes the earlier blanket statement that the governed catalog exists
only in the production migration family. There are distinct catalog and clinical
migration families with different schemas; do not merge their SQL blindly.
Catalog row counts do not verify label completeness, ingredient equivalence,
source eligibility, a clinical decision or provider delivery.

`program_plan_inventory` still returns an incomplete inventory and derives its
revision from the latest received protocol copy, not an authoritative owner
adoption. Complete an explicit owner-adopted plan lineage in the actual execution
target, tied to exact immutable record/hash/consent revisions and predecessor CAS.
Resolve both existing plan products and program candidates through current,
reviewed, same-target ingredient identities. Missing, held, disputed, excluded or
unverified evidence must remain a hold, never an empty current plan or an inferred
ingredient match. Bind review revisions to that authoritative inventory, and
qualify duplicate/conflict/review-staleness and two-device journeys before clearing
any supplement hold. The existing SQL bytes are historical evidence, not files
to rewrite when their comments no longer describe the target.

All six original scopes remain open. Positive AWS erasure and recovery journeys,
scheduled retention and provider cleanup, exact matched releases, commerce and
provider acceptance, security/recovery evidence and physical iOS/Android acceptance
remain required. PHI stays OFF and paid mobile builds stay HELD.
