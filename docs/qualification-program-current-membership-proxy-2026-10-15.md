# Restricted qualification-program current-membership proxy — source only

This is a **BLOCKED** privilege candidate, not a database migration, deployment or approval. It prepares the isolated fictional program API to use the current clinic membership rather than practitioner clinic/person claims. It does not mount a route or switch the existing handler into `database_current` mode. PHI, production programs and billing remain off.

## Exact source

| File | SHA-256 of current LF bytes |
| --- | --- |
| `infra/aws-clinical-core/source-candidates/qualification-program-current-membership-proxy.sql` | `3454ea3b35428abbb91d27c00191d93597956a03d5434c974779f2fbae45f573` |
| `infra/aws-clinical-core/source-candidates/qualification-program-current-membership-proxy-rollback.sql` | `130ab8955a7b4af083e95a503d7ef63b38dc41826ea22828c99542ce9c8600d5` |

The candidate requires both still-unregistered parents: `qualification-program-api-login.sql` and the corrected `workforce-current-membership-context.sql` (setter body SHA `7054db763a6ff38b00a504a09398dcbd60f69b6476b6c85bab36da496d6e0cd6`). It refuses the wrong database, a missing or altered parent, a qualification role with global API membership or direct clinical-schema access, and any existing third proxy. It atomically creates only `clinical_program_qualification.set_current_workforce_context(text,uuid,text)`, grants that function only to the restricted qualification API role, and limits its purpose to `clinical_data`. It creates no login, secret, subject, row, route or activation.

The rollback verifies the exact definer body SHA `5bfb5080bc9bd3bb5613574fdd15a4bff65ef31f8fb3062cd2784c770377f077` and empty search path before dropping only this proxy. It leaves both parents intact.

## Compatibility order — do not reverse

The currently deployed fictional Lambda's database binding requires exactly **two** proxy functions. Applying this SQL first would make that Lambda refuse every program request. The source adapter now tolerates an optional **third** proxy only when its exact body hash, definer/search path and grants match the reviewed candidate; it still refuses an unknown fourth function or altered third. This compatibility change must be built, reviewed, deployed and observed against the still-two-proxy database **before** any separate approval to apply the third-proxy SQL. The new current-membership route and restricted-login binding have not been implemented or deployed. The existing claim-bound qualification route remains the only hosted route.

The assembled 112-migration fictional database test proves: wrong-database and changed-parent refusals; global-role-grant refusal; no direct private-schema access; current membership selection; wrong purpose, subject, clinic and suspended-membership refusals; old route binding with two or the exact three proxies; changed/extra-grant/extra-proxy refusal; and guarded rollback. Six cases pass locally. This is not a real PostgreSQL lock-wait test, a hosted IAM/credential test, a device test or approval of the new privilege.

## Required reviews before hosted execution

1. Exact-digest owner approval for this new privilege candidate and for each parent not yet applied. Verify isolated database identity, 112-ledger hash, existing proxy bodies/grants, role graph, current setter hash and row custody immediately before any change.
2. Review and deploy the compatibility runtime first, preserving `PHI_ALLOWED=false`, blocked program and billing activation, fictional subject allowlist, and rollback artifact. Prove the old fictional read/refusal path still works with two proxies.
3. Only under a separate approval, apply the candidate, prove the same old path still works with three proxies, and run its guarded rollback rehearsal. Then separately build a route that obtains the subject from a verified fresh session and the clinic from a session-bound selection, never token claims, and binds membership and program action in one transaction.
4. Run two-session hosted revocation/lock races, cross-clinic/role refusals, replay, and owner/consumer boundaries. Do not treat a source fixture or a `200` for a read as hosted acceptance for assignment or purchase.
