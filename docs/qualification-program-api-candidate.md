# Isolated qualification program API candidate — source only

The shared staging API has both program-assignment routes. The isolated
qualification API `6zt8e9qz04` does not. Deploying the full staging identity
stack there would duplicate routes already owned by other qualification stacks
and reuse its fixed staging log group. This candidate projects only the two
program routes and their private Lambda, role, authorizers, log group, alarm and
exact-route invoke permissions from the current identity template.

`infra/aws-clinical-core/qualification-program-api-candidate.json` is generated
by `npm run build:aws-qualification-program-api`; CI runs
`npm run test:aws-qualification-program-api` and CloudFormation lint. The
candidate pins the isolated API, fictional consumer/workforce pools, the
`clinical_core_qualification` database, synthetic account and region, code
bucket, log key and qualification alarm topic. Its environment says
`PHI_ALLOWED=false`. The original staging template is unchanged.
The log-group name uses `/aws/lambda/6zt8e9qz04-*`, the path admitted by the
qualification foundation's observed KMS key policy; an earlier proposed
`/ai-clinical-core/qualification/*` path was refused before deployment.
The alarm name is likewise pinned to the foundation's
`ai-clinical-core-qualification-*` KMS source-ARN allowance.

This is **not deployed or approved**. The template alone cannot attest the
Lambda bundle's source commit, the database's exact migration ledger, the
consent copies or the users behind the JWTs.

**Observed blocker, October 14 Pacific / October 15 UTC:** a read-only Data API
query of `clinical_core_qualification` returned 112 migration receipts, latest
`20261010100000`, but no `20260929120000` synthetic program parent and no
`clinical_core.program_assignments` table. The two routes cannot pass hosted
program acceptance on this target. A production program-assignment candidate
exists separately and is still BLOCKED; this observation does not approve its
registration or application. Resolve the schema lineage with a reviewed,
preserving qualification upgrade and rollback proof before deploying this API.

Before a change set, the operator must:

1. Confirm the live account, API, pools, foundation outputs, route vacancy and
   retained log-group names still match the pinned target. A mismatch requires
   a reviewed successor, not a parameter workaround.
2. Bind a built `aws-identity-lambda` artifact to one exact source commit and
   verify its S3 version/checksum and the template hash. The `SourceCommit`
   parameter is an audit label, not proof of bundle contents by itself.
3. Confirm the qualification database contains the exact program schema and
   required consent/connection dependencies, using the approved migration
   operator and read-only ledger inspection. Do not apply a migration just to
   make this candidate pass.
4. Review the CloudFormation change set for only the candidate's resources,
   with no replacement of the foundation or existing route-owning stacks, and
   preserve `PhiAllowed=false` and all production activation holds.
5. Run fictional JWT denial and owner/clinic-isolation cases, program assign,
   accept, replay, withdrawal, second-device convergence and catalog-held
   supplement cases. A skipped case, unavailable catalog or mismatched source
   is a refusal, not hosted acceptance.

This candidate does not add checkout, education or media routes, does not
activate production programs, and does not establish real-patient or device
readiness. The acceptance kit remains withheld until the exact-source hosted
and physical journeys are observed separately.
