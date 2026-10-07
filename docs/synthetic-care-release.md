# Synthetic care release preparation

This release binds the request-ID erasure API to the matching V2 source, the
existing synthetic database and its preserved historical alias. It prepares
artifacts only. It does not deploy, authorize deletion, qualify a mobile binary
or activate real patient data. All six commercial-readiness phases remain partial.

## Build and inspect

Both checkouts must have committed, clean runtime sources. Graphify output is
not a runtime input. Commands below run from the Desktop checkout. Replace only
the V2 filesystem path, not the fixed AWS target.

```powershell
npm run test:synthetic-care-release
npm run build:synthetic-care-release -- --v2-root C:/path/to/V2
npm run build:aws-care-erasure-upgrade
node scripts/prepare-synthetic-care-release.mjs --v2-root C:/path/to/V2 --candidate dist/synthetic-care-release/DESKTOP_HEAD/V2_HEAD --prepare-fictional-only
```

The deterministic candidate ZIP contains exactly `index.js` and `release.json`.
The manifest binds both source commits and file inventories, matching care-data
contracts, the device journal and transport, synthetic native build profiles,
the source template and exact core/catalog migration histories. Preparation
rebuilds the actual current API and byte-compares it before any AWS request.
An artifact hash alone is not source provenance.

The inspection operator must also be built from the same clean Desktop commit.
Preparation observes member STS identity, the completed staging foundation,
stack parameters/template, active Lambda code/configuration, JWT authorizers,
all identity-integration routes and the operator's read-only database inventory.
It refuses root, other accounts/databases, source or history drift, unknown
routes, missing/doubled authorities and the wrong deployed code.

Account is `588966314750`, region `us-east-2`, API `wxv734oi12`, database
`clinical_core`. This is not `clinical_core_qualification` or production.
There are 51 deployed identity routes. Source defines 55; the four absent
routes stay absent. The candidate fixes only the obsolete route-count output
and changes only the code-key parameter; IAM and authorization stay unchanged.

## Verified code-artifact upload

With both source commits clean, build the candidate and same-source inspection
operator above. The uploader itself reruns preparation against live AWS before
any write; a saved plan or fabricated checksum cannot substitute for that check.

```powershell
npm run upload:synthetic-care-release -- --v2-root C:/path/to/V2 --candidate dist/synthetic-care-release/DESKTOP_HEAD/V2_HEAD --upload-fictional-code-only
```

Only the fixed synthetic code bucket/key is writable. Region, owner, enabled
versioning and the exact KMS key are verified. A conditional create-only put
cannot overwrite an existing key. A 412 is reusable only after exact-version
HEAD and a bounded actual download agree on source metadata, encryption, byte
length and SHA-256. A 409, timeout, access denial, wrong object or unknown result
is not success and never triggers a blind retry or deletion. The recorded S3
version ID must be pinned as `Code.S3ObjectVersion` in the subsequent reviewed
Lambda-only change set; deploying a mutable latest key is not sufficient. Upload alone is
not deployment, recovery rehearsal or hosted application acceptance.

AWS semantics: [conditional PutObject](https://docs.aws.amazon.com/AmazonS3/latest/API/API_PutObject.html)
and [version-specific GetObject](https://docs.aws.amazon.com/AmazonS3/latest/API/API_GetObject.html).

## Deployment and recovery still required

1. Independently verify the ZIP after uploading it under its exact source/hash
   key. Reobserve the live target and review a Lambda-only change set. A saved
   preparation is a dated observation, not an execution permit.
2. Deploy the request-ID-aware handler before the database upgrade. Prove old
   ID-less erasure is refused and unaffected authorized routes still work.
   Receipt requests remain unavailable until the matching SQL exists; they must
   never be translated into an uncorrelated erase.
3. Rehearse recovery using explicitly source-verified, schema-compatible code.
   After live ledger 47, the old API ZIP must not be restored: its SQL authority
   is revoked. No down migration or disposal of receipts is permitted. A
   source-compatible re-forward is not proof of a rehearsed rollback.
4. Perform the preserving upgrade only after the matched deployment/recovery
   path is ready. Rehearse and independently inspect every original row and
   both ledgers. The earlier successful rollback-only schema rehearsal is not
   API or erasure journey acceptance.
5. Build matched native candidates only after paid-build authorization.
   Physically verify iOS/Android restart, ambiguous delivery, exact receipt,
   settlement, second-device convergence, owner isolation and retained clinic
   records. Historical ID-less requests and missing device journals still need
   reconciliation; the new journal does not prove they failed.

Reviewed security/retention/provider configuration, real agreement coverage,
Core $19.99 store/provider acceptance and separate PHI activation remain gates.
Clinical holds/exclusions/source verification and the mobile-build hold remain.
