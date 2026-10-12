# Synthetic qualification fleet observation — 2026-10-12

This is a read-only, metadata-only AWS observation. It is not a deployment, hosted
acceptance report, review approval, PHI authorization, or commercial release.

## Observed target and capacity

- At approximately 19:09 UTC, STS for profile `ai-synthetic-member` identified
  account `588966314750` and an assumed `OrganizationAccountAccessRole` session.
  The separate `ai-synthetic-staging` profile identified the same account as root;
  the capacity preflight deliberately used the assumed-role profile.
- The qualification foundation `ai-clinical-core-qualification-foundation` in
  `us-east-2` is `CREATE_COMPLETE`. Its outputs name database
  `clinical_core_qualification`, API `6zt8e9qz04`, `PhiAllowed=false`,
  `Activation=blocked`, `QualificationExecution=disabled`, and
  `QualificationInfrastructure=prepared_no_candidates`. The foundation's
  disabled execution posture is intentional; it is not a served candidate.
- An independent RDS Data API read, after Aurora resumed from auto-pause,
  returned `current_database()=clinical_core_qualification`, 112 rows in
  `clinical_core.schema_migrations`, and latest version `20261010100000`.
  This count/latest-version read does **not** reverify the 112 release hash or
  data-preservation evidence; see the approved execution record for those.
- `node scripts/check-aws-qualification-capacity.mjs --api-id 6zt8e9qz04
  --profile ai-synthetic-member` exited 0 with `ready=true`: total concurrent
  execution limit 150, unreserved 136, desired reserved 39, incremental reserved
  29, and required unreserved floor 100. It conservatively does not credit
  generated function names. This is a capacity preflight, not a deployment
  guarantee or hosted positive acceptance.

## Deployed candidate inventory

CloudFormation reports these completed qualification stacks. All listed
serving candidates output `PhiAllowed=false`, `Activation=blocked`, and
`QualificationExecution=enabled`; the recording-storage stack is a storage
resource and does not report serving activation. Their `SourceCommit` outputs
are not one matched release:

| Stack suffix | SourceCommit | Status |
| --- | --- | --- |
| personal-storage | `52cbda3fe5b7882210265a5a8fa5d817a066f9e4` | `UPDATE_COMPLETE` |
| privacy-operations | `8f84a9f4af5fe4d777288b08ecbac54fb848a74b` | `CREATE_COMPLETE` |
| owned-voice | `8028f3c8b3311202054c6f685f2a39040f99d250` | `UPDATE_COMPLETE` |
| recording-authority | `bdf346522af3b500e2e0f64ec29931331065e3e0` | `CREATE_COMPLETE` |
| recording-cleanup-review | `950f6ed9f905690f5ee167ab7a09cdb9e1968e20` | `CREATE_COMPLETE` |
| recording-storage | `5e63597ec1855a93fb2bdae0226b6f77230a5d92` | `CREATE_COMPLETE` |

The intended fleet is incomplete: this observation found no qualification
owned-lab, recording-capture, cleanup-execution, transcription, drafting,
care-messaging, or care-connections stack. The capacity script includes the
planned reserved executions for these candidates, but it does not assert their
configuration or existence. No same-source hosted acceptance can be claimed
from the existing mixed-source fleet.

## Next controlled step

Before a new stack update or creation, choose an exact reviewed source commit
and migration release supported by that candidate; build immutable artifacts
from a clean checkout; inspect every candidate's full parameters, dependencies,
review evidence, designated fictional identities, IAM and API route bindings;
and rebind a filled qualification target manifest. A shape-valid hash is not a
human review. Keep `PhiAllowed=false`, production `Activation=blocked`, and
qualification restricted to the approved fictional subjects and database.
Run candidate-specific preflight and rollback checks before each write, then
hosted positive and negative acceptance against the exact resulting stack.
Do not deploy the current mixed fleet as if it were one release, apply an
unapproved successor migration, or use production/patient data to make a test
pass. Paid mobile builds remain held.
