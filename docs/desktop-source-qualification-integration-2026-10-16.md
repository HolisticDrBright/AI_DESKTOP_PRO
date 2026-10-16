# Desktop source qualification integration — 16 October 2026

This branch combines Claude's `claude/desktop-next-source-20261016` head `3c863b7b`, the Fullscript membership-fence source head `e08df97f` (which descends from Claude's head), and the separate fictional platform-operator identity/verifier branch through `6ad788ff`. Git merged without conflicts. The only additional code cleanup removes an unused import from the qualification-program builder; it changes no runtime behavior.

The integration is source continuity, not deployment or activation. The legacy clinic-status successor, current-context care-messaging successor, operator SQL and release switches remain blocked. The operator Cognito pool was created separately in the fictional AWS account after exact owner approval, with PHI false, activation blocked and zero users; this branch does not enroll or authorize one.

## Verification

- On the pre-verifier-follow-up merge, `npm run test:unit` passed 651 files, 10,047 tests, with 11 existing skips. The follow-up changed only the read-only operator verifier, its three fixture cases and documentation; those three cases pass on the final combined tree.
- On the final combined tree, typecheck and lint pass with zero errors or warnings. The clinical production build passes at 270 generated/static pages. The bundle scan passes on 353 client chunks with none of its 21 server-only markers.
- Source CI for Claude `3c863b7b` and the earlier operator verifier `9a3f444a` passed on their exact heads. CI for the corrected operator verifier `6ad788ff` and for this integration head must be recorded separately; a parent pass is not an integration pass.
- A read-only live Cognito check of the approved fictional stack passes the corrected verifier: pool and client are present, mandatory TOTP is observed from `GetUserPoolMfaConfig`, self-sign-up is disabled, and there are zero users. This does not prove an operator sign-in, SQL authority or clinical access.

## Holds

- Do not apply the immediate-denial legacy clinic-status SQL solely from this integration: the owner's ordinary-suspension instruction allows existing lawful sessions until expiry, while emergency compromise needs a separately reviewed continuity design. New practitioner consent decisions remain blocked under the stated policy; authorized withdrawal cleanup must continue.
- Fullscript callback installation is better fenced, but the same-clinic/same-email actor key can still collide across distinct subjects; no hosted provider race or production activation is claimed.
- Five Desktop route-authority cells remain unverified in Claude's return. Four are in an older transitional lab-document host outside this repository; the fifth comprises unconverted removed-membership subfamilies.
- The operator reader IAM policy is unattached; there is no enrolled operator, SQL registry, or hosted `/operator` sign-in. Care messaging still lacks a restricted deployed credential and current-context hosted negative matrix.
- No matched Desktop/V2 backend deploy, physical iOS/Android acceptance, store sandbox purchase/restore, provider review, PHI activation or paid mobile build follows from this merge.
