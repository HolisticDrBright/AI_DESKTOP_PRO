# Production Cognito source reconciliation and narrow app-client restriction

The full source reconciliation below is **not** deployed. A separate, narrow app-client write restriction was executed after owner approval; it did not change pools, PHI posture or app releases. Account `173535830222`, region `us-east-2`, stack `ai-longevity-production-clinical-foundation`. The reviewed full-source output template SHA-256 is `5adc7888f0c9d7a69dd869adb3730a337f21fbcb9120ae2a483ae1e75e0bdbb0` over `dist/aws-clinical-core/production-foundation.json`; rebuild and rehash before any use.

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

At that observation, the live clients returned null for explicit read/write lists. The full-source proposal would explicitly read only email, email verification and the existing production person/organization/bound claims, and write only email. The four-resource review-only change set was built before the source commit and was **deleted without execution**. It must not be substituted for a final source-matched review.

## Executed narrow client permission change

After Brandon approved email-only writes for the two public production app clients, a template was derived from the **deployed** CloudFormation template and changed only `WriteAttributes` to `["email"]` on `WorkforceUserPoolClient` and `ConsumerUserPoolClient`. Semantic comparison found no other template property difference. AWS `ValidateTemplate` passed. Change set `arn:aws:cloudformation:us-east-2:173535830222:changeSet/alp-public-clients-email-only-20261014/c1367e3b-1686-4f66-a716-58d09ba22e8b` reported exactly two `Modify`, `Replacement=False` actions, each with one `Properties:WriteAttributes` detail. It was executed under account pin `173535830222`; the stack returned `UPDATE_COMPLETE`.

`DescribeUserPoolClient` after execution reports `["email"]` for both public clients. A property-by-property comparison against the pre-change descriptions found only `WriteAttributes` and `LastModifiedDate` changed. The workforce pool still reports self-sign-up allowed and MFA `ON`. The separate secret-backed consumer `production-clinical-governed-registration` client retains its governed custom-attribute write scope and was not part of this owner approval or change set. No successful password sign-in was run because a fictional account credential was not available; existing sign-in remains a hosted acceptance item.

## Remaining release checks

1. The public clients' email-only write restriction is applied. Recreate the remaining full-source reconciliation from a clean, exact CI-passing head; review the still-different identity resources and execute only as a separate approved change. Preserve existing SES configuration, self-sign-up policy and MFA modes.
2. Read back the deployed template and both pools/clients. Run fictional consumer code/reset and practitioner invitation/sign-in/MFA journeys. A confirmed Cognito account must still have **no clinic or patient access** until an admin-created membership is activated.
3. The practitioner registration UI/server flow is now source-only and blocked. The current production API requires immutable person, organization and production-bound claims, so a public email-only sign-up cannot later become a clinic member. See `docs/workforce-self-signup-blocker-2026-10-14.md`. The owner wants applicants to be able to request either an existing clinic or a new clinic, with membership approval before patient access. Design and hosted-qualify that identity path before opening the route.
4. Keep PHI and production application activation blocked. The pending primary SES alarm subscription and the unreviewed legal/privacy/provider decisions remain separate gates.
