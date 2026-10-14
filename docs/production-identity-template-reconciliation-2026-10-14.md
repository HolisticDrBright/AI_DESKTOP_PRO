# Production Cognito source reconciliation — review only

This is source and change-set evidence, **not** an executed foundation update, practitioner-registration launch, PHI approval or app release. Account `173535830222`, region `us-east-2`, stack `ai-longevity-production-clinical-foundation`. The reviewed output template SHA-256 is `5adc7888f0c9d7a69dd869adb3730a337f21fbcb9120ae2a483ae1e75e0bdbb0` over `dist/aws-clinical-core/production-foundation.json`; rebuild and rehash before any use.

## Failing-before findings and repair

1. The production builder duplicated `custom:production_bound` in each pool's schema. Its checker accepted the duplicate. A new test failed with two entries; the builder now emits exactly one and the checker rejects any duplicate schema name.
2. Both generated production app clients requested `custom:synthetic_attested`, which the production pools do not have. A second test failed before repair. The builder removes that synthetic-only read attribute; the checker rejects any custom read attribute absent from its production pool and keeps client writes scoped to `email`.
3. The deployed pools were manually updated with the owner-approved SES sender, code and workforce invitation copy, but the CloudFormation template did not express them. The builder now emits the same SES configuration, `CONFIRM_WITH_CODE` body and self-sign-up policy for both pools, plus the approved workforce invitation body. The approved message text is asserted independently in tests. No unapproved custom subject was introduced. One-day temporary-password validity remains in `PasswordPolicy`; the deprecated `UnusedAccountValidityDays` field was not added alongside it.
4. The ordinary foundation deployment script now compares all four proposed identity resources against the deployed template **before any AWS write**. A mismatch refuses deployment and requires a separately reviewed change set. It never auto-executes that change set. The drift guard is tested for missing, stale and broadened resources. At the observed live state it correctly refuses because reconciliation has not been executed.

The built template passes the source guard and AWS `ValidateTemplate`. These checks do not prove Cognito runtime behavior after a stack update.

## AWS observation — not execution

The review-only change set `arn:aws:cloudformation:us-east-2:173535830222:changeSet/alp-identity-source-reconcile-20261014/953de19d-f3db-4d36-bfe2-3bcbfb752b33` reached `CREATE_COMPLETE` / `AVAILABLE`. It reports exactly four `Modify` actions, all `Replacement=False`:

- `WorkforceUserPool` and `ConsumerUserPool`: `AdminCreateUserConfig`, `EmailConfiguration`, `VerificationMessageTemplate`.
- `WorkforceUserPoolClient` and `ConsumerUserPoolClient`: `ReadAttributes`, `WriteAttributes`.

The current live clients return null for explicit read/write lists. The proposed clients would explicitly read only email, email verification and the existing production person/organization/bound claims, and write only email. This is a permission change and must be reviewed against sign-up, MFA, reset and current sessions. The review-only change set was built before the source commit and must **not** be executed as a substitute for exact-head CI and a final source-matched review.

## Remaining release checks

1. Review the four-resource change set and the app-client attribute change with the owner/security reviewer. Recreate it from a clean, exact CI-passing source head; confirm no other resource or replacement is listed. Execute only after that separate review. Preserve the existing SES configuration and user-pool MFA modes.
2. Read back the deployed template and both pools/clients. Run fictional consumer code/reset and practitioner invitation/sign-in/MFA journeys. A confirmed Cognito account must still have **no clinic or patient access** until an admin-created membership is activated.
3. Build the missing practitioner Create account and confirmation UI/server journey plus trusted workforce identity registration. Cognito's `AllowAdminCreateUserOnly=false` is an AWS setting, not a usable Desktop self-registration flow. Do not automatically issue `custom:person_id`, `custom:organization_id` or `custom:production_bound` to an unapproved sign-up.
4. Keep PHI and production application activation blocked. The pending primary SES alarm subscription and the unreviewed legal/privacy/provider decisions remain separate gates.
