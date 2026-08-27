# AWS synthetic identity, invitation, and consent

## Scope

This slice prepares the first shared clinical-core data contract for AI
Desktop Pro and AI Longevity Pro V2. It remains synthetic-only and does not
change AI Longevity Pro V1, the active Supabase staging runtime, or any current
patient-facing route.

## Authority and lifecycle

- A `person` is the stable internal identity. Cognito subjects are replaceable
  authentication bindings, not patient identifiers.
- Workforce and consumer identities remain separate. The database validates
  the exact identity-pool and subject binding on every transaction.
- A practice owns an opaque synthetic patient record. It has no contact or
  demographic matching fields.
- A workforce owner, admin, or practitioner issues an invitation for one
  patient record. The server returns 256 random bits once; only the SHA-256 is
  persisted. Invitations expire within 48 hours and are single-use.
- A consumer can claim only as the person bound to the verified Cognito
  subject. The claim never considers email, name, phone, birth date, or an
  identifier resemblance.
- Consent requires a versioned, approved artifact for the same organization
  and scope. Grants and revocations append new rows; prior versions cannot be
  edited or deleted. Research remains an independent scope.

## Database boundary

The SQL is PostgreSQL/Aurora portable. It does not use `auth.uid()`, Supabase
roles, or PostgREST. The API role has read access only through RLS and mutation
access only through four bounded `SECURITY DEFINER` functions. Invitation rows
have no direct read policy or API-role privileges.

The server adapter opens one transaction, binds actor, organization,
identity-pool, Cognito subject, purpose, environment, and classification, and
then invokes exactly one lifecycle function. The database validates that the
identity binding is active and synthetically attested before setting the
transaction-local claims.

## Migration integrity

`applyClinicalCoreMigrations` obtains a transaction advisory lock, bootstraps
the migration ledger, computes SHA-256 for every migration, refuses rewritten
history, and applies missing versions atomically. It accepts an injected
transactional database driver so no credential, host, or vendor SDK becomes
part of the domain contract.

## Deliberately unavailable

- No Aurora connection or migration apply has run.
- No Cognito users, organizations, patient records, or consent artifacts have
  been created.
- The authenticated API Lambda and Aurora Data API transport are prepared in
  source but have not been deployed or called against AWS.
- No production/PHI mode exists in this schema or adapter.
- No Junction or Passio secret or payload is involved.

## Acceptance required after deployment

The source-level suite proves the static boundary and adapter behavior. A
future in-AWS acceptance suite must still prove RLS and function behavior on
the deployed Aurora engine, including cross-tenant access, forged identity
subjects, concurrent claims, invitation replay/expiry, consent version races,
audit completeness, and backup/restore. Passing source tests is not permission
to load real patient data.
