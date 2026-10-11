# Successor qualification runtime and release binding

This source proposal aligns twelve existing request candidates with the exact
117-migration telehealth transfer-authority candidate. It advances the original
clinical-integration and matched-release scopes; it does not complete the full
application fleet, apply a migration, activate a provider or permit PHI.

## Exact release identity

The distinct profile is `clinical-successor-qualification/1`. The descriptor
accepts exactly 117 ordered migration rows, names and SQL digests, the unchanged
116 parent and the exact final extension. A prefix, matching count, extra file,
changed name, altered SQL or claimed approval is refused.

- Ledger SHA-256: `34037e1ff05d583868c9a3796f673937777f88bcf4cebc2d589c6604626e9364`.
- Assembly SHA-256: `d73f67f2197886cf24360f773018a72c92d666789891e679e151ae2c65bd796a`.
- Candidate: `telehealth-transfer-authority-candidate/4`.
- Source status: no deployment, runtime admission, managed-role qualification,
  seeded approval, consent, admission key or transfer.

Historical 106 installers and 107 ledger/profile/factory pins remain exact and
refuse the successor. The embedded rehearsal installs the actual 106 parent
through its unchanged installer, then runs the validated forward SQL in a fresh
local transaction and compares the entire 117 ledger. This is not a managed
preserving-upgrade operator or execution approval.

## Request artifacts

`build:successor-qualification-runtime` builds personal-storage,
privacy-operations, owned-lab, owned-voice, six recording candidates,
care-messaging and care-connections. The declared set has 12 candidates,
15 entry points and 13 deterministic deployment ZIPs. Every manifest binds the
source commit, source-input digest, complete release, template and code bytes.

Ten ordinary candidates use a separately compiled envelope around their actual
parent handlers. Care candidates use distinct 117 factories and function-body
pins extracted from the exact release, not wrappers around the count-pinned
106/107 factories. Original review, drain, consent, identity and IAM conditions
are retained. Qualification stays disabled by default; PHI and activation cannot
be enabled by these templates.

Admission requires clean compiled source, the pinned release and assembly,
synthetic account 588966314750 in us-east-2, the qualification database,
designated fictional identities and independent existing review inputs. API
secrets must use the separate `alp/qualification/runtime-api-` namespace; the
operator/master secret and Fullscript worker authority are refused. A namespace
match alone does not prove a secret's contents, effective grants or isolation.

Environment drift is checked before and after lazy import and on cached calls.
Only `_X_AMZN_TRACE_ID` is excluded because AWS changes that reserved trace field
per invocation. All other keys, including newly introduced review or provider
fields, remain bound. The same narrowly tested trace repair applies to the
historical 107 envelope without changing its release or activation pins. See
[AWS environment variables](https://docs.aws.amazon.com/lambda/latest/dg/configuration-envvars.html).

## Read only ledger observation

`successorQualificationLedgerReader` requires an explicit operator secret;
there is no fallback from request credentials. It captures the target before
any asynchronous work, selects the actual database and entire ordered ledger
under a read-only repeatable-read transaction, uses bounded statements and
requires confirmed rollback. Failed reads, changed rows, incomplete ledgers or
unconfirmed rollback refuse. It never commits, retries, reads clinical records
or changes schema, grants or release rows.

The reader's positive result means only the exact ledger was observed and the
transaction rolled back. Fleet, effective role, hosted acceptance and PHI flags
remain false. The default AWS transport has not been run for this successor.

## Verification

Use the normal suite as well as these scoped checks:

```text
npm run test:successor-qualification-binding
npm run test:successor-qualification-runtime
npm run build:successor-qualification-runtime
npm run typecheck
npm run lint
npm run test:unit
```

Binding tests include actual SQL under `clinical_core_api`, zero-seed checks,
care messaging, cross-owner refusal, consent withdrawal, connection status and
independently gated claim recovery. Review-shaped fixture values are local test
data, not human approvals or deployable evidence. Package tests execute every
actual compiled entry point in disabled mode and inspect ZIP CRCs, byte hashes,
templates and original conditions. A disabled refusal is not positive hosted
acceptance. CI also lints all twelve generated CloudFormation templates.

Failed-before evidence includes the historical installer correctly refusing the
whole successor, caller mutation relabeling a successful ledger observation,
and four API/worker cases refusing ordinary per-invocation trace changes. The
installer was preserved; target capture and the narrow trace repair address the
two source defects. Full-run and exact-head CI results must be recorded from
their terminal observations, not borrowed from the parent source.

## Remaining work in the original scopes

1. Implement a separate complete successor target and observer binding actual
   resources, code versions, database/operator/request/worker identities and
   exact release bytes. Do not extend a historical target by count or prefix.
2. Integrate the additional Fullscript, telehealth, consent and clinic-route
   artifacts and their independent provider/storage/authority requirements.
3. Complete the restricted credential, grant, cross-database, KMS/IAM and
   rotation design review. Provisioning and schema writes require their own
   current approvals; earlier approvals do not cover a changed executable.
4. Qualify reviewed preserving schema transitions, deploy exact matched source
   and run all real hosted positives, negatives, races and cleanup journeys.
5. Combine V2 application repairs, build matched releases when authorized, run
   physical iOS/Android acceptance and complete commerce/provider test journeys.
6. Resolve human policy, security, retention and provider-agreement coverage
   before separate production and PHI activation review.

The build manifest deliberately reports `completeFleetQualified: false`,
`targetBindingComplete: false`, `hostedVerified: false`, `phiAllowed: false` and
`activation: blocked`. All six original readiness scopes remain incomplete.
Core remains $19.99 only, with held add-ons, adult-only initial scope, preserved
clinical holds and source-verification requirements, and no paid mobile build.
