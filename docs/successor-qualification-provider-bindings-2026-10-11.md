# Successor consent and clinic record request bindings

These two source candidates extend the proposed 117-migration qualification
runtime with telehealth consent and clinic-record privacy routes. They preserve
the original 112 and 116 entry points, which still refuse successor metadata.
They do not complete the Fullscript or Zoom request fleet, observe AWS, apply
schema, grant access, activate providers, or permit PHI.

## Exact source and database authority

Both candidates use the separate `clinical-successor-qualification/1` profile
and exact release descriptor from `scripts/successor-qualification-release.mjs`.
The complete release is 117 migrations, ledger
`34037e1ff05d583868c9a3796f673937777f88bcf4cebc2d589c6604626e9364`,
assembly `d73f67f2197886cf24360f773018a72c92d666789891e679e151ae2c65bd796a`.
No historical migration, installer, registered assembly or custody record is
changed. The 117 SQL candidate remains blocked and not deployed.

The consent service additionally pins the unchanged exact-copy SQL to
`5d4b361c4849b900c4c6e4f95686cf77c28797584bc9e9ec1136f38bdc325e0e`.
The clinic service pins the unchanged privacy SQL to
`c326461d26c0b2c4e93083f84e4b75cced0c72d6457be16634e2df9a5852714f`.
Both derive function-body pins from the full validated source artifact. Every
transaction still checks the restricted API role, exact function bodies and
the original table, trigger and copy protections before business SQL.

Successor admission requires clean compiled source, exact source input and
release/assembly digests, synthetic account 588966314750 in us-east-2, the
isolated `clinical_core_qualification` database, and a separate
`alp/qualification/runtime-api-` credential namespace. The operator/master and
Fullscript worker namespaces are refused. A namespace alone proves neither
effective credentials nor grants; the complete target observer and independent
credential review remain required.

Every original identity, current ownership, consent, disclosure, retention and
MFA review remains independent. Fictional test review-shaped values are not
human approvals. Consent grants remain independently disabled by default;
disabling grants does not remove current-state reads or withdrawal.

## Configuration identity and immutable deployment artifacts

The consent configuration contract is additive
`telehealth-consent-configuration/2`. It includes every original configuration
field plus `SUCCESSOR_QUALIFICATION_PROFILE` and `MIGRATION_ASSEMBLY_SHA256`.
Historical `/1` bytes and its tool are unchanged; a historical digest cannot
authorize the successor handler. Configuration identity is a digest of
identifiers and gates, not evidence that a reviewer approved them.

The credential-free `configuration-identity.cjs` tool reads a bounded JSON
object from standard input and prints only its digest. It refuses wrong
contracts, extra or secret fields, wrong target/profile/release/assembly and
oversized input without echoing input values.

`build:successor-qualification-providers` emits two candidate directories with
their real bundled handlers, deterministic ZIPs, copied templates and byte-bound
manifests. Both templates reference immutable published Lambda versions whose
code digest is computed from the new ZIP. Historical routes, JWT authorizers,
review rules and exact-resource IAM are preserved. The consent template's
copied artifact condition is explicitly bound to 117 rather than retaining a
literal 112 digest that would refuse every positive successor deployment.

Each compiled entry uses the existing drift-fenced successor envelope before
lazy loading the actual new factory, after loading and on cached calls. Only
the reserved per-invocation trace field is excluded; all authority/configuration
fields remain bound. PHI can only be false, activation can only be blocked,
qualification is disabled by default and dirty source cannot enable it.

## Verification and limitations

The failing-before embedded test exercised the unchanged historical handlers
against the complete proposed 117 SQL and reproduced three positive-journey
503 failures. The new factories support exact-copy review/grant/withdrawal,
owner overview and practitioner queue under `clinical_core_api`, with
cross-owner and cross-clinic refusals. Administrative-role execution is refused.
The test's initial withdrawal assertion was corrected to the actual existing
top-level response contract; no runtime response contract was changed.

Use normal whole-suite verification as well as these scoped commands:

```text
npm run test:successor-provider-binding
npm run test:successor-qualification-providers
npm run build:successor-qualification-providers
npm run typecheck
npm run lint
npm run test:unit
npm run build:clinical
npm run check:clinical-bundle
```

Lint both generated templates with the CI-pinned CloudFormation linter.
Record terminal results and exact-source CI after committing; do not transfer
the parent commit's whole-suite evidence to this increment. Embedded SQL is not
managed database evidence. Package refusal and template-logic tests are not
positive hosted or physical-device acceptance. Conditional template fixtures
test a clean-source declaration independently so a dirty local build cannot
mask missing-review negatives.

The manifest deliberately reports only the two-candidate declared scope as
complete. `completeFleetQualified`, `targetBindingComplete`, `deploymentPerformed`,
`hostedVerified` and PHI remain false. This build is not a release activation.

### October 11 source verification before publication

Final typecheck and lint passed, followed by 26 successor embedded-SQL tests
and the unchanged 106-migration, zero-seed production gate. That command then
stopped at a mistyped compatibility script name. The existing
`check:aws-desktop-compatibility-contract` was run separately and passed with
223 RPCs and five read models. Data-plane, Core launch and stub-reset gates
passed, followed by seven actual package tests, the persistent artifact builder
and lint of both generated templates. The data-plane scan had no V2 reference
checkout, so it supplies Desktop evidence only.

These results apply to the pre-publication working source. Earlier typecheck
errors in a new test helper were corrected by an explicit return type; no
production behavior or safety assertion was removed. The AST-only update
completed with 17,967 nodes, 41,329 edges and 1,104 communities. Clean committed
artifact checks, the normal whole suite and exact-head CI must be observed
separately. A parent commit's results do not verify these additions.

## Ordered remaining AWS inputs

1. Finish the separate Fullscript and telehealth-request successor artifacts
   and the complete resource/code/ledger/identity observer. Combine these two
   candidates with the twelve existing requests only under one exact matched
   source and release; do not extend historical fleet targets by ledger prefix.
2. Obtain current approvals for the exact preserving schema executable and
   restricted credentials/grants/KMS/IAM/rotation. Earlier approvals do not
   cover a changed executable or a later 117 release. The last inspected managed
   ledger remains 107, not the embedded 117 rehearsal.
3. Build from clean frozen source and record both manifests, code ZIP hashes,
   source-input hash, configuration identity and immutable published versions.
   Actual review hashes, designated subjects, API, cluster, secret and database
   must come from the reviewed target, not local fixtures.
4. Bind `POST /clinical-core/consumer/telehealth-consent` and both consumer and
   workforce `clinic-records` routes to the matched target. Keep qualification
   disabled until all prerequisites pass, production blocked and PHI false.
   Supply the additive consent configuration identity and leave consent grants
   disabled until its separate release/review is approved.
5. Run real hosted positives and negatives: exact-copy grant/withdrawal,
   supersession, wrong owner/clinic/pool, stale sign-in, replaced connections,
   retired copy, missing disclosure release, correction/copy lifecycle,
   role/privilege/body drift, cached environment changes and cleanup. Retain
   refusals/skips as incomplete positive cases. Run real concurrent races rather
   than calling the serial embedded tests concurrency proof.
6. Qualify matched V2/Desktop/API releases, physical iOS/Android journeys and
   provider/store tests. Human policy, agreements, security, retention and PHI
   activation approvals remain separate. No paid mobile builds are authorized.

All six original commercial-readiness scopes remain incomplete. The launch
scope stays adult-only Core at $19.99, with held peptide/longevity add-ons,
clinical holds/exclusions and source-verification requirements preserved.
