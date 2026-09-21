# Qualification parameter examples

Copy-and-fill CloudFormation parameter files for deploying each production candidate with the
qualification execution profile against the isolated `clinical_core_qualification` database
(Desktop `docs/aws-qualification-target.md`, section "Qualification execution"). Generated from the
built templates by `npm run build:aws-qualification-parameters`; `--check` (run in CI) refuses drift, and
`qualification-parameters.test.ts` proves each file names exactly its template's parameters, satisfies
every pattern, and makes the template's `Qualification` condition true only in the synthetic account.

Every value is fictional or a visible placeholder. Before deploying, replace:

| Placeholder | Replace with |
|---|---|
| `REPLACE`-prefixed values, `replace-with-…` names | the real identifiers from the synthetic account (Cognito issuer and app client ids, authorizer id, S3 object version, secret suffix, table names) |
| `0123456789abcdef…` (64 hex) | the SHA-256 of the reviewed evidence the parameter names (qualification policy, database review, MFA review, storage, provider, capture, cleanup, export, cross-store); each is a separate review |
| `QualificationIdentitySubjects` | the consumer and workforce Cognito subjects of the fictional fixture identities from the reviewed synthetic acceptance manifest, and nothing else |
| `SourceCommit` | the exact commit of the artifact being deployed |
| `55555555-…` release ids, `11111111-…` organization id | the reviewed release rows and the fixture organization in the qualification database |
| KMS key, bucket, topic and cluster ARNs | the qualification resources (account `588966314750`, region `us-east-2`); the cluster ARN already names the synthetic cluster |

Fixed values that must not change: `PhiAllowed=false`, `Activation=blocked`, `ActivationEvidenceSha256`
empty, `QualificationExecution=enabled`, `QualificationAccountId=588966314750`,
`DatabaseName=clinical_core_qualification`. A stack whose `QualificationExecution` output reads
`disabled` has a failing boundary and serves no one; a file deployed into any other account enables
nothing. The privacy-operations example turns on export cleanup only (the export and retention
harnesses need it); enable the other sub-activations and the retention schedule with their own
reviewed evidence when those flows are under test. The lab example requires a signed reviewed
lab-range release (`LabRangeMode=reviewed_release`), as production does.

Deploy each candidate with, for example:

```
aws cloudformation deploy --stack-name ai-clinical-core-qualification-<candidate> \
  --template-file dist/aws-clinical-core/<candidate>/template.json \
  --parameter-overrides file://infra/aws-clinical-core/qualification-parameters/<candidate>.filled.json \
  --capabilities CAPABILITY_IAM --region us-east-2 --profile ai-synthetic-staging
```

Keep filled files out of the repository (`*.filled.json` is ignored); they carry account-specific
identifiers, never secrets. Nothing here is production activation evidence.
