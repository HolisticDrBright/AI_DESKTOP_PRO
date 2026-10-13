# Care messaging: fictional 112-ledger qualification build

This is a source-only build option for the isolated `clinical_core_qualification`
database in synthetic AWS account `588966314750` (`us-east-2`). It does not
deploy a stack, register a route, seed a review, create consent, activate PHI,
or approve a production release. Real patient data remains prohibited.

The historical default build remains `npm run build:aws-care-messaging` and
pins 106 migrations with release
`514959bf0d32de55ded312509ae2ebe39a0fdde9f59246b096b0c41ba63f4f9b`.
To build the distinct fictional successor from a **clean** checkout:

```powershell
node scripts/build-aws-care-messaging.mjs --release=112
cfn-lint dist/aws-clinical-core/care-messaging-qualification-112/template.json
```

The successor reads the exact preserving 112 candidate from
`build-telehealth-consent-copy-candidate.mjs`, requires contract
`telehealth-consent-copy-candidate/1`, 112 migrations and release
`45aec4369ec94bf6339a17e47eadba7b81e7b5195fd5be46c2903e587b709fb4`.
Its manifest marks `qualificationOnly: true` and hashes the compiled code,
template and deterministic ZIP. The template admits only `PhiAllowed=false`
and `Activation=blocked`; the runtime independently refuses active or PHI-on
settings before creating a database client. The default 106 build and its
separate production-review conditions are not silently relabelled as 112.

Artifact tests prove the two modes' distinct release pins and template
allowed values. Runtime tests prove the exact 112 fictional binding succeeds
against an injected database and a wrong release or production-like settings
are refused before client construction. These are source tests, not hosted
evidence. The runtime verifies seven messaging function bodies, four RLS
tables and six trigger bindings on each admitted transaction. It does **not**
verify the complete migration ledger; the deployment/target operator must
inspect that separately.

Before any AWS deployment, rebuild on the final committed head, check
`sourceClean: true`, remote-match the source commit, bind the uploaded code
version to the ZIP digest, and use an operator and target manifest that
explicitly support this 112 candidate. Existing 106/107 target assumptions
must refuse rather than be bypassed. The account's observed Lambda capacity
report is not authorization or evidence that the new stack is installed.
Independent security, MFA, retention, messaging, alarm and identity reviews
must be authentic; test placeholders in unit tests are never review evidence.

The read-only inspector now requires an **explicit** successor choice:

```powershell
node scripts/inspect-care-messaging-qualification.mjs --release=112
```

It rebuilds the 112 artifact from the clean checkout, compares all 112
database migration rows in a repeatable-read, read-only transaction that is
rolled back, and checks the exact template, uploaded ZIP version, stack,
authorizers, IAM, alarms and routes if a candidate stack exists. An optional
`--artifact-dir=<directory>` must match the rebuilt bytes, and
`--binding=<reviewed-file>` is required to inspect an existing stack. The
historical no-argument mode remains pinned to 106. The separately added
[care-connections 112 candidate](care-connections-112-qualification-candidate-2026-10-13.md)
now has its own explicit `--release=112` build and inspection path with
matching connection/recovery bindings and production refusals. `not_deployed` or an inspection
refusal is not hosted acceptance, and syntactically valid review hashes are
not evidence of independent reviews.

Hosted positive and negative care-messaging, receipt/settlement, export,
consent-withdrawal and cross-owner/clinic tests remain unexecuted for this
candidate. No physical-device or production/PHI readiness claim follows from
this build. Keep paid mobile builds on hold until separately authorized.
