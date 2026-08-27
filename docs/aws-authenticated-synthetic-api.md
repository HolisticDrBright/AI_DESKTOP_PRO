# AWS authenticated synthetic API

Deployment migration, synthetic fixture provisioning, and the direct
Cognito-to-Aurora acceptance gate are documented in
`docs/aws-synthetic-deployment-acceptance.md`.

## Purpose

This phase adds the first authenticated HTTP boundary for the shared AWS
clinical core. It remains limited to clearly labelled synthetic staging. It
does not switch AI Desktop Pro or AI Longevity Pro V2 away from their current
runtime, and AI Longevity Pro V1 remains unchanged.

The public foundation still exposes only `GET /posture`. The separate
`identity-api-extension.json` stack exposes 19 Cognito-authenticated routes for
identity linking, scoped consent, governed clinical records, privacy requests,
and reviewed lab import/read-back.

## Identity boundary

- Workforce and consumer routes use different Cognito JWT authorizers.
- The Lambda independently checks issuer, audience, `token_use=id`, subject,
  immutable `custom:person_id`, immutable `custom:organization_id`, and the
  exact `custom:synthetic_attested=true` marker.
- A valid token from the wrong pool is refused. An environment variable cannot
  convert a real person or patient into a synthetic subject.
- Request bodies are exact-key JSON objects capped at 20 KiB. Clinical payloads
  are collection-specific, capped at 16 KiB and eight levels, and reject
  credentials, direct account identifiers, unexpected fields, and non-finite
  values before Aurora is called.
- Responses use bounded categories. Raw AWS, PostgreSQL, credential, claim,
  and request-body details are never returned.

## Database transport

The Lambda uses the Aurora Data API over AWS HTTPS, avoiding a NAT Gateway,
public database ingress, and fixed-price VPC endpoints. Every operation begins
an explicit transaction, assumes `clinical_core_api`, database-validates the
request context, invokes one lifecycle function, and commits or rolls back.

The Lambda role can perform only the four Data API transaction actions, read
the single AWS-managed database secret, decrypt it only through Secrets
Manager, and write to its encrypted 30-day log group. It cannot administer
Cognito, S3, networking, or clinical infrastructure.

Clinical writes are immutable versions keyed by stable record ID, resource
version, payload hash, and idempotency key. Each collection requires its
matching active consent. Audit events contain only opaque IDs and safe posture;
clinical content is excluded. Export, correction, and deletion requests are
stored separately for workforce fulfillment.

## Deployment order

No AWS deployment was run while this phase was authored. When the dedicated
account, accepted AWS BAA, budget owner, and reviewed manifest exist:

1. Deploy the foundation stack and complete its acceptance checks.
2. Apply the ordered SQL migration to synthetic Aurora through a reviewed
   administrative session. Record its version and SHA-256 in the migration
   ledger.
3. Create only labelled synthetic organizations, people, Cognito identity
   bindings, memberships, patient records, and approved consent artifacts.
4. Run all repository gates and build the Lambda artifact.
5. Deploy the extension only with the explicit
   `-ConfirmSyntheticMigrationApplied` switch. The script rechecks the
   foundation outputs for `synthetic-staging`, `synthetic_only`, and
   `PhiAllowed=false` before uploading or deploying anything.

```powershell
powershell -ExecutionPolicy Bypass -File scripts/deploy-aws-authenticated-api.ps1 `
  -FoundationStackName <synthetic-stack> `
  -ArtifactBucket <reviewed-artifact-bucket> `
  -Region us-east-2 `
  -ConfirmSyntheticMigrationApplied
```

## Acceptance status and remaining production gates

The deployed synthetic gate now runs 30 external operations covering pool and
tenant isolation, invitation replay, scoped consent, duplicate-safe clinical
and lab writes, paginated read-back, privacy requests, forbidden-identifier
rejection, clinician lab review, and patient lab read-back. Production risk
analysis, named workforce approval, backup/restore and incident-response
evidence, vendor/BAA review, and the production-specific data plane remain
separate gates. Real patient data and PHI remain prohibited until they pass.
