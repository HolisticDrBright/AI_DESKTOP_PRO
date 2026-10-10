# Fullscript qualification deployment execution

The new execution state machine and native filesystem custody implement one reviewed synthetic stack creation, an exact change-set check, one execution, and read-only recovery. They are source components, not an executable AWS deployment command. The native AWS prerequisite observer and command adapter are still required. No AWS resource has changed through this increment.

## Separate owner authorization

`prepareFullscriptDeployment` first runs the existing actual artifact preflight. A separate canonical `fullscript-qualification-deployment-review/1` document must bind the exact clean source, ZIP, template, target and all explicit parameters. It names Brandon Bright, an approval time, the new stack name, a unique run ID, and independent resource, SQL-privilege and credential review hashes. Its scope is one fictional stack creation; it prohibits PHI, production activation and provider actions. It is an operator attestation, not a cryptographic signature. The software does not create a review or establish that its hashes represent real reviews.

New writes require a review no more than 24 hours old. Read-only reconciliation can use an older exact review so that expiration cannot strand an unknown execution without observation.

## Execution and interruption

Before creating a proposal, the state machine requires an absent stack, function and proposal and no existing draft routes. It refuses updates, replacement resources, imports, nested stacks and additional resources. The proposal must match the submitted template, every explicit parameter, the exact resource/type list and the review tag. The guard must independently reread local custody and observe the actual AWS principal and prerequisites before writes.

Custody uses the existing shared `operator.lock` namespace rather than a per-checkout lock. A complete immutable header precedes hard-link publication. The journal is synced and read back before `create_admitted` or `execute_admitted` permits dispatch. An unknown response or an observation timeout leaves that admission outstanding. There is no rollback, deletion or automatic write retry.

If proposal creation was admitted but execution was not, `execute-prepared` can inspect the same ready proposal and admit one execution. It cannot create another proposal. After execution admission, only `observe` is allowed. Native recovery requires the same host, a dead original writer, at least 60 seconds since its recorded identity, the identical archived operator and review, and a separate exclusive recovery guard. A recovered executor records its own process identity before admission; a later observer must prove that writer is stopped too. Changed or torn custody refuses rather than recovering from a guessed prefix. This is process-interruption custody, not a disk power-loss guarantee.

A positive readback verifies the complete stack resource list, numeric published code version, code digest, exact environment, both JWT issuer/audience bindings and both route integrations. It may retire an admitted execution's custody, but its report leaves IAM, alarms, SQL and hosted qualification false. Code/routes observation is not a provider acceptance run or authorization to enable PHI.

## Native adapter still required

The command must pin the synthetic assumed-role principal, account 588966314750 and Ohio. Its guard must read the actual immutable code/target objects, secret metadata and pinned version, token-table schema/encryption, pool/client policies and current designated identities, the same restricted SQL worker's complete 111-migration ledger, and the reviewed IAM/KMS resources. It must observe route absence immediately before proposal creation and before execution, then inspect deployed IAM, version permissions, alarms and concurrency. A saved report or an environment flag cannot satisfy these checks.

Create and execute requests must use the recorded names and client tokens, one attempt, bounded deadlines and opaque error output. The AWS adapter must read every proposal/resource/route page or refuse incompleteness. It must not automatically restart after a timeout. Stored artifacts and the native command need clean committed builds before actual use. No owner review, secret, upload or deployment is manufactured by these source tests.

The execution suite uses fictional control-plane transports; the custody suite uses temporary local files. The composition test delegates to the real artifact preflight. Local evidence does not prove live CloudFormation behavior. First-run timeout-fixture and journal-type failures remain recorded as failures, not retrospective passes.

An interrupted recovery guard is intentionally not expired or automatically deleted. A separate guarded reconciliation for that subsidiary lock remains engineering before this can be a complete native operator. An observation timeout is not permission to start another observer with new custody or another writer.

The final local Fullscript module run passed 571 tests in 17 files with no skips, in 123.38 seconds starting at 22:45:42 PDT on October 9. It includes the two additional route-race and plan-mutation regressions. The earlier focused run passed 90 tests before those two were added. Typecheck and targeted lint passed before the final two additions; the final checks are recorded separately in the handoff. Dependencies are reused (Vitest 4.1.11 rather than the lockfile's 4.1.5), so this is not a clean-install or hosted acceptance result.

## Remaining launch scope

Fullscript cart runtime is still not installed. Actual schema upgrade, reviewed target/credentials/IAM, deployment and provider acceptance remain open, along with privacy/holds/provider copies and OAuth settlement. Telehealth chart/lifecycle/multi-clinic/released V2 consent, commerce, matched releases, physical devices, recovery/security and real human approvals remain part of the original six phases. PHI remains off; holds, source verification, exclusions, adult-only Core and the prohibition on paid mobile builds are unchanged.
