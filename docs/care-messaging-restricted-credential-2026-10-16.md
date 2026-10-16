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

## 6. Successor: `database_current` under the restricted credential (next source pass)

The blocker in §5 is now designed and source-tested, still BLOCKED. It is a new identity; the parent candidate and its
rollback are unchanged (`7936d0c5…9dac`, `1b04682b…40eb`).

**The design.** `infra/aws-clinical-core/source-candidates/care-messaging-qualification-current-context.sql` adds one
fifth proxy, `clinical_care_messaging_qualification.set_current_workforce_context(subject, clinic)`:

- It calls the unchanged current-membership setter with messaging's purpose fixed to `clinical_data`. The caller
  cannot choose a purpose.
- It is SECURITY DEFINER with an empty `search_path`, and owned by the setter's owner. So it runs with exactly the
  privileges the setter already runs with.
- The setter reads the subject's identity, person, clinic and membership from current rows and share-locks them for
  the operation's transaction. The bind and the message are therefore one decision: an admitted reply holds off a
  removal or suspension, and a reply waiting on one is refused.
- No role gains a membership, schema USAGE, table privilege, sibling-database CONNECT or the general clinical API
  role. The API role reaches five proxies and nothing else, and still cannot call the setter directly.
- The guards refuse unless both parents are exactly present: the four proxy bodies and the setter's prosrc
  `7054db76…6cd6`. The post-conditions repeat every reach check of the parent, with five proxies.

| Identity | SHA-256 (LF bytes) |
| --- | --- |
| `care-messaging-qualification-current-context.sql` | `eac6bba8b99976fcf6ed5bc56209259975b5eaf7767fb7cfc582d960fea0e4e2` |
| `care-messaging-qualification-current-context-rollback.sql` (drops the fifth proxy only) | `bab715073a39e9d110af54cfc2c9c8cbd81b0d328baf6f8c34cd9a24b56255e5` |
| fifth proxy body (prosrc) | `8b1de4471e95f7e3a5a8aea7a390e9c1d9a522cdf3eefd445fc5332d82f2e5be` |
| parent setter `workforce-current-membership-context.sql` (UNREGISTERED) | `ff89c1a2d5b934a3a49437099d14b34e5dffed400ae332f26eea2c311a891342`, prosrc `7054db763a6ff38b00a504a09398dcbd60f69b6476b6c85bab36da496d6e0cd6` |

**Runtime.**

- A new credential flag, `restricted_qualification_current`, accepted only with
  `CARE_MESSAGING_WORKFORCE_AUTHORITY=database_current`.
- The binding check covers 8 targets, the setter included (present but not executable by the role), and 5 proxies.
- The statement allow-list rewrites the setter call to the proxy only when its purpose is `clinical_data`.
- The parent `restricted_qualification` credential still refuses `database_current` with 503, by design.
- `npm run build:aws-care-messaging-restricted-current` writes a separate BLOCKED template. It uses the same bundle
  under a new identity, sets `CARE_MESSAGING_WORKFORCE_AUTHORITY`, and pins all four SQL hashes. The parent
  restricted template differs from the overnight build only in its pinned source commit.

**Construction order (repaired).** The exported factories `createRdsDataQualificationCareMessagingDatabase` and
`createRdsDataQualificationProgramDatabase` built their default RDS client in the parameter list, before the body
validated the configuration. So a refused secret, the cluster-master one included, already had a client. Building a
client sends nothing; that was always true. But the documented guarantee is "refused before any client exists".
Clients are now built only after validation.

- Failing before: `rds-data-care-messaging-factory.test.ts`, 8 failed / 3 passed.
- After: 11/11. The test counts constructions and sends separately.
- The Lambda handler already validated first and is unchanged.

**Evidence.**

| Test | Result |
| --- | --- |
| `src/server/clinical-core/care-messaging-restricted-current.database.test.ts` (112 + setter + parent + successor) | 21/21. Covers: the guards; exact five-proxy reach and 8 unrelated refusals; `database_current` read and reply; cross-clinic, removed membership, suspended clinic and consent withdrawal refused with nothing written; parent still 503; drift 503; the allow-list; the rollback chain. Without the successor: 2 failed, 7 never ran (journey setup refused with 503), 12 passed |
| `scripts/qualify-care-messaging-current-native.mjs` (PostgreSQL 16, two sessions through the restricted login) | 5 scenarios, 17 checks, all passed at `54a99ad3` (`docs/evidence/2026-10-16-care-messaging-current-native-54a99ad3.json`). An admitted reply holds off a membership removal; a reply waiting on a pending removal or a pending clinic suspension is refused with no row; a sibling clinic's practitioner cannot bind; the setter and a chart write are refused directly |
| `scripts/care-messaging-restricted-credential.test.mjs` | 6/6, the current-context template included |
| `cfn-lint` | both restricted templates lint clean |

**Codex steps (not executed; in order, after §4).**

1. Review and register the current-membership setter (`workforce-current-membership-context.sql`) by hash. The
   successor refuses until the setter is present, exactly, and owned by the applying role.
2. Apply `care-messaging-qualification-current-context.sql` as that owner, on `clinical_core_qualification` only.
   Audit the post-conditions.
3. Deploy the restricted-current template from a clean build at the reviewed commit, still blocked. Run hosted refusal
   tests: unrelated functions denied, the setter not directly callable, a removed member and a suspended clinic
   refused, and an in-flight removal waiting on an admitted reply.
4. Rollback order: set `CARE_MESSAGING_WORKFORCE_AUTHORITY` back to `legacy_claims` (or stop the Lambda), then run
   the current-context rollback. The parent's own rollback applies again afterwards.

**Ownership.** The proxy must be owned by the setter's owner, so whoever applies it must be that role. If the operator
cannot act as the setter's owner on Aurora, the successor refuses (`current_membership_setter_refused`). Messaging
then keeps the 503 under the restricted credential; that is the documented fallback, not a widening.
