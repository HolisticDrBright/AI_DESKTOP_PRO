# Initial qualification deployment preflight and recovery

September 28, 2026. Source engineering and read-only AWS inspection; not hosted functional acceptance or PHI approval.

## Fresh evidence

The personal-storage candidate stack is `ROLLBACK_COMPLETE`. Its Lambda function is absent. The retained `/aws/lambda/6zt8e9qz04-personal-storage` log group exists, encrypted with the reviewed logs key and 30-day retention; its reported stored bytes are zero. Zero stored bytes is not authorization to delete it. AWS account settings and Service Quotas both report concurrency 10. The qualification SNS subscription is still pending confirmation.

The support API refused case inspection with `SubscriptionRequiredException`. This does not establish the case's current status. Read case `179061879900755` through the signed-in Support Center; do not purchase support just to query it.

The documented AWS unreserved floor is 100 when assigning reserved concurrency: <https://docs.aws.amazon.com/lambda/latest/api/API_PutFunctionConcurrency.html>. This reduced-quota account's actual failed create reported a 10-unit minimum instead. Both preflights deliberately use the conservative documented floor, not a claim that the observed error required 100. The personal-storage function reserves 4, so this initial-create preflight requires at least 104 currently unreserved executions. The complete intended fleet reserves 35 according to the existing deployment plan; verify the aggregate against all exact templates before deployment. A request for 35 *total* is not equivalent to capacity for 35 *reserved*. Never remove per-function bounds to work around this.

## Read-only initial-create preflight

Run `npm run preflight:qualification-create -- --template <exact-template.json> --parameters <filled-parameters.json> --sha256 <digest-from-reviewed-upload-receipt> --stack ai-clinical-core-qualification-personal-storage --profile ai-synthetic-staging`.

The command verifies the supplied template digest, synthetic qualification parameters and stack-name boundary before accessing AWS. It then independently reads STS identity, existing stack, live concurrency, fixed-name functions and retained log groups. Unknown, denied or malformed observations refuse. It performs no writes and outputs no credentials, clinical payloads or raw CLI errors. Exit 0 means only these **initial-create preconditions** passed; exit 2 means observed blockers; exit 1 means an input or observation refusal. It does not replace the reviewed target manifest, release reviews, full CloudFormation validation, deployment or acceptance gates. Existing stacks always block this initial-create tool: it is deliberately not an update/import evaluator. Conditional resources are counted conservatively, and unsupported expressions refuse rather than guessing.

The live run against the uploaded `a300c633ac81909842503ad37e77170ad63ed605` personal-storage template (SHA-256 `12879eb348c1e825869cd8eb26236c37a4748ff4d8a41bf53e84c0c3c2766ed2`) returned three blockers: existing rolled-back stack, insufficient capacity, retained log group. No deployment was attempted. The old local deployment operator remains held; this new tool does not override it.

## Recovery sequence, not yet executed

### Read-only preparation tool (September 28)

`node scripts/prepare-qualification-log-recovery.mjs --out dist/log-recovery-proposal.json`
observes the fixed synthetic profile/account, qualification foundation, exact failed personal-storage
stack, stack resource inventory, retained-log template policies, actual log properties, absent
function and enabled KMS key. Any other surviving resource, unexpected inventory, changed stack
state, wrong database, PHI/activation boundary, missing retain policy or changed encryption/retention
refuses. The planner deliberately supports this exact failed stack only, not arbitrary stack recovery.

It writes one exclusive-create local proposal containing the import-only template, resource identifier
and metadata hashes. It performs **no AWS writes**: no stack deletion, import, changeset or deployment.
Its `executionAuthorized` and `activationEvidence` fields remain false. Nonzero stored bytes are
preserved just as zero bytes are; neither grants deletion authority. Observations are non-atomic,
and no log events are read or absence of log content certified. Re-observe before any reviewed change.

The intended future sequence is a separately reviewed retirement of the failed stack record with
the log retained, identity verification of that same log, import-only changeset review/execution,
then drift verification and a normal candidate-update review after capacity and target-manifest
requirements pass. This tool does not implement or authorize that mutation sequence, and the
initial-create preflight must not be bypassed for the subsequent update/import path.

AWS lists `AWS::Logs::LogGroup` as supporting resource import in its
[resource support table](https://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/resource-import-supported-resources.html).
Follow the separate [import review procedure](https://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/resource-import-existing-stack.html);
resource-type support alone does not establish that this proposal is safe or has been executed.

Verification: 23 standalone tests cover nonempty-log preservation, wrong account/stack/DB,
PHI settings, duplicate metadata, unexpected or still-live resources, wrong retention/key, disabled
key, lost retain policies, read-only call inventory and CLI mutation-flag refusal. A live read-only
run generated proposal hash `8680a90052c705a3a45559a64542680a5ec893a1a63431094c84232f4a0db991`.
The encrypted log remains in the failed stack inventory as `DELETE_SKIPPED`; no recovery is claimed.
AWS `validate-template` accepted that proposed import-only template, and `get-template-summary`
returned `LogGroupName` as the import identifier for its sole `Logs` resource. These are read-only
template checks, not an import changeset or execution. The 14 initial-create preflight tests and
targeted script lint also passed; the new standalone test is wired into CI.

1. Check Support Center and verify the granted live regional quota. Reconcile aggregate concurrency from every exact candidate, including existing reservations.
2. Inventory all resources of the rolled-back stack again. Review a recovery plan that preserves the retained encrypted logs. Do not blindly delete/recreate the stack or log group. Prefer a reviewed CloudFormation import/preservation path; validate import support and changeset before execution.
3. Prepare a new deployment operator incorporating this preflight (or an equally strict update/import check after reviewed recovery), exact-version artifacts and the full target-manifest verifier. The stale local `-Deploy` operator must remain refused until replaced.
4. Run the reviewed change, verify actual Lambda code hashes and PHI-off/blocked configuration, then perform the mandatory hosted matrix. Resource creation alone is not a functional pass.

## Remaining six-phase acceptance

The original phase definitions are unchanged. Identity/continuity, reliable processing, privacy/access, clinical release integration, commerce/providers and release qualification are not declared complete by this repair. The outstanding work remains hosted candidate deployment/acceptance, exact matching app releases, physical devices, provider/store acceptance, meaningful source/clinical release review and the owner's separate security/retention/provider approvals. The consumer intended-use changes on the newer V2 branch must be reconciled with the requested product before launch. No clinical holds, PHI flags, concurrency limits, provider authority or mobile build authorization changed.
