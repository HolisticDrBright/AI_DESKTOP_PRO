# Desktop operation inventory evidence

The operation inventory checks source coverage and activation restrictions. It
does not count unfinished provider work or establish provider acceptance.

## Confirmed reporting defect

The previous gate printed that 140 operations required provider-specific
rewrites. That count was computed exclusively from `legacyDefinitions` and
their historical Supabase dependency flags, such as `auth.uid()`, Storage,
Realtime, Vault and network extensions. It did not inspect the current AWS
ports for unfinished rewrites or provider qualification.

For example, `activate_my_memberships` carries a historical `authUid` flag while
the inventory separately identifies its native production function. The old
flag alone cannot establish that a rewrite remains unfinished. Conversely, an
operation without an old flag is not thereby provider-qualified.

## Corrected gate

The gate now reports 140 operations with **legacy provider dependency flags**
and explicitly states that current provider completion is unverified by the
source gate. All inventory checks, source hashes, operation counts and
activation restrictions remain unchanged: 228 source-covered operations,
activation blocked, zero enabled. No historical migration or manifest is
rewritten. Earlier receipts retain their original observed output.

A provider backlog or completion claim requires a current per-provider
implementation review and positive/negative acceptance against the selected
target. Source coverage, dependency flags, registration and actual delivery are
different evidence. This correction supplies none of those external approvals.

## Regression evidence

The actual gate is executed by
`src/server/clinical-core/desktop-operation-inventory-reporting.test.ts`.
Against the unchanged predecessor, two reporting assertions fail and the
activation restriction assertion passes. After the correction, all three pass.
The tests derive the historical count from the real committed inventory rather
than substituting a fictional readiness result.

Local focused verification is not whole-source CI, hosted or device acceptance.
Record those results separately at the exact published commit. PHI remains
disabled, providers remain unverified, and all original readiness scopes keep
their outstanding application, deployment, device and human requirements.
