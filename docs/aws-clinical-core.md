# Shared AWS clinical core

## Architecture decision

AI Desktop Pro and AI Longevity Pro V2 will use one governed AWS clinical
core for practice-connected care. AI Longevity Pro V1 is outside this change
and remains unchanged.

The production target is Cognito, API Gateway, Lambda, Aurora PostgreSQL
Serverless v2, private S3 with KMS, SQS/EventBridge, Secrets Manager,
CloudTrail, and CloudWatch. The existing Supabase project remains synthetic
staging only while domains are migrated and reconciled. It is not a production
fallback.

## Product authority

| Resource | Authority |
| --- | --- |
| Patient identity and scoped consent | Shared clinical core |
| Clinical chart, practitioner protocols, approvals | AI Desktop Pro |
| Patient-entered nutrition, wearable observations, adherence | V2 until practitioner acceptance |
| Billing, inventory, scheduling | AI Desktop Pro |
| Commercial and affiliate information | Separate commercial namespace |

Desktop must never infer that a patient-generated observation is a verified
chart fact. V2 sends a provenance-bearing observation. A practitioner decision
creates the clinical fact, preserves the original payload hash, and records the
actor, time, reason, and source.

## Identity and tenancy

- Workforce and consumer identities use separate Cognito user pools.
- A stable internal person id survives identity-provider changes.
- A consumer connects to a practice through an explicit, expiring invitation
  and scoped consent. No matching by email, name, phone, or date of birth.
- Organization, patient, purpose, and consent are checked at the API boundary
  and again in PostgreSQL RLS.
- Consumer and clinical production data live in separate AWS account/data
  boundaries. Security/log archive and synthetic staging use separate accounts.

## Connector placement

Junction and Passio terminate at server-owned connector adapters. Their secrets
live in Secrets Manager and never enter either client bundle.

Junction receives an opaque internal subject id and returns a short-lived,
user-scoped link or mobile sign-in token. Its webhooks land in a bounded API
Gateway route, pass signature and replay checks, enter SQS, and are normalized
before Aurora persistence.

Passio receives only the minimum meal input needed for the requested action.
Raw provider responses and meal images are not retained by default. Nutrition
records carry source and confidence. Provider failure never creates a mock or
estimated clinical record.

Practice-connected use requires durable vendor-registry records for the BAA,
security review, approved purposes, region, retention, and patient consent.
An environment variable cannot stand in for those approvals.

The Desktop runtime contract also requires the AWS API hostname to appear in
an exact server-side allowlist. An HTTPS URL alone is not sufficient.

## Migration plan

1. Accept the AWS BAA and establish the security/log archive,
   production-clinical, production-consumer, and synthetic-staging accounts.
2. Provision the baseline through reviewed infrastructure as code with budget
   alarms at $80 and an operational review at $100.
3. Move identity to Cognito and establish the stable internal person id.
4. Restore the PostgreSQL schema into Aurora. Replace Supabase-specific
   identity helpers with transaction-scoped claims while preserving RLS and
   tenant-isolation tests.
5. Move documents to S3/KMS and APIs/jobs to API Gateway, Lambda, SQS, and
   EventBridge.
6. Register Junction and Passio only after their contract and BAA posture is
   recorded; activate signed callbacks against synthetic subjects first.
7. Connect V2 through the existing `patient-sync/1` gateway during migration.
   Once both products use the same clinical core, keep the envelope as an audit
   and compatibility contract rather than duplicating the patient record.
8. Reconcile counts, hashes, consent, audit events, restore behavior, and tenant
   isolation domain by domain before any real-patient cutover.

The first deployable slice is the synthetic-only CloudFormation stack in
`infra/aws-clinical-core/template.json`. Its operator procedure is documented
in `docs/aws-synthetic-staging-runbook.md`. It exposes only a posture endpoint,
has no database ingress, and cannot be parameterized for production or PHI.

## Launch gate

No real PHI enters the AWS environment until the BAA, vendor inventory, risk
analysis, access review, backup/restore exercise, incident-response exercise,
logging exclusions, and synthetic end-to-end acceptance gate are complete.

AWS endpoint environment variables are descriptive only. They do not activate
the runtime: the application also requires a durable, server-read
`production-clinical` approval record. The synthetic stack never creates that
record.

## Synthetic identity and consent contract

The first Aurora-portable domain migration lives under
`infra/aws-clinical-core/migrations`. It establishes only synthetic identity,
practice membership, opaque patient records, explicit app connections,
hash-only invitations, approved consent artifacts, append-only consent
versions, and PHI-safe audit events.

The contract intentionally contains no email, name, phone, birth date, or
demographic matching field. A Cognito subject binds to a stable internal
person, and a patient connection binds only when that consumer presents an
expiring 256-bit invitation token. Aurora stores the SHA-256 digest, never the
token.

`src/server/clinical-core/aws-identity-consent.ts` is the first server-only
adapter. It is driver-neutral and accepts only a transactional database seam;
there is no browser or direct-database client. Every transaction sets and then
database-validates actor, organization, identity-pool, Cognito subject,
purpose, environment, and data-classification claims before invoking a
governed function. Production, PHI, and real-patient contexts are refused
before a transaction opens.

The migration and a separate authenticated synthetic API extension are now
prepared. The extension uses Cognito JWT authorizers and the Aurora Data API,
so it adds no NAT Gateway or public database ingress. Its deployment remains
blocked on foundation acceptance and a confirmed synthetic migration ledger.
Neither the current Supabase routes nor either app is switched to it.
