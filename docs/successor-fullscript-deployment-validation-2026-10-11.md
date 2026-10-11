# Successor Fullscript deployment validation

October 11, 2026. This separate source increment adds offline deployment
validation for the exact 117 Fullscript request candidate. It does not deploy,
upload, acquire or settle execution custody, provision credentials, review a
target, activate a provider or approve PHI.

## Exact artifacts and parameters

The new preflight admits only `successor-fullscript-api-build/1` and
`fullscript-qualification-target-release/4`. The historical preflight and
native deployment operator retain their original contracts unchanged.

The preflight binds the source commit and actual source-input digest, clean
state, exact release and ordered migration body identities, handler/runtime,
index bytes, complete deterministic ZIP envelope, code digest and byte size.
It independently regenerates the successor template and historical reference
from the manifest and compares their digests and exact template bytes.

Every template parameter must be explicit, unique, known and valid. The
source/profile/assembly, designated subjects, function/API, organization,
identity pools/audiences, database worker secret, provider metadata and target
digest must match the immutable release. Null code or target object versions
are refused. No previous parameter value or hidden default is accepted.

The target review is an attestation contained in the reviewed artifact. Passing
this consistency check neither supplies a separate write review nor verifies
its authenticity, storage, identities, database role or current resources.
Resource, credential, effective privilege, provider and deployment reviews
remain independent.

## Source bound command

Build `npm run build:successor-fullscript-preflight` only from clean source.
Its output is
`dist/aws-clinical-core/successor-fullscript-preflight/index.cjs`.
Run it from the exact source checkout:

```text
node <absolute command path> --inspect-fictional-successor-fullscript-only <manifest> <zip> <template> <target> <parameters>
```

The five file paths must be absolute. Reads are bounded and refuse symlinks,
non-files, short/extra bytes and changed file metadata. Canonical target and
parameter JSON and pretty manifest/template bytes must match their original
encoding; duplicate keys cannot disappear into parsing.

The command compares its compiled source binding with current source
observations before reading inputs and after verification. This is explicitly
a before-and-after observation, not an atomic snapshot or independent API
rebuild. It has no AWS or provider transport and cannot admit a cloud write.
The pure preflight reports `sourceObserved=false`; only the actual command
sets that field after both source observations. `sourceRebuilt`, `awsObserved`,
`approvedForDeployment`, `deployed`, `hostedQualified`,
`providerActionPerformed` and `completeFleetQualified` remain false.

## Verification

The source suite passes 43 cases with the actual proposed 117 migration
descriptor and clearly fictional code, target identities and review fields.
It covers the positive offline contract, preserved historical refusal, changed
source/parameters, duplicate/unknown/missing fields, changed ledger/review,
template drift and ZIP integrity. These fixtures are not real approvals or
positive hosted provider journeys. Typecheck and targeted lint passed.

Final clean command packaging, exact-source whole-suite and CI results are
recorded in the root checkpoint. Earlier results for the parent runtime do not
verify this successor increment.

```text
npm run test:successor-fullscript-preflight
npm run typecheck
npm run lint
npm run test:successor-fullscript-preflight-build
npm run build:successor-fullscript-preflight
```

## Remaining execution work

A separate native deployment plan, independently rebuilt artifact observation,
resource/database/credential checks, durable writer admission, exact prepared
change-set validation, installed controls, cancellation/unknown-result recovery
and custody settlement still need the new contract. The historical native
operator must not receive a relabeled manifest or target.

Only after that source is verified and the actual target and independent
reviews are approved may its fictional deployment be considered. Last inspected
managed schema is 107; the proposed 117 release and changed schema executor
remain separate reviews, not approval supplied by this preflight.

Complete fleet qualification, actual provider/commerce acceptance, matched
releases, physical iOS/Android journeys and the original six commercial scopes
remain incomplete. PHI and production activation stay off, clinical holds and
source verification remain, and paid mobile builds remain held.
