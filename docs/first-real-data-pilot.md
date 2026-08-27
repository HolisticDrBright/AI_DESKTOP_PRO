# First real-data pilot boundary

This document defines the smallest production pilot for AI Longevity Pro V2 and AI Desktop Pro. It is an engineering and operational release boundary, not a declaration of HIPAA compliance.

## Exact scope

The pilot is limited to one explicitly named production organization and the `lab_intake_only` capability set:

- Cognito workforce and consumer authentication;
- patient invitation and claim;
- explicit, versioned lab and forms/check-in consent plus withdrawal;
- App laboratory-result and governed health-intake transfer;
- duplicate-safe receipt and bounded historical backfill;
- source/provenance display, clinician review, correction, and rejection;
- patient and practitioner read-back;
- privacy requests and append-only audit evidence.

Billing, messaging, scheduling, programs, protocol activation, product recommendations, Junction, Passio, and clinical AI are outside this pilot. They must remain disabled even if credentials exist.

## Machine-enforced protections

- The production API requires `PHI_ALLOWED=true`, `ACTIVATION_STATE=approved`, and a 64-character reviewed evidence hash.
- Activation additionally requires `PILOT_SCOPE=lab_intake_only` and a non-placeholder `PILOT_ORGANIZATION_ID`.
- Cognito tokens must be issued by the exact production pool, carry `custom:production_bound=true`, omit the synthetic attestation, and match the one pilot organization.
- The Desktop compatibility endpoint accepts only the lab/intake pilot operation allowlist in `src/server/clinical-core/production-pilot-policy.ts`.
- Supabase, Fly, App Runner, Junction, Passio, billing, messaging, protocol activation, and clinical AI are refused as PHI paths.
- The V2 production-pilot build uses its controlled EAS `production` environment and refuses missing AWS/Cognito identifiers, legacy SaaS variables, or public secret fields.

## Activation sequence

1. Copy `infra/aws-clinical-core/first-real-data-pilot-readiness.example.json` to the ignored controlled manifest `first-real-data-pilot-readiness.json`.
2. Supply controlled evidence references and the exact pilot organization UUID. Do not place patient names, email addresses, credentials, or clinical values in the manifest.
3. Complete and sign every control and approval. Engineering must not populate another owner's approval.
4. Run `npm run check:aws-first-real-data-pilot`. Any blocker refuses activation.
5. Build the exact Desktop and V2 commits, record their ECR digests, and run the complete synthetic end-to-end and rollback exercises in the exact production configuration.
6. Deploy with PHI still disabled and independently verify the effective environment, IAM permissions, routes, logs, alarms, backups, and zero retained clinical rows.
7. After the signed change record, activate only the named organization for a supervised minimum-data test. Monitor continuously and retain an immediate kill switch and rollback operator.

No real patient data may be used before step 7.
