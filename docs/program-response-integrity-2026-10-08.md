# Cross-app program response integrity — October 8, 2026

Source-only repair. PHI and production activation remain disabled. This does not
complete the same-target catalog integration or hosted program acceptance.

## Findings and repair

The response schema previously accepted duplicate phase/item identities, unsafe
purchase URLs, incomplete or contradictory reviews, unavailable inventory releasing
supplements, impossible progress, and mutation receipts naming the wrong step or
state. Twenty-four of 25 new negative/valid cases failed before the repair in both
Desktop and V2; all 25 passed after the mirrored contract changes.

The contract now requires an exhaustive, disjoint review of actual step identities,
preserves every unreleased or unknown-inventory supplement hold, binds receipts to
the request, and checks response identity/progress relationships. Published legacy
rows may legitimately have a null published timestamp: the real SQL suite caught
an overly restrictive proposed check, which was removed rather than changing the
fixture or accepting weaker database evidence.

V2 also had a real presentation bug: the card recomputed decisions against an empty
local product list despite the screen claiming that the server review was authoritative.
It now renders the bound server review, with structural defense-in-depth validation.
An uncertain mutation drops stale controls and requests an explicit refresh. A confirmed
receipt survives a subsequent unavailable read, but is cleared on authorization loss.

## Evidence and limits

- Desktop: 25 new contract cases plus 22 real program-assignment SQL cases and 12
  existing UI/contract tests passed (59); 19 actual Chromium cart/assignment tests passed.
- V2: mounted real screen/card tests reproduced five failures before repair (one
  existing session-clear case passed). Nine screen cases now pass, including held,
  duplicate and conflicting server verdicts, lost replies, confirmed updates followed
  by read failure, access loss, late background replies and offered-program review.
- The V2 focused run passes 79 tests across four files. No physical-device or hosted
  acceptance is claimed. Full-suite, build and hosted CI results must be recorded
  separately after they finish.

## Still required

`program_plan_inventory` still deliberately returns `inventoryComplete=false` in
the target. Do not turn it true merely because a source catalog exists. Integrate
reviewed, same-target product identity/ingredient/dose/offer data and the authoritative
current consumer plan; preserve consent, source verification, labels and exclusions.
Then qualify real assignment, duplicate, conflict, hold, progress and two-device
journeys. Until then all supplement steps remain held in that target.

Frozen AWS run sources are separate from these branches. Do not merge or rebuild
those sources while the registered standalone recovery operation has custody.
