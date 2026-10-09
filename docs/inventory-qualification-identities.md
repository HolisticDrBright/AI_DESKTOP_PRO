# Isolated qualification identities

The 107-migration qualification fleet needs distinct consumer and practitioner identities. The existing shared staging workforce pool has optional MFA; changing it would also change existing Desktop access. A separate four-resource template creates private fictional-test pools and public clients without editing those shared pools. It does not create users or enable any clinical route.

## Configuration boundaries

Both pools are restricted to synthetic account `588966314750` in `us-east-2`, with administrator-only fixture creation, email sign-in, verified-email recovery, password-only first factors and immutable identity attributes. Consumer TOTP is optional; workforce TOTP is mandatory. Clients have no secret, 15-minute access and ID tokens, 12-hour refresh tokens, token revocation, email-only write access, and no OAuth callbacks or external providers. Deletion protection and resource retention preserve the test pools on stack deletion or replacement.

The configuration-only observer independently reads and requires `AllowAdminCreateUserOnly: true` on both fixture pools. Missing, false, malformed or additional invitation policy is refused. This private-fixture requirement does not change the designated-user observer's scope or impose administrator-only registration on public Core consumers.

These private pools are not the Core self-service registration plane. No real contacts, medical information, user passwords or approvals belong in the template or its manifest. The `ESSENTIALS` tier is explicit because AWS requires it for the sign-in policy. See [AWS sign-in policy](https://docs.aws.amazon.com/AWSCloudFormation/latest/TemplateReference/aws-properties-cognito-userpool-signinpolicy.html) and [user pool configuration](https://docs.aws.amazon.com/AWSCloudFormation/latest/TemplateReference/aws-resource-cognito-userpool.html).

## Build and observation

From clean, committed source, run `npm run build:inventory-qualification-identities`. The output directory is `dist/aws-clinical-core/inventory-qualification-identities`. Its manifest pins the source commit, template bytes and read-only observer bytes. Run `npm run test:inventory-qualification-identities`, the identity dependency/template/command Vitest tests, and CloudFormation lint before any new-stack deployment. Set the stack's `SourceCommit` and `TemplateSha256` from that manifest. Do not substitute a review hash or import an existing pool.

After the new stack completes, write only its four non-secret identity bindings into a regular bounded JSON file: `consumerIssuer`, `consumerAudience`, `workforceIssuer`, and `workforceAudience`. Run `node dist/aws-clinical-core/inventory-qualification-identities/observe-configuration.cjs --observe-configuration <file>`. The observer uses the pinned `ai-synthetic-member` profile, refuses root or another account, reads STS plus each pool/client/MFA configuration, and repeats those seven reads to reject drift. It never reads user contact attributes, tokens, passwords or client-secret values.

An accepted configuration report leaves designated-user, database-authority, retention-service, physical-login, complete-fleet, acceptance and human-review evidence false. Fictional accounts, staff TOTP enrollment and actual login, database mappings, target binding, provider/storage authority and hosted acceptance remain separate prerequisites. PHI and production activation remain disabled.

Cognito can return `WebAuthnConfiguration: { FactorConfiguration: "SINGLE_FACTOR" }` from its MFA configuration API even when the separately observed first-factor policy permits only `PASSWORD`. The observer admits only that exact inert default (or absence), while refusing additional relying-party/user-verification configuration and every passwordless first-factor policy. It does not enable WebAuthn or treat the default as successful MFA enrollment.

## Verification limits

The template-to-observer test uses fictional responses derived from rendered properties. It checks parity, not AWS behavior. Only the independent read against completed real resources can establish configuration. Even that read cannot certify a user's MFA login or commercial and PHI readiness.

## Fictional account provisioning

Only after the owner's separate synthetic-resource authorization, build from clean committed source and run `node dist/aws-clinical-core/inventory-qualification-identities/provision-fictional-fixtures.cjs --provision-fictional-fixtures`. The command is restricted to the new isolated pools `us-east-2_G2Hvf9wzJ` and `us-east-2_zGOVBoeGT`; it accepts no alternative account, pool, username, password, consent or approval input. It rechecks the private configuration before every write and at completion.

The operator first persists a create-only intent with randomly generated credentials in Secrets Manager under `alp/qualification/inventory-identities/<binding hash>`. Fictional addresses use the reserved `.invalid` domain; Cognito invitations are suppressed and alias takeover is refused. Three distinct immutable person IDs and one fictional organization ID are recorded. They are test identifiers, not database authority, and fixture email verification is not evidence of a real email-confirmation journey.

On retry, the persisted intent wins. A missing user is created; an exact intent-owned user in `FORCE_CHANGE_PASSWORD` may receive its initial permanent password. A confirmed user is never reset, and missing, disabled, displaced or production-bound attributes are refused. SDK calls use the explicit member profile, Ohio endpoints, one attempt and a finite deadline. Uncertain writes stop rather than repeat. Credentials, SDK error bodies and tokens are never printed. The final report separately counts create attempts and completed initial-password writes; these are not claims of newly created users in a concurrent run.

Workforce TOTP enrollment and authenticated consumer/workforce login remain unverified after provisioning. No clinical database row, retention-service authority, provider release, consent, review hash or PHI setting is written. Do not point a deployed API at these identities until its separate target binding, database mappings and safety qualifications are satisfied.

Cognito subjects are opaque issuer-local strings; AWS explicitly says they do not necessarily conform to RFC UUID formats. The qualification transport admits only its existing safe 8–128-character ASCII alphabet (no comma, whitespace, path or CLI-option injection), preserves case and compares the exact observed sub/username under the bound pool. This is not identity proof or a generic validation rule for all OpenID providers. Generated person/organization IDs retain their separate UUID validation. Database subjects stay parameterized text; they are never cast into clinical UUIDs. The real-schema test includes a non-RFC version/variant example and a non-UUID opaque subject. See [AWS sub documentation](https://docs.aws.amazon.com/cognito/latest/developerguide/user-pool-settings-attributes.html).
