# Platform-operator identity candidate — fictional qualification only

This is a **source-only, blocked** prerequisite for the separate `/operator` sign-in. It does not approve the new-clinic bootstrap, register an operator, grant clinic or patient access, enable PHI, or deploy anything. The owner selected a separate MFA-protected operator login; the exact AWS resource creation and operator enrollment still require their own review.

## Source and observed gap

- `scripts/build-aws-platform-operator-identity.mjs` builds an isolated CloudFormation user pool and app client for synthetic account `588966314750`, `us-east-2`. The build takes no options, pins the account/region through resource conditions, requires clean committed source, and writes a source/hash manifest.
- The pool is admin-create-only, deletion-protected, TOTP-only with MFA `ON`, and has no federation. The client permits only `USER_PASSWORD_AUTH`, no OAuth, no refresh auth flow, and a 15-minute ID token. It has no clinical role, API, database, operator registry or users.
- On 2026-10-16, a read-only AWS list showed four synthetic Cognito pools (two older staging and two isolated inventory pools) and **no operator pool**. Production account `173535830222` had only workforce and consumer pools. No pool or user was created by this work.
- The Desktop authenticator in `src/server/clinical-core/platform-operator-authenticator.ts` separately checks the operator issuer, client, pool MFA setting, user-confirmed/email-verified/TOTP state, sign-in age and current SQL registry. The page's sign-in route accepts only a `SOFTWARE_TOKEN_MFA` challenge; it intentionally does **not** enroll a factor, change a temporary password or provision an operator.

## Prerequisites before any AWS change

1. Obtain exact-head green CI and pin the template bytes, SHA-256, commit, account and region. Run CloudFormation template validation and inspect a proposed change set for additions, replacements, retention and ongoing charges. Do not deploy by merely supplying this candidate's `SourceCommit` and `TemplateSha256` parameters; an operator must independently compare them to the file and commit.
2. Review the operator enrollment runbook: owner-run creation, permanent password, verified email and TOTP enrollment **outside** the Desktop page. A first `NEW_PASSWORD_REQUIRED` or `MFA_SETUP` challenge is refused by the page, so an account cannot be considered usable until setup is complete and a fictional sign-in is observed.
3. Give only the separately reviewed operator API role `cognito-idp:DescribeUserPool` and `cognito-idp:AdminGetUser` on the exact operator-pool ARN. This template deliberately grants no IAM permissions and creates no API host. A distinct `PLATFORM_OPERATOR_API_ORIGIN` and current SQL operator registry are still required; neither workforce nor consumer credentials can stand in.
4. Apply the BLOCKED operator listing/approval SQL candidate and route host only after their exact migration, rollback and source reviews. Register an operator subject only by a separate owner-run, audited change. Exercise stale-token, removed-operator, wrong-pool, wrong-client, MFA removal, cross-clinic and new-clinic approval negatives with fictional identities.
5. Keep all release switches blocked until the security, retention, privacy, provider and PHI reviews are recorded. Creating this pool alone must not change clinical access or the production account.

## Verification and limits

`npm run test:platform-operator-identity` asserts the account/region condition, admin-only creation, TOTP-only MFA, no federation/self-sign-up/refresh, blocked metadata and absence of IAM/API/database resources. CI builds the clean artifact and lints its CloudFormation template. This is **local/CI source evidence**, not hosted Cognito authentication, API authority, device or PHI acceptance.
