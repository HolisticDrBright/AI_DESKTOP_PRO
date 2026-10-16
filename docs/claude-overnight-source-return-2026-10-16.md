# Overnight source return to Codex — 16 October 2026

Source work only. No AWS write, Cognito change, SQL apply, provider activation, product or price creation, deploy,
main merge, PR, force-push or paid mobile build. PHI is off, billing and stores are blocked, Core is education-only,
and every clinical and source-verification hold stands. Fictional data only. **Source tests are not hosted, device
or human evidence, and nothing below says the apps are commercial or PHI ready.**

## 1. Heads

| Repo / branch | Base | Head | CI |
| --- | --- | --- | --- |
| Desktop `agent/desktop-readiness-integration-20261016` | — | `15339f18e915e8c5a16cf9332025973fdae8509c` | [38855030164](https://github.com/HolisticDrBright/AI_DESKTOP_PRO/actions/runs/38855030164) **success** (checked first) |
| Desktop `claude/desktop-overnight-source-20261016` | `15339f18` | the commit carrying this document; exact SHA and CI in the chat hand-back | exact-head run in the hand-back |
| V2 `claude/v2-local-data-integration-20261016` (source) | `2845ea4` + `b014117` | `e0c956ce2e8a9e338704e6d680ad22fccf1db7ae` | [38857842093](https://github.com/HolisticDrBright/AI_LONGEVITY_PRO_V2/actions/runs/38857842093) **success** |
| V2 same branch (kit rebind, metadata only) | `e0c956c` | in the chat hand-back | in the chat hand-back |

## 2. Commits by work package

- **WP1 (V2):** `e0c956c` is a deliberate merge of `b014117` onto `2845ea4`. It repairs the import budget, adds the
  guard and the two race cases. The kit rebind follows as a metadata commit. Details are in
  `docs/claude-v2-billing-local-data-integration-return-2026-10-16.md` on the V2 branch.
- **WP3 (Desktop):** `c7e1a178`, the care-messaging BLOCKED least-privilege credential candidate.
- **WP2 (Desktop):** `451b12ca`, the checked route inventory, the env-clinic fix and the pinned suspended-clinic gap.
  A follow-up commit fixes the inventory test's typing.
- **WP4:** this document.

## 3. Failing-before and passing-after

| Defect or claim | Test | Before | After |
| --- | --- | --- | --- |
| V2: in-test provider and screen imports from the local-data lineage (Windows timeout cascade) | `lab-photo-test-import-budget.test.ts` | 5 failed / 16 passed | 21/21; first-case time 2978→41 ms, 3000→36 ms, 1179→299 ms |
| V2: a pick during pending conversion (race, no defect) | `lab-picker-copy-journey.test.tsx`, 2 cases | n/a (new) | 2/2. Of 3 mutants, 2 are caught and 1 is covered by a second layer |
| Desktop: the env clinic was given to a session with no selection, in any runtime | `src/adapters/config.org-fallback.test.ts` | 4 failed / 3 passed | 7/7 |
| Desktop: suspended or archived clinic under legacy claims (gap, pinned, not closed) | `legacy-claims-clinic-status.database.test.ts` | — | 5/5, pinning the gap |
| Desktop: route inventory | `route-authority-inventory.test.ts` | — | 149/149 |
| Desktop: care-messaging credential candidate | `care-messaging-restricted-credential.database.test.ts`, `care-messaging-restricted-credential.test.mjs` | — | 42/42, 5/5 |

## 4. Status by level

| Item | Implemented | Local | CI | Hosted | Device | Human/provider approved |
| --- | --- | --- | --- | --- | --- | --- |
| WP1 V2 integration (5 invariants) | yes | yes: 3906 passed / 1 skipped; all gates | 38857842093 success | **no** | **no** | **no** |
| WP1 kit rebind (8 source accepted, 9 unobserved) | yes | launch check withholds; preflight refuses 51 | hand-back | **no** | **no** | **no** |
| WP2 route inventory | yes | yes | hand-back | **no** | n/a | **no** |
| WP2 env-clinic fix | yes | yes | hand-back | **no** | n/a | n/a |
| WP2 legacy suspended-clinic gap | **no, decision** | pinned | hand-back | **no** | n/a | **decision pending** |
| WP3 care-messaging credential | yes, BLOCKED | yes | hand-back | **no** (nothing created) | n/a | **no** |
| Billing: 7 positive store cases | no | no | no | **unobserved** | **unobserved** | **no** |

## 5. Candidates and activation state

All of these are BLOCKED. None is registered, applied, provisioned or deployed.

| Identity | SHA-256 (LF bytes) | State |
| --- | --- | --- |
| `infra/aws-clinical-core/source-candidates/care-messaging-qualification-login.sql` | `7936d0c536dd7224fe32a62489266da730f0202aac09dd30e7d5e466a4f19dac` | BLOCKED, NOLOGIN, not applied |
| `infra/aws-clinical-core/source-candidates/care-messaging-qualification-login-rollback.sql` | `1b04682b1d9a26ad828fa4ee580e53893d25930c5e845e1555bf1c3de11940eb` | BLOCKED, not applied |
| Proxy bodies: `set_request_context` / `request` / `resolve` / `export` | `23cb89c1…8215` / `99467cbd…2840` / `db7803d4…2330` / `16ae0d63…75c0` | bound in runtime and rollback |
| Restricted artifact (`npm run build:aws-care-messaging-restricted-credential`) | template and code hashes are in `artifact-manifest.json` from a clean build at the head (in the hand-back) | blocked, PHI off, qualification disabled, `deploymentPerformed: false` |

The earlier BLOCKED candidates are unchanged, and the V2 kit's mirror and candidate digests were re-checked against
this head: the bootstrap, operator listing, current-membership setter, discovery, fence guard, join-review,
qualification program boundary and program purchase families.

## 6. Code defects versus gates that are not code

**Repaired in source:**

- the V2 import budget;
- the Desktop env-clinic fallback.

**Open and needing a decision:**

- Legacy claims admit an already-selected session into a suspended or archived clinic. Option A is a BLOCKED SQL gate
  on clinic status; Option B is to require `database_current` before any suspension.
- The current-membership setter has no care-messaging proxy, so `database_current` is refused under the restricted
  credential.
- 26 inventory cells are `unverified`, and each is listed with what would settle it.

**AWS, hosted, device and human (not code):**

- the CONNECT isolation;
- schema registration;
- the restricted login and secret;
- hosted refusal tests;
- the matched deploy;
- the physical iOS/Android matrix;
- sandbox billing products and receipts;
- provider agreements and policies;
- PHI activation.

## 7. Codex AWS hand-back (dependency order; nothing here was executed)

1. **Qualification schema registration and rollback.** Register the reviewed qualification migrations (the 112
   ledger) and their preserving rollbacks on `clinical_core_qualification` only, by hash. Register the
   current-membership setter only after its own review; until then every `database_current` family answers 503 by
   design.
2. **Four-database CONNECT isolation.** Run the reviewed rehearsal's apply on the qualification cluster
   (`alp_chat_rls_synthetic_v1`, `clinical_core`, `clinical_core_qualification`, `postgres`). The care-messaging
   candidate refuses until no sibling database is reachable through PUBLIC.
3. **Care-messaging restricted credential:**
   - apply `care-messaging-qualification-login.sql` (hash above) as the owner of the four targets;
   - provision the secret `alp-qualification-care-messaging-api-db-*`;
   - only then `ALTER ROLE clinical_care_messaging_qualification_login LOGIN` with that secret's password;
   - audit the roles, the membership and the secret against the post-conditions;
   - deploy the restricted template from a clean build at the reviewed commit, still blocked;
   - run hosted refusal tests: the master secret is refused, the 18 unrelated functions are denied, and messaging works
     through the proxies.

   Rollback order: stop the Lambda → NOLOGIN → rollback SQL → delete the secret.
4. **The other seven qualification Lambdas.** They are still on the cluster-master secret. Repeat the pattern
   family by family; the program API has its own candidate already.
5. **Fictional hosted onboarding and role isolation.** Use fictional accounts only:
   - an unapproved self-sign-up gets zero clinical access;
   - a join request is approved by a clinic admin;
   - membership removal and clinic suspension refuse the already-issued session. Expect legacy to show the pinned
     suspended-clinic gap until the decision is made.
   - the operator console stays blocked;
   - a fixture env clinic is never present in a deployed runtime.
6. **Sandbox billing products and receipts.** Create sandbox (fictional) store products only after Brandon's
   approval, then observe the 7 positive cases. The blocked responses must stay `409 billing_not_activated` and
   `400 request_invalid` until activation.
7. **Matched candidate deploy.** Bind the Desktop and V2 heads from the hand-back; deploy the matched fictional
   candidates; record hosted observations against the kit index, never by the source runner.
8. **Physical iOS/Android matrix.** Run the 40 unfilled lab-file device rows, including Android 8 to 12, on a
   separately authorized build. No paid build is started from this work.
9. **Provider, agreements and policies.** HIPAA, BAA, retention, security review and store policies come from
   Brandon and counsel.
10. **PHI activation.** It comes last, and only after all of the above. Real-patient records immediately after clinic
    creation remain an owner preference, not a permission.

## 8. Graphify append text

```
2026-10-16 overnight (source only, Claude):
- V2 claude/v2-local-data-integration-20261016 e0c956c = merge b014117 onto 2845ea4. Repaired the lab test import
  budget (5 files; guard 5 failed before, 21/21 after). Added pending-conversion pick races. CI 38857842093 green.
  The kit rebind keeps 8 source accepted and 9 unobserved.
- Desktop claude/desktop-overnight-source-20261016:
  - c7e1a178: care-messaging BLOCKED least-privilege credential. NOLOGIN login→API role with 4 proxies; master
    secret refused before any client; 42 PGlite + 5 build cases.
  - 451b12ca: 262-route authority inventory (149 checks). Env-clinic fallback limited to the contract fixture
    (4 failed before). Legacy suspended-clinic gap pinned and awaiting decision.
- Nothing applied in AWS. PHI off, billing blocked, Core education-only.
```
