# Independent personal storage deployment candidate — September 16, 2026

Source implementation, not deployed or activated. Original phases 2/6 advance;
neither phase closes. The historical disabled artifact remains unchanged.

`node scripts/build-aws-personal-storage.mjs` now emits:

- `dist/aws-clinical-core/personal-storage/index.js`: the existing owned API bundle.
- `disabled-template.json`: the existing always-blocked, logs-only endpoint.
- `template.json`: a functional production candidate, default blocked/PHI false.

The candidate can configure the database-backed records, consent, active plan,
chat-context and privacy-request/export routes. It does not supply migrations,
identities, consent text, source releases, approval records or completed privacy
fulfillment. The runtime still enforces owner identity, per-feature consent and
scope, database RLS and current revision/content checks.

## Deployment contract

The API must be the reviewed production consumer HTTP API. A dedicated JWT
authorizer is created using exactly the runtime consumer issuer and audience;
no externally selected authorizer can accidentally point these routes at the
workforce pool. API Gateway invocation is restricted to this account, API and
personal-route namespace. These routes must replace their existing stack-owned
definitions, not collide with routes in another stack. Review the change set;
do not delete/recreate a production route opportunistically.

Supply the reviewed cluster, database name and **non-administrative application
secret**, its KMS key, the CloudWatch Logs encryption key and an approved alarm
topic. The DB login must be permitted to assume `clinical_core_api`, have no
superuser/BYPASSRLS/owner privileges and no unrelated role memberships. A hash
parameter is a reference to a separately reviewed report, not a cryptographic
proof that the supplied database user is safe. No credential value is placed in
the template or function environment; the runtime uses the secret ARN.

Database access is granted only when PHI is explicitly true, activation approved,
both activation and database review hashes are present, scopes nonempty and an
alarm recipient supplied. CloudFormation rules refuse incomplete activation;
the IAM condition independently withholds the whole data policy. Default and
blocked deployments have logs-only permissions. Do not set activation parameters
until the separately documented agreements, consent, policy and deployment review
gates have genuinely passed.

The conditional policy allows four Data API transaction/query actions on one
cluster, reading one secret in the current account and decrypting that secret's
key only through Secrets Manager with its exact encryption context. It grants
no object storage, identity administration or batch SQL permissions. Application
transactions still set the restricted clinical API role. Cross-region or foreign
account resources are not a supported deployment configuration.

Code is bound to a non-null S3 object version. The SourceCommit output records
the operator-supplied source SHA; operators must separately verify the published
artifact digest and version against that commit. It is not automatic attestation.

Logs are KMS encrypted and retained on stack deletion/replacement. Thirty days
is a candidate retention setting, **not an approved legal retention policy**.
The key policies and SNS delivery must be verified in the destination account.
Reserved concurrency is four, not a commercial capacity claim. Errors and
throttles have Lambda alarms. Because handled database failures return 503 instead
of throwing, an API Gateway 5xx alarm also covers those responses; that alarm is
API-wide and may include other routes. No request bodies or JWTs are logged by
this addition. Expected blocked-mode 503 responses can trigger the API alarm.

Knowledge-release mode remains explicitly disabled, with no S3 release access.
Deploying storage does not make disputed or unverified clinical content eligible.
Consent withdrawal, scope deactivation and PHI shutdown do not erase stored data.
Full privacy fulfillment and shutdown access require the separate reviewed
operational process; this template does not claim to implement them.

## Verification and remaining acceptance

Five infrastructure tests build the real artifacts, compare every declared personal route
against the runtime contract, test every incomplete IAM activation combination,
scope allow-list, permission resources and key conditions, and invoke the actual
blocked bundle without database configuration. Both artifacts pass CloudFormation
schema/reference lint; CI now explicitly validates both. Existing owned API and
107-assertion Aurora rollback evidence cover handler/database behavior, not this
candidate's deployed IAM, JWT integration or KMS policies.

Still required: reviewed database-role/55-migration evidence, artifact pinning,
account/region/key/pool/API matching, approved alarm delivery and retention,
change-set review, hosted isolation/consent/plan/privacy tests, load and recovery,
mobile configuration and physical acceptance. None of these were silently
checked off by generating a template. No AWS writes, paid build or PHI activation
were performed for this increment.
