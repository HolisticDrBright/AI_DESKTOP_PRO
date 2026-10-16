# Read-only fictional program API update preflight

The first-deployment preflight correctly refuses the current synthetic API because its two program routes are no longer vacant. This separate update preflight observes the *already deployed* target in account `588966314750`, region `us-east-2`. It does not create a CloudFormation change set, upload a ZIP, provision a credential, apply SQL, activate programs, enable PHI or use real patient data.

From a clean Desktop source with a freshly built blocked qualification Lambda bundle, run:

```text
node scripts/preflight-qualification-program-api-update.mjs --read-only-fictional
```

It binds the exact existing stack's source commit, Lambda code digest, two JWT routes, their shared integration and distinct consumer/workforce authorizers, the isolated database's 112-migration ledger and three designated fictional subjects, its one existing fictional assignment, and all blocked production flags. The stack labels its output `programs_fictional_only`; the Lambda's internal qualification switch is `enabled` under its exact fictional-subject boundary. Both values are checked independently and neither is production activation. The preflight checks the target build against the separately blocked restricted-credential template. A change in any of these values refuses the observation, requiring a fresh review instead of guessing which update is safe.

Even on a successful observation, `changeSetReady` is **false**. The deployed Lambda still uses the cluster-master database credential. Before a replacement, Codex must separately qualify the restricted NOLOGIN/API-role credential, verify exact object and row preservation and rollback, package and read back a new exact-source ZIP, review a no-replacement change set, obtain its execution approval, and rerun hosted positive and negative journeys. The preflight is not a credential grant or activation approval.

The fixture tests include current-state acceptance plus refusals for changed account, source, template, stack, route, integration, authorizer, Lambda credential and database counts. They run in CI without AWS credentials.
