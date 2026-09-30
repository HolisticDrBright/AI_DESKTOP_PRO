# Compiling a purchasable cart from a published protocol

**Date:** 2026-09-30 · **Boundary:** synthetic only · **PHI:** disabled · **Status:** implemented and locally verified; nothing deployed, nothing delivered.

## Why

Practice Better publishes a protocol and hands the patient a pre-filled dispensary cart. That is
genuinely the step that gets a protocol taken rather than read — and what it does is copy whatever
the protocol names into a basket.

This compiles instead of copying. Three differences carry the weight.

**A cart is compiled from the published version's own stored content.** A request may name a
version; it cannot describe one. There is nowhere in the contract to put lines, products or prices,
and a test sends `lines: [...]` alongside a valid version id and is refused. The version's content
digest is recorded on the manifest, so a cart can always be shown to be the cart that protocol
produced.

**The exclusions are applied at compile time, in SQL.** A supplement carrying iron never reaches a
cart, because iron dosing depends on a ferritin the cart cannot see. A supplement whose ingredients
touch pregnancy, nursing or fertility never reaches one for the same reason. Neither is a UI
warning that a busy afternoon can click past: the line is excluded before a manifest exists, and no
screen, caller or later delivery step can skip it. A test walks `ferrous`, `ferric`, `heme` and
`ferritin` and each is caught.

**An excluded line stays in the manifest, with its reason.** A product that silently disappears
between the protocol and the cart is worse than one visibly withheld — the practitioner sees "one
to buy, three for you to decide, and here is why" and decides about those three individually,
which is exactly the decision that should not be automated.

## Migration 43 — `20260930180000_synthetic_protocol_cart_compilation.sql`
`sha256 5afa197c2ec1c973e19ffe5b3cfc85924787785ae20bfbb5f237d1b0dd6cf62b`

`protocol_cart_manifests`, with `clinical_private.cart_exclusion_reason(jsonb)`,
`clinical_private.protocol_cart_lines(jsonb)` and
`clinical_core.protocol_cart_workforce(jsonb)` (compile / read / list).

- **Only a published version compiles.** A draft or an approved-but-unpublished version has
  approved nothing for anyone to buy, and a protocol naming no supplements is refused rather than
  compiled to an empty cart.
- **One manifest per version, and a retry returns it.** `replayed: true` rather than a second cart
  for the same protocol.
- **A compiled manifest is immutable.** Superseding is the only permitted update, because an order
  placed from version 2 has to stay explainable after version 3 exists. Tests assert that rewriting
  the lines, bumping a count, and deleting the row are all refused.
- **Lines are read through `program_consumer_content`**, the same function that compiles an
  assignment — so a version that approved nothing for patients compiles to nothing here either.

Like a note template, a manifest is derived from the practice's own protocol and names no patient:
deliberately absent from `care_data_export` and untouched by a patient erasure. There is nothing
about a patient in it to export or erase.

## There is no delivery step, and the answer says so
`read` returns `delivery: {state: 'not_implemented', detail: 'no_cart_is_created_at_any_provider'}`.
No cart is created at Fullscript or anywhere else, no destination is contacted, and nobody is
charged. The manifest is what a delivery step would later read. The screen states this in words
too, and a render test asserts the screen never says "sent to", "added to your dispensary" or
"order placed".

## Surfaces
- **Contract:** `contracts/protocolCarts.ts` — a compile request carries only a version id.
- **Service, transport, route:** `server/clinical-core/protocol-carts.ts`, `protocolCartCall`,
  `POST /api/live/protocol-carts`.
- **Screen:** `ProtocolCartView` (pure, rendered in tests) and `ProtocolCartPanel`, mounted in
  `AppProgramAssignmentsPanel` beside the revision announcer — both are things you do with a
  published version.
- **Infrastructure:** one new authenticated route — **52 total, 51 authenticated and still exactly
  one declared public.**

## Ledger
Synthetic `clinical_core`: **43** migrations, composite
`dc679d4d9353d3047b345a3ec375ccbd3a8678b1ac2ce932f468f71e191f4675`.
Migration 33 applied and untouched. **34–43 unapplied.** Production family unchanged at 103,
`8a9a8f321fafc1f4e2c20b44825845cc64bb291c1746b1cdacfe7f23bfa3c9c2`.

## Local verification
- Desktop: 3,710 passed / 11 skipped (303 files); typecheck clean; lint clean, zero warnings; gates
  pass — clinical-core, the 52-route authenticated-API check, operation inventory (226 operations, 0
  enabled), production clinical-core (103, release hash unchanged), clinical-bundle, mock-imports.
- New tests: `protocol-cart.database.test.ts` (12, real migration SQL under PGlite),
  `ProtocolCartView.render.test.ts` (6, rendered), five new marker rows in
  `rds-data-database.test.ts`.

## Not done, and not claimed
- **Nothing is delivered.** There is no ordering step at all — not a disabled one, not a
  configured-off one. Building the list is not ordering, and the manifest is the only artifact.
- **The exclusion rules read the protocol's own ingredient keys, not a governed catalog.** In this
  family there is no catalog to resolve a product id into its full ingredient list, which is the
  same limitation `program_plan_inventory` already states honestly. A product whose iron content is
  not in its declared keys would not be caught here. The release gate
  (`clinical-safety-regression`) checks the catalog side; these two rules will need reconciling
  when a catalog exists in the same target.
- **No pricing, no stock, no substitution.** A line is a product id, a dose and a destination.
- **No patient-specific exclusion.** The cart is compiled per protocol version, not per patient, so
  it cannot exclude something a particular person already takes or reacts to. The overlap check
  that would do that is the plan inventory, and it is separately incomplete for the same
  missing-catalog reason.
