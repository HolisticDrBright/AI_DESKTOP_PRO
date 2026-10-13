# Caregiver protocol read candidate — 2026-10-13

Status: **source-only, unregistered, not deployed, not PHI-approved**. The clinical SQL source is
`infra/aws-clinical-core/production-candidates/delegated-protocol-records.sql` (`delegated-protocol-records/3`, SHA-256 `c86a242ccac1098f02e44e6499f2f552826c3eb0aca6673504c0102250ed8705`).
It replaces one existing function and is locally tested on the 112-migration
telehealth-consent-copy source artifact; it does not alter
historical migrations, grant new table access, seed records or enable a feature.

## Patient-approved scope

An active, unrevoked, unexpired patient relationship must include `protocols_supplements`.
The recipient is independently resolved from the consumer identity. Only an active clinic
protocol version with a practitioner approver and activation can contribute content. A product
item must have a practitioner interaction review, a verified label, approved current catalog
version, product type `supplement`, and nonrestricted open or practitioner-gated access.
Peptides, restricted or unverified products, non-product instructions, older lab-derived owner
plans, URLs, and version free text do not enter the caregiver payload. The returned `heldItems`
is a count only. No order action is exposed.

The relationship is checked again after payload construction and the access-audit write, under a
short `FOR SHARE` row lock. A revocation or expiry that wins before that final check refuses the
entire read; a revocation arriving after the lock waits for the read transaction. The database test
reproduces a revocation at the audit boundary and failed against `/2` before passing against `/3`.
This is a deterministic local surrogate, not a real PostgreSQL concurrent-lock qualification.

Until this SQL is registered, the identity API's `aws-family-access` adapter fails closed for
legacy all-fields protocol payloads. V2 shows only rows with the candidate's explicit
practitioner-approval markers and never treats the Core lab-directive gate as a substitute for
practitioner approval.

## Before any hosted use

1. Pin and review the parent migration artifact and SQL digest; run a preserving rollback test.
2. Run `delegated-protocol-records.database.test.ts` against the candidate and repeat on the
   isolated fictional qualification database with separate consumer identities. Include a real
   PostgreSQL revocation-versus-read lock race before release.
3. Verify active, revoked, expired, wrong-scope, cross-person, cross-clinic and held-item cases
   through the actual identity API. Capture the raw JSON response, not just the rendered screen.
4. Deploy matched identity API and V2 builds only after the source response is confirmed to omit
   held fields. Keep PHI off, use fictional accounts, and do not spend on a paid mobile build
   without the owner's separate authorization.

The source test is a local PGlite proof, not hosted acceptance or permission to process real
patient data.
