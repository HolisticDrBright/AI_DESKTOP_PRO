# Care messaging: least-privilege database credential, source only — 16 October 2026

BLOCKED and source only. Nothing here creates a login, password, secret, grant, schema, stack, Lambda upload or
migration in AWS. The read-only fleet inventory of 16 October found all eight qualification-database Lambdas,
care messaging among them, on the RDS-managed cluster-master secret; this is the candidate that would take care
messaging off it.

## 1. Why

Today the care-messaging Lambda signs in with whatever secret its template is given. That is the master secret in the
fleet. It then runs `set local role clinical_core_api`, the global API role. At the 112 release that role can execute
**295** clinical functions across every family — clinic membership, programs, privacy, operator, billing and sibling
services. It also has privileges in sibling databases on the cluster. Care messaging needs four.

## 2. The candidate

**SQL:** `infra/aws-clinical-core/source-candidates/care-messaging-qualification-login.sql` (BLOCKED).

- **Roles.**
  - `clinical_care_messaging_qualification_login`: NOLOGIN until an operator provisions it.
  - `clinical_care_messaging_qualification_api`: NOLOGIN and NOINHERIT, with no other attributes.
  - The login's only membership is the API role, with SET only (no INHERIT, no ADMIN). Nothing is granted
    `clinical_core_api`.
- **Proxies.** Schema `clinical_care_messaging_qualification` holds four SECURITY DEFINER proxies with
  `search_path=''`, all with PUBLIC revoked:

  | Proxy | Calls |
  | --- | --- |
  | `set_request_context` | `clinical_private.set_request_context` |
  | `request` | `clinical_core.production_care_message_request` |
  | `resolve` | `clinical_core.production_care_message_resolve` |
  | `export` | `clinical_core.production_care_message_export` |

- **Ownership, without changing any.** The executing role must already own all four targets, which are themselves
  SECURITY DEFINER. A proxy therefore runs as the same owner its target already runs as, so it adds no privilege the
  target lacks. Consent, recipient, connection, idempotency and FORCE-RLS checks stay inside the unchanged targets.
  A target owned by anyone else is refused (`care_messaging_targets_refused`).
- **Post-conditions, in the same transaction.** Any failure removes everything the file created. The file refuses:
  - a sibling database the login or API role could CONNECT to through PUBLIC (`sibling_database_connect_refused`).
    This uses the same rule as the CONNECT-isolation preflight: connectable, non-template, not `rdsadmin`. **The
    CONNECT isolation must have run first.**
  - USAGE on any schema except the proxy schema, `public` and the system schemas (`care_messaging_schema_usage_refused`);
  - any executable non-extension function outside the proxy schema (`care_messaging_function_reach_refused`).
    pgcrypto in `public` is exempt as an extension;
  - any table, view or sequence privilege (`care_messaging_table_reach_refused`);
  - a membership graph other than login → API (`care_messaging_membership_refused`).

**Rollback:** `…-login-rollback.sql` (BLOCKED). Run it only after the Lambda has stopped using the credential and the
login is NOLOGIN again.

- It refuses all of:
  - another database;
  - an enabled login;
  - extra memberships;
  - a proxy body that differs from the four reviewed hashes;
  - any other object in the schema;
  - any grant beyond the six the candidate made, or an owned object.
- Otherwise it drops the four proxies, the schema, the login's CONNECT grant and the two roles. It touches no table,
  row, policy or existing function.

**Runtime:**

- `createRdsDataQualificationCareMessagingDatabase` refuses, before a client exists:
  - any secret other than `arn:aws:secretsmanager:us-east-2:588966314750:secret:alp-qualification-care-messaging-api-db-*`;
  - explicitly, anything containing `rds!`;
  - any database other than `clinical_core_qualification`, any other region, or a cluster in another account.

  It then assumes `clinical_care_messaging_qualification_api`.
- `createRestrictedCareMessagingHandler` checks its configuration before constructing anything. It returns 503 with
  the factory never called unless it has all of:
  - the 112 release;
  - PHI off and activation blocked;
  - deployment account 588966314750;
  - `CARE_MESSAGING_DATABASE_CREDENTIAL=restricted_qualification`;
  - an authority that is not `database_current`. The current-membership setter has no reviewed proxy yet.
- `bindRestrictedCareMessagingDatabase` runs a check on every transaction, as the restricted role. It covers:
  - the 4 proxy hashes and the 7 target hashes;
  - no direct EXECUTE;
  - FORCE RLS and the six triggers;
  - no USAGE on `clinical_core`, `clinical_private` or `clinical_audit`;
  - the role's own membership.

  Names are joined, never cast to `regclass`, because the role must not need schema USAGE to check them. The service's
  four statements are rewritten to their proxies; **any other statement is refused before it is sent.**
- `care-messaging-restricted-lambda.ts` is the entry point, built by
  `node scripts/build-aws-care-messaging.mjs --release=112 --credential=restricted`
  (`npm run build:aws-care-messaging-restricted-credential`).

**Template:** the 112 template with only these changes:

- the secret pattern (the dedicated prefix only);
- `DatabaseName` limited to `clinical_core_qualification`;
- the cluster account pinned;
- the credential flag in the Lambda environment;
- BLOCKED metadata carrying the SQL and rollback hashes.

The default and 112 artifacts are byte-identical to `15339f18` (template and code compared, same commit).

## 3. Evidence

| Test | Cases | What it proves |
| --- | --- | --- |
| `src/server/clinical-core/care-messaging-restricted-credential.database.test.ts` | 42 | Real 112 schema in PGlite. The proxy hashes agree in SQL, runtime and rollback. Refusals leave nothing behind: wrong database, sibling CONNECT, broad PUBLIC schema USAGE, a target owned by another role, a late failure. The login cannot `SET ROLE` to the API, migrator or worker roles. Zero reachable non-extension functions or tables. **18 unrelated calls refused**: clinic membership ×6, programs, privacy ×2, operator ×3, billing, sibling services ×3, and the targets without their proxies ×2. The **messaging journey through the proxies**: send, recipient refusal, clinician read, consent withdrawal, retained export. Drift refused before business SQL. The statement allow-list. 11 configuration refusals with the factory never called, master secret included. The guarded, preserving rollback. |
| `scripts/care-messaging-restricted-credential.test.mjs` | 5 | The template equals the 112 template except the listed fields. The secret pattern refuses master, the program secret and another account. The manifest pins the SQL hashes and `deploymentPerformed: false`. The bundle carries the proxies; the default bundle does not. Bad flags are refused. |
| `cfn-lint` 1.57 | — | The restricted template lints clean. |

Existing care-messaging suites still pass unchanged: 8 files, 356 tests, including the restricted file.

## 4. Codex steps (not executed; in order)

1. Run the reviewed CONNECT isolation for the qualification cluster. The candidate refuses until no sibling database
   is reachable through PUBLIC.
2. Review the SQL and rollback by hash (see the hand-back), then apply the login candidate to
   `clinical_core_qualification` only, as the role that owns the four targets.
3. Provision `alp-qualification-care-messaging-api-db-*` for the login (Secrets Manager). Only then `ALTER ROLE … LOGIN`
   with that password, never in this file. Audit the role, membership and secret against the post-conditions.
4. Deploy the restricted template from a clean build at the reviewed commit, still blocked. Run hosted refusal tests:
   - the master secret is refused;
   - the unrelated functions are denied;
   - messaging works through the proxies.
5. Rollback order: stop the Lambda → `ALTER ROLE … NOLOGIN` → run the rollback → remove the secret.

## 5. Blockers and alternatives

- **The current-membership setter.** It is UNREGISTERED and has no proxy, so `database_current` is refused under this
  credential. A fifth proxy is a successor once the setter is registered.
- **A dedicated proxy-owner role.** It would be stricter still: proxies owned by a NOLOGIN role holding EXECUTE on the
  four targets only. But on Aurora PostgreSQL 16 the operator would need SET membership on that role to `ALTER … OWNER`,
  which cannot be verified here. The chosen form (proxy owner = target owner) adds nothing beyond the targets, so it
  is the reviewed alternative rather than a weakening.
- **`TEMP` on the database through PUBLIC, and `template1` CONNECT.** These are left to the cluster-wide CONNECT
  isolation, which already excludes templates.
- **Forged request context.** `clinical.claim.*` settings can be written by any role through `set_config`. The targets
  re-validate identities and memberships from rows, so the restricted role is still limited to messaging. Moving the
  context to a signed or locked form is a separate review.
