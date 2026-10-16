# Next source return to Codex — 16 October 2026

Source work only. No AWS write, SQL application, Cognito change, production deployment, PHI activation, billing or
store activation, paid mobile build, main merge, PR or force-push. Core stays education-only, and every clinical and
source-verification hold stands. Fictional data only.

Codex's production observability change sets `review-data-api-audit-7b8cf85a-20261016` and
`review-core-billing-logs-f8d1cd11-20261016` were neither recreated, merged nor executed. Codex's Desktop branch
`agent/production-data-api-audit-exact-live-parent-20261016` and V2 branch
`agent/core-billing-exact-live-parent-candidate-20261016` were not merged.

**Source tests are not hosted, device or human evidence. Nothing below says either app is commercial-ready or
PHI-ready.**

## 1. Heads

| Repo / branch | Base | Head | Remote |
| --- | --- | --- | --- |
| Desktop `claude/desktop-next-source-20261016` | `88bd5d051d7cae417fa01805b9d1b9d37ed70061` (CI 38862137704, passed on attempt 2) | the commit carrying this document; exact SHA and CI in the chat hand-back | pushed, matches |
| V2 `claude/v2-local-data-integration-20261016` | `ac621a1c720db16b37e7245b3e3e63f39992a811` (CI 38865161235, passed) | **unchanged** (§6) | matches |

## 2. Commits by work package (Desktop)

| WP | Commit | What |
| --- | --- | --- |
| 1 | `faee52be` | BLOCKED successor `legacy-claims-clinic-status.sql`: the legacy request context refuses a workforce clinical-data or identity-linking request into a clinic that is not active, share-locked in the operation's transaction. Preserving rollback; 12 PGlite cases; a two-session native qualification of both authority modes |
| 2 + 3 | `fce7d5af` | Sibling-clinic refusals through the restricted proxies; the care-message and telehealth-visit cells settled; the calendar gap pinned |
| 2 | `54a99ad3` | BLOCKED current-context successor for restricted care messaging (a fifth proxy). The restricted-current build. Factory clients constructed only after validation |
| 3 | `d7661441` | Fullscript routes re-read the account's clinics, bind the token's email, and complete OAuth only in the starter's session |
| 4 | `b18ed9f9` | Lens add-to-note no longer waits on the evaluation re-read. An insertion belongs to its note, once. Start after a Start-created note opens a new note |
| 3 | `e946aa0a` | The remaining cells settled path by path. Lab documents refuse under clinic-membership sign-in |
| 5 | `14cc2e46` | Docs, native evidence files, the inventory decision-text correction |
| 5 | `a8e79ca7` | The native qualification harnesses wait for psql's errors as well as its stdout marker (§3, last row) |
| 5 | this document's final commit | Gate results, the superseding native evidence at `a8e79ca7`, the browser battery |

## 3. Failing-before and passing-after

| Defect or claim | Test | Before | After |
| --- | --- | --- | --- |
| A session already in a suspended or archived clinic keeps creating patients (legacy) | `legacy-claims-clinic-status-successor.database.test.ts` | without the successor: 6 failed / 5 passed | 12/12 with it |
| Suspension before admission, during a lock wait, stale context, cross-clinic, both modes | `scripts/qualify-clinic-status-native.mjs` (PostgreSQL 16, two sessions) | the parent admits after suspension (scenario 1 pins it) | 8 scenarios, 34 checks passed (`docs/evidence/2026-10-16-clinic-status-native-fce7d5af.json`) |
| Restricted care messaging could not run `database_current` (503) | `care-messaging-restricted-current.database.test.ts` | without the successor: 2 failed, 7 never ran, 12 passed | 21/21 |
| In-flight membership change and suspension through the restricted login | `scripts/qualify-care-messaging-current-native.mjs` | — | 5 scenarios, 17 checks (`docs/evidence/2026-10-16-care-messaging-current-native-54a99ad3.json`) |
| The factory built a client before rejecting an invalid secret | `rds-data-care-messaging-factory.test.ts` | 8 failed / 3 passed | 11/11 |
| Fullscript: a removed or suspended member, an edited email cookie, another account's OAuth callback | `src/app/api/live/fullscript/clinic-authority.test.ts` | 12 failed / 3 passed | 15/15 |
| Lens add-to-note waited on the evaluation re-read (the CI failure at `live-lens.spec.ts:222`) | the spec, with the evaluation GET held | old code fails at the CI's own assertion with the CI's own received value | 9/9 |
| An insertion replayed into a later note | the same spec | received the signed note's question text in a new note | 9/9 |
| Start after a Start-created note did nothing | the same spec | `toBeEditable` timed out (the signed composer stayed) | 9/9 |
| Under `database_current`, lab upload and the original-document read sent the token to the transitional host | `src/server/legacy-backend-routes.test.ts` | 1 failed / 5 passed (200; token sent) | 6/6 |
| Route inventory | `route-authority-inventory.test.ts` | 15 unverified | 157/157; 5 unverified |
| A native harness could resolve a command before reading its error (two pipes) | `scripts/native-psql-session.test.mjs` | 0 passed / 2 failed (a refusal returned with an empty error) | 2/2; all five harnesses share the one sender |

**The live-lens failure.** On CI run 38862137704's first attempt, the server's event-loop delay peaked at 2.2–2.5 s
and its heap reached 3.45 GB. CPU load alone (0, 8 and 16 busy loops) did not reproduce the stall; latency stayed
at or below 562 ms. The rerun passing was never treated as a cause. The mechanism is the ordering: the note text
waited on a read that only refreshes the question. One variant run failed its first test with the patient layout's
"Page not found"; the identical rerun did not. That was observed once and is recorded undiagnosed, not called a flake
(`docs/evidence/2026-10-16-live-lens-add-to-note.json`).

**The harness race.** The five native two-session scripts treated a psql command as finished when its `\echo` marker
appeared on stdout. psql writes errors to stderr, a separate pipe, so under load the marker could be read first. The
clinic-status run at `14cc2e46`, during a concurrent clinical build, recorded one check as failed: "a practitioner of
clinic B only cannot write into clinic A ()", with an empty error. The script and SQL were unchanged since the clean
pass at `fce7d5af`, and the SQL refuses that write deterministically.

The same race could let a "no error" check pass on nothing. The earlier records (`fce7d5af`, `54a99ad3`, and the base's
`80c807c9`) came from the racy harness. The sender now waits for a `\warn` marker on stderr as well.

All five harnesses were rerun on the clean tree at `a8e79ca7`; these records supersede the earlier ones:

| Harness | Scenarios | Checks | Failed |
| --- | --- | --- | --- |
| clinic status | 8 | 34 | 0 |
| restricted care messaging | 5 | 17 | 0 |
| workforce bootstrap | 8 | 35 | 0 |
| current authority | 3 | 11 | 0 |
| onboarding | 7 | 31 | 0 |

Three CPU-loaded runs of the old harness did not reproduce the race; it is rare, and the module test reproduces it
deterministically. The records are `docs/evidence/2026-10-16-*-native-a8e79ca7.json`.

## 3a. Full suites and gates (local, at `e946aa0a`; harness and docs commits after it change no application code)

| Gate | Result |
| --- | --- |
| `tsc --noEmit` | pass |
| `npm run lint` | pass; 1 warning, pre-existing at the base (`scripts/build-qualification-program-api.mjs`, unused `fileURLToPath`) |
| `npm run test:unit` | 650 files, **10038 passed, 11 skipped, 0 failed**. The skips: 9 patient-sync bridge round trips (they need a V2 checkout at `ALP_DIR`) and 2 governed-catalog seed checks (they need a real catalog source directory) |
| `test:aws-care-messaging-restricted-credential` | 6/6 |
| clean `build:clinical` (`.next` removed first) | pass |
| `check:clinical-bundle` | PASS: 351 client chunks, no synthetic identity, no demo-only copy, none of the 21 server-only markers |
| restricted and restricted-current builds + `cfn-lint` 1.57.2 | pass; `deploymentPerformed: false`, PHI off, blocked, qualification disabled |
| `test:native-psql-session` | 2/2 (at `a8e79ca7`) |
| native two-session harnesses | five of five, at `a8e79ca7` (above) |
| browser order battery, forward and reverse | in the chat hand-back |

## 4. The 26 route-authority cells

Of the 26 unverified at `88bd5d05`, **21 now carry path-specific executable evidence and 5 remain unverified**. Every
change cites a test of that path; none is a relabel. One cell moved the other way: the transitional lab-document
unapproved-account cell had cited a test of `resolveOrgId`, which those routes never call, so it went from `refused`
to `unverified`. Details are in `docs/desktop-onboarding-authority-2026-10-16.md` §6.

**Still unverified:**

1. `transitional_lab_documents / legacy_claims / unapproved_account`
2. `transitional_lab_documents / legacy_claims / suspended_clinic`
3. `transitional_lab_documents / legacy_claims / removed_membership`
4. `transitional_lab_documents / legacy_claims / stale_token`

   For 1–4, the transitional host at `TRPC_BASE_URL` (deployed as `DEPLOYED_TRPC_BASE_URL`) decides with the bearer
   token alone and lives outside this repository. The Desktop sends it no clinic (pinned). Settling these needs that
   host's own suite, or a hosted probe with the four kinds of account.
5. `unconverted_claims_families / legacy_claims / removed_membership`. Pinned refused: recording participants,
   recording cleanup, lab attestation review and clinic records. Privacy operations follow the operator assignment.
   Not yet pinned: recording capture, drafting and transcription; calendar connection; notification settings;
   workforce Ask ALP; consult links, requests, retention, disputes, outcomes, carts, note templates and intake. These
   are source-testable, not a hosted dependency.

**Gaps (decision required):**

- `compatibility_rpc`, `telehealth_visits` and `unconverted_claims_families`, under legacy claims, for a suspended
  clinic. The BLOCKED successor closes all three.
- `synthetic_identity_boundary`, under legacy claims, for a suspended clinic. Invitations still issue in a suspended
  synthetic clinic (fictional data); the production successor does not reach that schema.

Counts across 19 families: refused 57, refused_disabled 48, gap 4, token_lifetime 18, not_applicable 20,
unverified 5.

## 5. BLOCKED candidates

None is registered, applied, provisioned or deployed. Hashes are SHA-256 of LF bytes.

| Identity | SHA-256 | Notes |
| --- | --- | --- |
| `legacy-claims-clinic-status.sql` | `c3788dc20bed9fe6aae40cc939a08a69773d45d56dc297dea21ae99ed6c7cc66` | parent prosrc `36d00be9…d0ea`; successor prosrc `4187ce78…201b` |
| `legacy-claims-clinic-status-rollback.sql` | `4c311c01148367b82d58e2143c2cce6f21f391fa04d50f1f21e27935224b29a0` | restores the parent byte for byte |
| `care-messaging-qualification-current-context.sql` | `eac6bba8b99976fcf6ed5bc56209259975b5eaf7767fb7cfc582d960fea0e4e2` | fifth proxy prosrc `8b1de447…2be5`; a new identity |
| `care-messaging-qualification-current-context-rollback.sql` | `bab715073a39e9d110af54cfc2c9c8cbd81b0d328baf6f8c34cd9a24b56255e5` | drops the fifth proxy only |
| `care-messaging-qualification-login.sql` (prior, unchanged) | `7936d0c536dd7224fe32a62489266da730f0202aac09dd30e7d5e466a4f19dac` | |
| `care-messaging-qualification-login-rollback.sql` (prior, unchanged) | `1b04682b1d9a26ad828fa4ee580e53893d25930c5e845e1555bf1c3de11940eb` | |
| `workforce-current-membership-context.sql` (prior, UNREGISTERED) | `ff89c1a2d5b934a3a49437099d14b34e5dffed400ae332f26eea2c311a891342` | prosrc `7054db76…6cd6` |

The restricted and restricted-current artifact hashes come from a clean build at the final head (chat hand-back).
Both carry `deploymentPerformed: false`, PHI off, activation blocked and qualification disabled.

## 6. V2

No V2 change was required:

- Every mirror and candidate digest in V2's launch-acceptance index, 6 mirrors and 25 candidates, still matches the
  Desktop head byte for byte. The digests were re-hashed from `git show HEAD:` in the Desktop worktree.
- At `ac621a1c` the launch check still **withholds**: 8 source cases accepted, 9 hosted, device and human cases
  unobserved.
- The release preflight still **refuses** with 51 missing values. None was filled from source results.

The kit's `desktopCommit` remains `88bd5d05`, the commit its digests were taken at. A rebind is metadata-only and is
for when Codex binds a matched pair.

## 7. Status by evidence level

| Item | Implemented | Local | CI | Hosted | Device | Human/owner |
| --- | --- | --- | --- | --- | --- | --- |
| WP1 clinic-status successor | yes, BLOCKED | yes, PGlite + native two-session | inside `54a99ad3`'s success (`faee52be` and `fce7d5af` were pushed with it and had no run of their own) | **no** | n/a | **decision pending** |
| WP2 restricted current context | yes, BLOCKED | yes, PGlite + native | `54a99ad3` success | **no** | n/a | **no** |
| WP2 factory construction order | yes | yes | `54a99ad3` success | **no** | n/a | n/a |
| WP3 Fullscript authority | yes | yes | `d7661441` success | **no** | n/a | **no** |
| WP3 lab-document refusal | yes | yes | `e946aa0a` success | **no** | n/a | n/a |
| WP3 remaining cells | evidence only | yes | `e946aa0a` success | **no** | n/a | n/a |
| WP5 native harness race | yes | yes, five harnesses at `a8e79ca7` | hand-back | n/a | n/a | n/a |
| WP4 lens add-to-note | yes | yes, spec 9/9 | `b18ed9f9` success, attempt 1 | **no** | n/a | n/a |
| Launch acceptance (V2) | — | withholds 8/9 | — | **unobserved** | **unobserved** | **unobserved** |

## 8. Source defects versus gates that are not code

**Repaired in source:**

- Fullscript clinic authority;
- the lab-document token leak under `database_current`;
- the factory construction order;
- the three lens add-to-note defects;
- the native harness error race.

**Open and needing a decision:**

- Apply the clinic-status successor, or require `database_current` before any suspension. A residual remains even
  with the successor: a practitioner's own `consent_management` requests stay open under legacy, because the function
  cannot tell a service identity from a practitioner.
- The synthetic boundary's suspended-clinic gap.

**Open in source:**

- unconverted removal, the subfamilies listed in §4;
- the "Page not found" observation;
- the pre-existing lint warning in `scripts/build-qualification-program-api.mjs`, already present at the base.

**AWS, hosted, device and human (not code):**

- registration of the setter and both successors;
- CONNECT isolation;
- the restricted logins and secrets;
- hosted refusal tests;
- the transitional host's own authority;
- a matched deploy;
- the physical iOS/Android matrix;
- sandbox store products;
- provider agreements;
- PHI activation.

## 9. Ordered Codex hand-back (nothing here was executed)

1. **Review and decide the clinic-status successor.** If it is applied, apply `legacy-claims-clinic-status.sql` by
   hash to `clinical_core_qualification` first, as the owner of `set_request_context`. Rehearse the rollback. Run the
   native qualification (`npm run qualify:clinic-status-native`) against the rehearsal cluster's PostgreSQL. Otherwise,
   record that `database_current` must precede any clinic suspension.
2. **Register the current-membership setter** (`workforce-current-membership-context.sql`) by hash, after its own
   review. Every `database_current` family answers 503 until then, by design.
3. **Run the CONNECT isolation, then the care-messaging login candidate** (the existing hand-back,
   `docs/care-messaging-restricted-credential-2026-10-16.md` §4).
4. **Apply the current-context successor** as the setter's owner, then deploy the restricted-current template, still
   blocked. Run hosted refusals: unrelated functions denied; the setter not directly callable; a removed member and a
   suspended clinic refused; an in-flight removal waiting on an admitted reply. Rehearse with the fixed native
   harness (`a8e79ca7` or later); records from before that commit could carry a vacuous "no error" check.
5. **The transitional host.** Either retire lab upload and the original-document read from `TRPC_BASE_URL`, or run its
   own refusal suite for an unapproved account, a suspended clinic, a removed member and an already-issued token.
6. **Fictional hosted onboarding:**
   - an unapproved self-sign-up gets zero access;
   - Fullscript refuses a removed member;
   - suspension behaves as the decision in step 1 says.
7. **Matched candidate deploy, rebind of the V2 kit to the matched pair, then the physical device matrix.** Observe
   the 9 unobserved cases with their own observers, not the source runner.
8. **Provider agreements and policies, then PHI activation, last.**

Possible textual conflicts when merging with Codex's branches: `package.json` and `.github/workflows/ci.yml`. This
branch adds scripts and CI steps in both.

## 10. Six-phase ledger cross-check

`handoffs/six-phase-readiness-baseline-2026-10-13.md` (read from the copy supplied with the handoff; it lives in Codex's
workspace, not this repository) is unchanged, and so is its completion standard. This work adds
source and CI evidence only to items:

- 2D (Desktop capture: scribe routes refused on deployments);
- 3B (privacy operations bound to their assignment);
- 4B (delivery under current membership, restricted messaging);
- 5C (provider and payment: Fullscript authority);
- 6B (security checks: route inventory);
- 6G (Desktop tabs: lens add-to-note).

None of the 26 items closes.

## 11. Graphify append text

The map was not reachable from this session, so this is text to append; no canvas was updated.

```
2026-10-16 next source pass (Claude, source only) — Desktop claude/desktop-next-source-20261016 from 88bd5d05:
- faee52be: BLOCKED legacy-claims-clinic-status successor (c3788dc2…); suspended/archived clinics refused for workforce
  clinical_data and identity_link in the operation's transaction; native two-session qualification 8 scenarios.
- 54a99ad3: BLOCKED care-messaging current-context successor (eac6bba8…), a fifth proxy, so database_current can run
  under the restricted credential; factory clients built after validation (8 failed before).
- d7661441: Fullscript clinic authority (12 failed before).
- b18ed9f9: lens add-to-note no longer waits on the evaluation re-read; inserts addressed to their note; Start fixed.
- e946aa0a: 21 of 26 unverified route cells settled with path tests; lab documents refused under database_current.
- V2 unchanged at ac621a1c: launch acceptance withholds 8/9; preflight refuses 51. Nothing applied in AWS.
```
