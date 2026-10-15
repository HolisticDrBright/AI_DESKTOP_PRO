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
Read-only member-role checks on October 15 found the Lambda concurrent-execution
quota at 150, with 132 unreserved. The earlier account-capacity constraint is
not the reason this particular candidate remains blocked; the runtime/schema
mismatch below is. No reserved concurrency or stack setting was changed.

**Observed blocker, October 14 Pacific / October 15 UTC:** read-only Data API
queries of `clinical_core_qualification` returned 112 migration receipts, latest
`20261010100000`, but neither `20260929120000` nor the synthetic parent table
`clinical_core.synthetic_desktop_program_versions`. The target has production-style
`program_versions`, `program_enrollments`, and related tables, but no
`clinical_core.program_assignments`. It has neither
`clinical_core.program_assignment_request(jsonb)` nor
`clinical_core.production_program_assignment_request(jsonb)`.
The table/function check was repeated with the short-lived
`ai-synthetic-member` assumed-role profile (account `588966314750`), not relied
on solely from the older root-resolving profile; it returned only
`program_enrollments` and `program_versions` among those queried.

This is **a runtime-family mismatch, not merely one missing table**. The projected
Lambda calls `createProgramAssignments`, which requires a synthetic-staging
context and calls `program_assignment_request(jsonb)`. The separate BLOCKED
production candidate defines `production_program_assignment_request(jsonb)`;
its adapter requires a production-clinical, production-bound context and reviewed
activation. Installing that candidate alone would not make these two projected
routes work in this fictional target. Do not deploy this API candidate or graft
the old synthetic migration onto the populated qualification database. First
design and review a preserving qualification program boundary, prove its
rollback and isolation, then build an exact-source candidate for that boundary.
This observation approves no SQL registration, activation, provider or PHI use.

Before a change set, the operator must:

1. Confirm the live account, API, pools, foundation outputs, route vacancy and
   retained log-group names still match the pinned target. A mismatch requires
   a reviewed successor, not a parameter workaround.
2. Bind a built `aws-identity-lambda` artifact to one exact source commit and
   verify its S3 version/checksum and the template hash. The `SourceCommit`
   parameter is an audit label, not proof of bundle contents by itself.
3. Resolve the runtime-family mismatch above. Confirm the actual Lambda adapter,
   function signature, schema lineage and consent/connection dependencies match
   the same reviewed qualification contract. The currently generated candidate
   is a blocked design input, not a deployable release. Do not apply a migration
   merely to make its old adapter pass.
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
