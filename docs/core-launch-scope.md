# Core launch scope — September 19, 2026

The Core release ($19.99/month) claims every consumer feature except the peptide and
longevity programs. Until now that claim lived only in the V2 tier copy, while the three
owned-storage services each read their own `AllowedScopes` deployment parameter and the
app learned about a missing scope only from a `feature_scope_not_enabled` refusal after
it had already asked. This increment gives both repositories one declaration to check
against and one server answer to conform to.

## Declaration

`infra/aws-clinical-core/core-launch-scope.json` (contract `core-launch-scope/1`) lists:

- the nine personal-storage scopes the Core tier requires, in sorted order;
- the exact active `AllowedScopes` value for the owned lab (`ai_context,lab_history`) and
  owned voice (`ai_context,voice_transcription`) templates;
- ten Core features and the scopes each needs, including which service enforces them;
- the two add-on programs, both `available: false`;
- the clinic-sharing pilot scope, which stays `lab_intake_only` and is unrelated to
  personal storage.

The file is copied verbatim into V2 at `expo/contracts/core-launch-scope.json`. Its SHA-256
is pinned in `scripts/check-aws-core-launch-scope.mjs` here and in V2
`expo/contracts/coreLaunchScope.ts` (`CORE_LAUNCH_SCOPE_SHA256`); any change must land in both repositories.

**Ownership, stated (October 11, 2026).** This file is the one source of the declaration. V2's copy is a
mirror, produced by `expo/scripts/sync-core-launch-scope.mjs <this file>` (LF-normalised, never edited by hand)
and gated in V2 CI by `expo/scripts/check-core-launch-scope.mjs`, which fails on any byte drift from the pinned
digest and tolerates only CRLF checkouts. The procedure for a change is: edit here, run this repository's
`check:aws-core-launch-scope`, sync the mirror, update the pin in both repositories in the same change set, and
have the reviewed evidence receipts stay as they are (a receipt is never rewritten to match new bytes). The
current pinned digest is unchanged by the mirror gate, which is the proof that the gate itself unlocked nothing.

The declaration activates nothing. PHI, activation state and the actual `AllowedScopes`
of a deployment remain reviewed CloudFormation parameters. A narrower first deployment
(for example lab history and AI context only) is permitted; the app follows the posture
below rather than the declaration.

## Gate

`npm run check:aws-core-launch-scope` (also in CI) refuses drift: the Core scopes must
equal `OWNED_STORAGE_SCOPES` exactly, so a new server scope forces a launch decision;
every collection in the consumer API's collection→scope map must be a Core scope; each
Core scope must be required by at least one feature; the lab and voice feature scopes and
template `AllowedValues` must match the server's own `LAB_AUTHORIZATION_SCOPES` and voice
feature check; the personal-storage candidate pattern must accept exactly the Core scopes;
the legacy disabled template must keep an empty allow-list; both programs must stay
unavailable; and the posture route below must exist in the API and the templates.

## Personal posture route

`GET /clinical-core/consumer/personal/posture` (verified consumer identity, purpose
`consent_management`, no query) returns

```json
{"data":{"contractVersion":"personal-posture/1","launchTier":"core","enabledScopes":["ai_context","lab_history"]}}
```

`enabledScopes` is the deployment's sorted allow-list. It is not consent state, it reads
no stored data, and a blocked deployment still answers `503 production_not_activated`
like every other personal route. V2 reads it once per account/environment and disables
new authorization for scopes the deployment does not enable, while withdrawal of an
existing consent stays available.

## Not done

No hosted deployment carries the route yet; the built templates and Lambda bundle are
source artifacts. Lab and voice services keep their own allow-lists and still answer
`feature_scope_not_enabled` when disabled; the app pre-check for those two features is a
V2 follow-up. PHI remains disabled.
