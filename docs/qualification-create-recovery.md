# Initial qualification deployment preflight and recovery

September 28, 2026. Source engineering and read-only AWS inspection; not hosted functional acceptance or PHI approval.

## Fresh evidence

The personal-storage candidate stack is `ROLLBACK_COMPLETE`. Its Lambda function is absent. The retained `/aws/lambda/6zt8e9qz04-personal-storage` log group exists, encrypted with the reviewed logs key and 30-day retention; its reported stored bytes are zero. Zero stored bytes is not authorization to delete it. AWS account settings and Service Quotas both report concurrency 10. The qualification SNS subscription is still pending confirmation.

The support API refused case inspection with `SubscriptionRequiredException`. This does not establish the case's current status. Read case `179061879900755` through the signed-in Support Center; do not purchase support just to query it.

AWS requires 100 executions to remain unreserved when assigning reserved concurrency: <https://docs.aws.amazon.com/lambda/latest/api/API_PutFunctionConcurrency.html>. The personal-storage function reserves 4, so a fresh create needs at least 104 currently unreserved executions. The complete intended fleet reserves 35 according to the existing deployment plan; verify the aggregate against all exact templates before deployment. A request for 35 *total* is not equivalent to capacity for 35 *reserved*. Never remove per-function bounds to work around this.

## Read-only initial-create preflight

Run `npm run preflight:qualification-create -- --template <exact-template.json> --parameters <filled-parameters.json> --sha256 <digest-from-reviewed-upload-receipt> --stack ai-clinical-core-qualification-personal-storage --profile ai-synthetic-staging`.

The command verifies the supplied template digest, synthetic qualification parameters and stack-name boundary before accessing AWS. It then independently reads STS identity, existing stack, live concurrency, fixed-name functions and retained log groups. Unknown, denied or malformed observations refuse. It performs no writes and outputs no credentials, clinical payloads or raw CLI errors. Exit 0 means only these **initial-create preconditions** passed; exit 2 means observed blockers; exit 1 means an input or observation refusal. It does not replace the reviewed target manifest, release reviews, full CloudFormation validation, deployment or acceptance gates. Existing stacks always block this initial-create tool: it is deliberately not an update/import evaluator. Conditional resources are counted conservatively, and unsupported expressions refuse rather than guessing.

The live run against the uploaded `a300c633ac81909842503ad37e77170ad63ed605` personal-storage template (SHA-256 `12879eb348c1e825869cd8eb26236c37a4748ff4d8a41bf53e84c0c3c2766ed2`) returned three blockers: existing rolled-back stack, insufficient capacity, retained log group. No deployment was attempted. The old local deployment operator remains held; this new tool does not override it.

## Recovery sequence, not yet executed

1. Check Support Center and verify the granted live regional quota. Reconcile aggregate concurrency from every exact candidate, including existing reservations.
2. Inventory all resources of the rolled-back stack again. Review a recovery plan that preserves the retained encrypted logs. Do not blindly delete/recreate the stack or log group. Prefer a reviewed CloudFormation import/preservation path; validate import support and changeset before execution.
3. Prepare a new deployment operator incorporating this preflight (or an equally strict update/import check after reviewed recovery), exact-version artifacts and the full target-manifest verifier. The stale local `-Deploy` operator must remain refused until replaced.
4. Run the reviewed change, verify actual Lambda code hashes and PHI-off/blocked configuration, then perform the mandatory hosted matrix. Resource creation alone is not a functional pass.

## Remaining six-phase acceptance

The original phase definitions are unchanged. Identity/continuity, reliable processing, privacy/access, clinical release integration, commerce/providers and release qualification are not declared complete by this repair. The outstanding work remains hosted candidate deployment/acceptance, exact matching app releases, physical devices, provider/store acceptance, meaningful source/clinical release review and the owner's separate security/retention/provider approvals. The consumer intended-use changes on the newer V2 branch must be reconciled with the requested product before launch. No clinical holds, PHI flags, concurrency limits, provider authority or mobile build authorization changed.
