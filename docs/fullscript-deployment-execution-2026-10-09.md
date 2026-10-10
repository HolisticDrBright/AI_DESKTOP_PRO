# Fullscript qualification deployment execution

The execution state machine and native filesystem custody implement one reviewed synthetic stack creation, an exact change-set check, one execution, and guarded recovery. Resource prerequisite validation and fixed read-only RDS Data API inspection are now implemented. These are source components, not an executable AWS deployment command: the bounded native transport and command adapter remain required. No AWS resource has changed through this increment.

## Separate owner authorization

`prepareFullscriptDeployment` first runs the existing actual artifact preflight. A separate canonical `fullscript-qualification-deployment-review/1` document must bind the exact clean source, ZIP, template, target and all explicit parameters. It names Brandon Bright, an approval time, the new stack name, a unique run ID, and independent resource, SQL-privilege and credential review hashes. Its scope is one fictional stack creation; it prohibits PHI, production activation and provider actions. It is an operator attestation, not a cryptographic signature. The software does not create a review or establish that its hashes represent real reviews.

New writes require a review no more than 24 hours old. Read-only reconciliation can use an older exact review so that expiration cannot strand an unknown execution without observation.

## Execution and interruption

Before creating a proposal, the state machine requires an absent stack, function and proposal and no existing draft routes. It refuses updates, replacement resources, imports, nested stacks and additional resources. The proposal must match the submitted template, every explicit parameter, the exact resource/type list and the review tag. The guard must independently reread local custody and observe the actual AWS principal and prerequisites before writes.

Custody uses the existing shared `operator.lock` namespace rather than a per-checkout lock. Version 2 publishes complete, synced immutable numbered writer records and separately chained admission files by exclusive hard links. A file is read back before `create_admitted` or `execute_admitted` permits dispatch. Partial unpublished archives are inert; published corrupt records refuse. An unknown response or an observation timeout leaves its admission outstanding. There is no CloudFormation rollback, deletion or automatic write retry.

If proposal creation was admitted but execution was not, `execute-prepared` can inspect the same ready proposal and admit one execution. It cannot create another proposal. After execution admission, only `observe` is allowed. Recovery requires the same host, proof that the last numbered writer stopped, at least 60 seconds since its recorded identity, and the identical archived operator and review. It claims the next immutable writer slot rather than expiring or deleting a subsidiary recovery lock. A crashed observer can therefore be recovered by the same rule; a live observer cannot be displaced. Every previous writer refuses once a successor exists. A maximum of 64 generations bounds inspection.

Explicit `resume-unadmitted` recovery is allowed only when no creation admission was published and the last writer has stopped. It still rechecks absence of the stack, proposal, function and routes. A creation admission with a lost response cannot use this mode. Version 1 records and old subsidiary recovery locks refuse without deletion or automatic migration; no deployment used that earlier source format. This is process-interruption custody, not a disk power-loss guarantee.

A positive readback verifies the complete stack resource list, numeric published code version, code digest, exact environment, both JWT issuer/audience bindings and both route integrations. It may retire an admitted execution's custody, but its report leaves IAM, alarms, SQL and hosted qualification false. Code/routes observation is not a provider acceptance run or authorization to enable PHI.

## Prerequisite observations

`observeFullscriptDeploymentResources` binds actual API and cluster metadata, encrypted storage, secret metadata and pinned version, token-table schema, Cognito pool/client policies, distinct designated people, the alarm topic and bounded immutable artifact bytes. It checks the principal before and after inspection. It never retrieves the Fullscript secret value, performs a provider action or treats the topic's existence as alarm delivery.

`createFullscriptDeploymentDatabaseObserver` sends only fixed RDS Data API statements through the same reviewed secret intended for the worker. It begins a read-only transaction, sets a five-second SQL timeout, inspects the login before selecting `fullscript_draft_worker`, and requires a confirmed rollback. It has no COMMIT, DDL, DML, administrative fallback or retry. Missing or denied rollback refuses rather than producing a receipt. PostgreSQL role membership and administrator flags, schema CREATE privileges and effective table/public/column grants are inspected. The worker needs exactly SELECT, INSERT and UPDATE on `fullscript_delivery.draft_intents`; the login may have only that subset, and neither may CREATE in a persistent schema. The complete ledger must equal the reviewed target.

The validator's observation receipt reports prerequisite evidence only. The RDS command transport and resource observations are injected in local tests; actual AWS wiring, time bounds and target behavior must be qualified before use. [AWS rollback semantics](https://docs.aws.amazon.com/rdsdataservice/latest/APIReference/API_RollbackTransaction.html) and [PostgreSQL privilege functions](https://www.postgresql.org/docs/current/functions-info.html) define the observations these adapters must return.

## Native adapter still required

The command must pin the synthetic assumed-role principal, account 588966314750 and Ohio. Its guard must read the actual immutable code/target objects, secret metadata and pinned version, token-table schema/encryption, pool/client policies and current designated identities, the same restricted SQL worker's complete 111-migration ledger, and the reviewed IAM/KMS resources. It must observe route absence immediately before proposal creation and before execution, then inspect deployed IAM, version permissions, alarms and concurrency. A saved report or an environment flag cannot satisfy these checks.

Create and execute requests must use the recorded names and client tokens, one attempt, bounded deadlines and opaque error output. The AWS adapter must read every proposal/resource/route page or refuse incompleteness. It must not automatically restart after a timeout. Stored artifacts and the native command need clean committed builds before actual use. No owner review, secret, upload or deployment is manufactured by these source tests.

The execution suite uses fictional control-plane transports; the custody suite uses temporary local files. The composition test delegates to the real artifact preflight. Local evidence does not prove live CloudFormation behavior. First-run timeout-fixture and journal-type failures remain recorded as failures, not retrospective passes.

An observation timeout is not permission to start another observer with unbound custody or repeat an admitted writer. The numbered recovery implementation closes the earlier subsidiary-lock design gap in source; it does not establish live CloudFormation settlement.

The expanded execution gate passed 181 tests in five files with no skips, in 4.20 seconds starting at 23:20:02 PDT on October 9. Final typecheck, targeted lint and diff checks passed. It includes interrupted observer recovery, live-writer refusal, unadmitted resume, SQL/public-column grants, rollback failures, schema CREATE grants, current identities, immutable object bytes and resource drift. The actual SQL test uses miniature PGlite databases; the resource and RDS transports are fictional. Initial typing failures and a PGlite session-reset fixture failure were repaired before this final run. Neither test scope proves Aurora, CloudFormation or provider behavior.

Historical local evidence before these additions: 571 tests in 17 files with no skips, in 123.38 seconds starting at 22:45:42 PDT on October 9, including the route-race and plan-mutation regressions. Dependencies are reused (Vitest 4.1.11 rather than the lockfile's 4.1.5), so these runs are not clean-install or hosted acceptance results.

## Remaining launch scope

Fullscript cart runtime is still not installed. Actual schema upgrade, reviewed target/credentials/IAM, deployment and provider acceptance remain open, along with privacy/holds/provider copies and OAuth settlement. Telehealth chart/lifecycle/multi-clinic/released V2 consent, commerce, matched releases, physical devices, recovery/security and real human approvals remain part of the original six phases. PHI remains off; holds, source verification, exclusions, adult-only Core and the prohibition on paid mobile builds are unchanged.
