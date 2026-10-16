# Clinic continuity and Core release safety: the return

**Date:** October 16, 2026

This pass was source engineering plus local and CI verification only. None of the following happened:

- AWS writes;
- SQL registration or application;
- provider calls (Cognito, Fullscript);
- production activation or PHI;
- store products or paid mobile builds;
- a `main` merge, force-push or PR.

Every new SQL candidate and every release switch is **BLOCKED**. Commercial and PHI readiness remain withheld.

The evidence comes in four classes, never merged:

| Class | What it is |
| --- | --- |
| **PGlite** | In-process PostgreSQL on the real migration chain. |
| **native** | A disposable local PostgreSQL 16 cluster with two real sessions. |
| **unit** | Fictional boundaries. |
| **CI** | GitHub Actions on the exact head. |

Nothing here is hosted evidence. Every hosted, device, provider and human case is still unobserved.

## 0. Heads and verification

The final heads, their clean-tree and remote-match checks, and their exact-head CI are in §11. That section is written
last.

| Repo | Branch | Started from |
| --- | --- | --- |
| Desktop | `claude/desktop-continuity-integration-20261016` | `93816f99` (CI 38970823511) |
| V2 | `claude/v2-continuity-integration-20261016` | `a7139981` (CI 38968313123) |

## 1. WP1: the source lines, reconciled

All merges keep both histories (merge commits, nothing rewritten).

### Desktop

| Merged | Codex CI | Overlap with the Claude line | Pinned candidates or contracts changed |
| --- | --- | --- | --- |
| `f599a8a2`, the qualification line (12 commits past the merge base `e08df97f`, including `51a7317d`, `62207e4b`, the operator-pool verifier `6ad788ff`, the operator identity and reader-policy candidates, and the fictional program preflight `c24c5e87`, `9eb40908`, `f599a8a2`) | 38971310243 success. `9eb40908` alone failed; its successor `f599a8a2` passed. | `package.json` only, in disjoint hunks. | None. |
| `eeb4223e`, the event-order successor | 38974061201 success, observed **before** the merge. The packet's hold was respected. | None. | None. The candidate is unchanged and stays **separate and BLOCKED**: hashes `a03d96ed…`, rollback `c7b4ba07…`, listing parent `5a7af23d…`. Bootstrap DB test 24/24. |
| `0beb5d52`, Codex's latest integration (the audit-review line `48ffc284`..`4dc8213e`, merged with the earlier Claude head `93816f99`) | Recorded in §11. Merged only after its exact-head CI. | `.github/workflows/ci.yml`: both sides appended to the same step list, resolved as their union. `package.json` merged cleanly. | None. It adds only audit-review scripts, their tests and two docs. |

`e08df97f` (Codex's Fullscript callback fence) is included. It is an ancestor of `93816f99` and was merged at `b56e3bb0`.

Codex's review items:

- **The operator-pool verifier (`6ad788ff`)** reads the authoritative Cognito MFA configuration. It is read-only, and
  its tests passed after the merge.
- **The fictional program preflight (`c24c5e87` / `f599a8a2`)** binds the update preflight to the deployed fictional
  execution flag. It is read-only, with no candidate change.
- **The event-order successor (`eeb4223e`)** is reviewed, merged, and left BLOCKED. It is not counted as activated.

### V2

| Merged | Codex CI | Result |
| --- | --- | --- |
| `bb80340a`, the source-qualification line (merge base `ac621a1c`; 17 ahead, 1 behind) | 38968790739 success | Clean. It does not overlap `a7139981`. |
| `be1b9e5`, the Fly synthetic source provenance (on neither line) | 38942696055 success | Only source-pair metadata conflicted (`index.json`, `manifest.json`, `launch-acceptance.test.mjs`), resolved to Codex's binding. The Fly branch index is kept as `index-2026-10-16-fly-source-provenance-branch.json` (SHA-256 `810a7aed97c1e311387b8e73fc80121deb51653047226a31109e342e8f818b65`). Both predecessors were identical (`dfd11e98…`). |
| `488c9003`, Codex's latest integration (the same `a7139981` merge, test-setup stabilization, a kit rebind) | Recorded in §11 | Recorded in §11. |

Retained:

- the education-only Core holds;
- the launch-kit predecessor chain;
- the billing observability candidates;
- the Fly work;
- Claude's existing-data repairs G1, G3 and G4.

Tests run before any digest was rebound: launch 22/22, preflight 10/10, billing observability 19/19, harness 9/9, Fly
4/4. The full suite after both merges passed: 348 files, 3,914 tests, 1 skipped.

## 2. WP2: the emergency practitioner-login revocation (BLOCKED)

`infra/aws-clinical-core/source-candidates/workforce-identity-emergency-revocation.sql` and its preserving rollback.

**The event.** This is a decision about one workforce **identity**, not a clinic suspension. A recorded, reasoned
operator decision sets that identity to `disabled` in every clinic at once. The clinic is untouched. It deletes no
identity, patient, membership, consent or audit record. Already-issued tokens stay valid by signature, but every
protected request is refused immediately: the database reads the identity row on each request.

### The failing-before

Run on the deployed schema (PGlite, `as deployed: a sole owner whose login is suspected compromised`):

1. The already-issued session reads, writes and records a consent decision.
2. Nothing deployed can stop it:
   - no membership removal reaches a sole owner;
   - no function writes a workforce identity;
   - a clinic suspension would end every colleague's session with it.

There is also a **native** failing-before (`alp_unlocked`). On the deployed entry, a revocation commits while an
admitted request is still running. The request's write lands after the revocation's receipt, so "revoked at time T"
would be false.

### Entry change

`clinical_private.set_request_context` gains one `FOR SHARE` on the workforce identity row. Nothing else changes. The
candidate refuses any parent but the deployed prosrc `36d00be9…`, and the post-check pins the successor at `3ee98d29…`.

This has two effects:

- The revocation's `FOR UPDATE` waits for admitted requests to finish.
- A request queued behind a pending revocation re-reads the row and is refused.

The candidate and the clinic-status successor (`legacy-claims-clinic-status.sql`, prosrc `4187ce78…`) each refuse the
other as parent, so they never stack.

### Authority

- **Callers.** Only the MFA-protected platform operator: the `clinical_workforce_operator` role, an operator registry
  row, and the separate operator sign-in with its 15-minute `auth_time`. A practitioner or applicant connection has no
  EXECUTE.
- **Refused.** An operator's own workforce login, an unregistered or retired operator, and a malformed reason.
- **Approval.** A release row starts `enabled=false` with no mode. The table owner chooses one of two modes, and this
  stays a release decision:
  - `second_operator_before`: nothing changes until a different operator approves;
  - `independent_review_after`: the decision takes effect at once, and a different operator reviews it.
- **Disputes.** A dispute never restores a login. Restoring is WP3's replacement route, never a re-enable.

### Provider

`createCognitoWorkforceIdentityProvider` calls `AdminDisableUser` and then `AdminUserGlobalSignOut`, on the workforce
pool only. It is idempotent and returns closed failure codes.

- The database refusal comes first and never waits on the provider.
- Each provider step is recorded (append-only, no tokens or credentials).
- A failed step stays actionable on the work list until `reconcile` completes both steps.
- Nothing calls Cognito, and no IAM grant is created.

### The cases covered

| Evidence | Cases |
| --- | --- |
| PGlite 24/24 | The deployed failing-before (3). The candidate's pin, parent guard, EXECUTE and off state. Both approval modes: disables in every clinic; an unrelated practitioner, the admin and the patient untouched; retries converge on the request id; a conflicting retry changes nothing; the review needs a different operator; a dispute never restores; provider failure stays actionable; append-only even for the table owner. With the BLOCKED membership-fence guard. The service over the DB with a fictional provider: provider down, delayed answer, fence missing, approval path. The rollback. The bare production artifact refused. No read-only transaction calls the entry. |
| Unit | Service 6, console +4, routes +3. |
| Native 8 scenarios, 33 checks (`docs/evidence/2026-10-16-emergency-revocation-native-938ce20f.json`, clean tree) | `alp_unlocked` failing-before; admitted read holds off the revocation; a request waiting on a pending revocation is refused; write versus revocation in **both** orders; current authority and another clinic refused; an unrelated practitioner not held back; retried revocation converges; an approval waits for an admitted request. |

### Console and routes

- The operator console routes are wired: GET/POST `/clinical-core/platform-operator/identity-revocations` and POST
  `…/decision`.
- Desktop proxies them through `/api/operator/identity-revocations`, behind the `aidp_op` cookie.
- With no revocation service supplied (the default), they answer not released.
- The candidate is not activated, so there is **no hosted revocation**, and nothing here claims one.

### Route families (`src/server/route-authority-inventory.ts`, new case `compromised_identity`)

Each cell cites a test. Read from the inventory itself.

| Family | Packet's name for it | legacy_claims | database_current |
| --- | --- | --- | --- |
| `compatibility_rpc` | chart, inbox, billing, plans, programs, labs | refused | refused |
| `unconverted_claims_families` | exports and privacy operations, clinic records, recording, Ask ALP, lab attestation | refused | refused_disabled |
| `care_messages` | messaging | refused | refused |
| `program_assignments` | programs | refused_disabled | refused |
| `program_media` | programs (media) | refused_disabled | refused_disabled |
| `telehealth_calendar`, `telehealth_visits` | telehealth and its consent | refused | refused |
| `fullscript_connection` | provider routes | refused | refused |
| `transitional_scribe` | scribe consent and recording | refused_disabled | refused_disabled |
| `transitional_lab_documents` | lab upload and documents | **unverified** (source deleted from V2 at `b2850a2`) | refused_disabled |
| `sign_in_and_clinic_choice` | sign-in, refresh, clinic step | refused | refused |
| `workforce_join_review` | membership admin | refused_disabled | refused_disabled |
| `synthetic_identity_boundary` | synthetic posture and invites | token_lifetime | refused_disabled |
| `governed_catalog` | catalog read (no patient data) | token_lifetime | token_lifetime |
| `applicant` | applying (checks Cognito `Enabled`) | token_lifetime | token_lifetime |
| `platform_operator` | operator console | refused_disabled | refused_disabled |
| `campaigns` | provider route (SES marketing) | **gap** | **gap** |
| `learner`, `no_clinical_authority` | consumer and public | not_applicable | not_applicable |

**The gap is campaigns.** The engine authorizes staff from token claims and its own role grant, never from the identity
row. A revoked login keeps campaign staff access (the practice's contacts, sequences and broadcasts) until the ID token
expires, and through refresh until Cognito disables the user. It is pinned by `src/campaigns/events-and-routes.test.ts`
"GAP pinned: a practitioner login revoked…". The decision is Brandon's, with Codex.

`token_lifetime` means access lasts until the token expires. No patient data is behind those cells.

**Totals over all five cases:** 190 cells.

| Result | Cells |
| --- | --- |
| refused | 72 |
| refused while disabled | 60 |
| token lifetime | 23 |
| not applicable | 24 |
| gap | 6 |
| unverified | 5 |

Suite 195/195.

The six gaps:

- legacy suspended-clinic cells in the compatibility RPC, the synthetic boundary, the telehealth visits and the
  unconverted families (recording);
- the two campaigns cells above.

**Paths that never read identity status:**

- campaigns;
- the legacy posture read;
- the synthetic catalog host;
- telehealth `listVisits` with zero visits, which returns an empty list without touching patient data;
- the applicant and operator APIs (Cognito `Enabled`);
- the blocked pre-token trigger.

## 3. WP3: the lawful recovery route (BLOCKED, disabled)

`infra/aws-clinical-core/source-candidates/workforce-identity-recovery.sql`. Its parent is the revocation candidate, and
it has a preserving rollback.

### Replacement credential

- **Offered only** for a revoked login, under a stated verification method, to a replacement account the provider
  reports enabled, confirmed and TOTP-enrolled (`replacementAssurance`, read from `AdminGetUser`, never from the
  browser), on an unused subject.
- **Approval.** It needs an approver on the roster who did not propose it.
- **Once approved**, the practitioner signs in with the new account in every clinic.
- **The old subject** is retired for good. A trigger on identities and the directory refuses any rebind, retry or new
  account with that subject, even by the table owner. The rollback keeps that guard.

### Custodial access

- Read-only.
- One named patient, time-bounded (at most `custodial_max_hours`, 1 to 168).
- Independent approval.
- Each read is logged by ids only, in an append-only log.
- It returns the patient record's fields and leaves the record unchanged.

### Release decisions (`WORKFORCE_IDENTITY_RECOVERY_RELEASE_DECISIONS`)

**Nothing runs** until the owner records all of these:

- the verification method;
- the approver roster (empty);
- the retention policy;
- the longest grant;
- whether a custodial read may cover more than the patient record.

Nothing here invents an identity proof.

### Evidence (PGlite 11/11, unit 2/2)

- **Required:**
  - it needs the revocation first;
  - nothing runs before the release decisions.
- **Recovery offer:**
  - recovery is offered only under every precondition;
  - it needs an approver who is not the proposer;
  - after recovery, the old subject is refused for good, with no rebind path, even for the table owner;
  - a declined recovery leaves the login disabled.
- **Custodial access:**
  - **the compromised login stays refused while an approved custodian reads the same fictional patient file**;
  - another patient, another clinic, another operator, an unapproved grant and an expired grant are all refused;
  - reads are logged by ids only.
- **Rollback:** it preserves every record.
- No clinic status was changed in any test.

## 4. WP4: ordinary suspension is not emergency revocation

`src/server/clinical-core/ordinary-suspension-continuity.database.test.ts` runs PGlite on the real 106-migration
schema: 5 stages × 6 rows = 30/30. The stages are every combination of BLOCKED candidates that can exist. The
clinic-status successor and the revocation never stack.

| Row | As deployed | Clinic-status successor (owner ruled out) | Clinic-status + consent-decision | Emergency revocation | Revocation + consent-decision |
| --- | --- | --- | --- | --- | --- |
| A session from before an ordinary suspension, and a sign-in or refresh after it | Both admitted, identically | Both closed, identically | Both closed | Both admitted | Both admitted |
| The entry takes a token time; the clinic records when it was suspended | **No / no** | **No / no** | **No / no** | **No / no** | **No / no** |
| A suspected compromised identity | No writer exists; only a table-owner update refuses it | Same | Same | One operator decision refuses the next request; the clinic stays `active` | Same |
| The patient's own grant and withdrawal in a suspended clinic | Run | Run | Run | Run | Run |
| A practitioner-recorded grant and withdrawal in a suspended clinic | Admitted | Admitted | Refused (D2 undecided) | Admitted | Refused (D2 undecided) |
| Retention, recording cleanup and legal hold in a suspended clinic | Retention runs; cleanup and hold refused (D3, D4) | Same | Same | Same | Same |

**MISSING CONTRACT: no continuity successor was built.** The owner's rule is "until its expiry, no refresh extension,
no bypass of revocation". It cannot be enforced from current authority data, for two reasons:

- **No time in the call.** Every legacy request reaches the one 7-argument `set_request_context`, called from about 50
  sites with no shared helper, with person, clinic, pool, subject, purpose, environment and classification. None of
  these is a time.
- **No time on the clinic.** An ordinary clinic records no time it was suspended: no column, no status ledger.

So the database cannot tell a session from before the suspension from a sign-in or refresh after it. Any successor
built today would either let both continue or end both.

The missing contract has three parts:

1. the token's `auth_time` (or the original sign-in time) and `exp`, passed by every caller through one shared entry;
2. a recorded `suspended_at` on the clinic;
3. a rule: admit only when `auth_time < suspended_at` and now < `exp`, with refresh tokens revoked at suspension
   (Cognito cannot be relied on to refuse a refresh while the user stays enabled).

Revocation (WP2) still overrides all of it. This is reported, not built. D1 to D5 are not decided by implication.

The policy's other half holds in source when the BLOCKED consent-decision successor is applied: an ordinary suspension
blocks new practitioner consent decisions, and the patient's own decisions stay open.

## 5. WP5: Fullscript residuals (no ordering)

### Membership generation (`src/server/fullscript/membership-generation.ts`)

**The generation.** A saved connection is bound to `fullscript-generation/1`: the subject and clinic fence versions
recorded at install (an absent fence counts as 0). These are compared on every use (`connectionIsCurrent`), in the
posture read and before any client is built.

**When the generation differs:**

- **A connection made under authority since reduced** is never used again: not after a re-add, not after a clinic
  reinstatement, not after a refresh. It moves, whole, into a revocation outbox item
  (`FULLSCRIPT_REVOCATION#<actorKey>#<connectedAt>`) in one TransactWrite: a Delete on the exact payload plus a
  conditional Put. The practitioner sees "reconnect required".
- **A connection saved before generations existed** fails closed the same way.
- **While a fence is changing**, nothing is used and nothing moves.

**Release unit.** The install fence, the BLOCKED fence guard and its writer, the fence table and these permissions are
one release unit. Without `FULLSCRIPT_MEMBERSHIP_FENCE_TABLE`, a connection is not used at all.

### Reconciliation

- **Provider revocations.** `reconcileFullscriptRevocations` calls the provider. A failure stays pending, with its
  attempt counted. Success leaves a receipt without the token.
- **Legacy email-keyed rows.** `inventoryFullscriptConnections` classifies them by key alone and reports fingerprints,
  never a key, subject, email or token. `executeReviewedFullscriptReconciliation` refuses an unreviewed or stale plan.
  A reviewed plan moves each unbound row unchanged. It never claims or re-keys a row.

### Evidence (unit)

**Route level (9 tests):**

- **failing-before:** a connection removed, then re-added, saved with no generation, was used again;
- a removal followed by a re-add;
- a reinstated clinic;
- the status read;
- a change in flight;
- a refresh that never carries a superseded connection or rewrites a generation;
- **`create_lab_checkout` refused with `FULLSCRIPT_LAB_ORDERING_ENABLED` and `FULLSCRIPT_PRODUCTION_APPROVED` forced
  on**, before any token is used.

**Module (8 tests):**

- the generation;
- the strongly consistent read;
- the transactional move;
- **both race orders** (a refresh first, a supersede first);
- reconciliation success and failure;
- the fingerprint inventory;
- the reviewed plan.

**Suites:** Fullscript plus inventory, 1,107/1,107.

**Hosted sandbox probes are returned to Codex (§9), not marked passed.**

## 6. WP6: V2 on the reconciled branch

Details are in V2 `docs/claude-continuity-core-release-2026-10-16.md`.

### A production build fails closed

A production clinical build fails closed unless its channel is exactly `production`. Any production marker is enough;
the app no longer downgrades an unknown channel to development. A synthetic channel runs only in an attested synthetic
build.

- **The app:** `ReleaseConfigurationGate`, the outermost element. Nothing mounts before it.
- **The build:** `check-production-pilot-build-env.mjs`, which treats the `production-pilot` profile as a marker.
- **Failing-before:** the old build check passed channel `"Production"`.
- **This closes G5.**

### Expired Core

- **Saved data stays readable.** It is read, verified and shown through the real client contract.
- **Paid actions stay gated:** adopt, resume, accept and purchase are refused on current access.
- **Failing-before:** a `core_subscription_required` 403 was folded into `reauth_required` (sign in again). It now
  keeps its own code, and the plan reads "could not be verified … This is not an empty plan".
- **Service side:** pinned in Desktop `owned-consumer-api.test.ts`. Personal reads have no membership check, and the
  lab API gates only job creation.
- **The deployed services are a hosted dependency** (§9). That is not a pass.

### Held content

Held directions and purchase links are preserved. **G2 is draft wording only.** The export status marker is proposed
(wording, a `device-personal-copy/2` shape and five tests), **not applied**. Today's verbatim export is pinned so that
any marker sits beside the content.

### V2 gates

| Gate | Result |
| --- | --- |
| Full suite | 351 files, 3,922 tests passed, 1 skipped |
| `tsc` | Clean. |
| `expo lint` | Clean. |
| `test:launch-acceptance` | 22/22 |
| `test:release-preflight` | 10/10 |
| `check:release-preflight` | Refuses with 51 missing values, 0 refusals. |
| `test:production-pilot-build-env` | Passes. |
| Core launch scope | 2/2, and the check passes. |

The 9 hosted, device and human cases and the 51 preflight values stay withheld.

## 7. Candidate identities, digests and release switches

### SQL candidates

| Artifact | SHA-256 (committed bytes) | Release |
| --- | --- | --- |
| `workforce-identity-emergency-revocation.sql` | `8d059be1483e9ff5337fd7799b28208901088cab4bc940a1de1d03bc50db9d88` | BLOCKED |
| `workforce-identity-emergency-revocation-rollback.sql` | `cf4c40020aeaf746cfa155ad633bf87cbd7b823e360b5bd2cb56fad4d13804a4` | BLOCKED |
| The successor `set_request_context` prosrc | `3ee98d29830ee366a1c670c236cbf018b710eb7dbbc48d3ee090e7d66c36097b` | (pinned post-check) |
| Its required parent prosrc (deployed) | `36d00be99597f6b527863cece9b9e174a900b49b7c2cd2085224061954b2d0ea` | (guard) |
| `workforce-identity-recovery.sql` | `30cadec0250283229a005176f08175eb0f7bd3fd79979be6b55196ba2bc86fa8` | BLOCKED |
| `workforce-identity-recovery-rollback.sql` | `5d73c082cc3b11e1ad044bced9434893b983f7505d99fa35035fe794b26571b9` | BLOCKED |
| Codex event-order successor | `a03d96ed…`, rollback `c7b4ba07…`, listing parent `5a7af23d…` | BLOCKED, separate (unchanged) |

### Switches, all off

- `WORKFORCE_IDENTITY_REVOCATION_RELEASE='blocked'`.
- `WORKFORCE_IDENTITY_RECOVERY_RELEASE='blocked'`.
- `workforce_identity_revocation_release`: `enabled=false`, `approval_mode` null.
- The recovery release row is unset (verification method, retention, maximum hours), and the approver roster is empty.
- The operator console has no `identityRevocation` service, so its routes answer not released.
- The platform operator release is not `qualification`.
- Fullscript lab ordering is held regardless of flags.
- V2: no switch was added. The release gate is a refusal, not a switch.

### V2 launch kit

Rebound to the reconciled pair (§11). The predecessor is preserved at its LF-byte digest. All 6 mirrors and 25 candidate
digests were re-verified against the Desktop head: 31/31 match. The new Desktop candidates are not V2 dependencies and
were not added to the kit.

## 8. Decisions, findings and what stays open

### D1 to D5 (`docs/suspended-clinic-custody-2026-10-16.md`), and G2

| Decision | Status |
| --- | --- |
| **D1** (a session already open in a suspended clinic) | The owner's policy **permits** an already-valid session to continue until its expiry, rules out the successor that ends every session, and treats a suspected compromise as a separate event (WP2). The permitted bound **cannot be enforced yet**: the WP4 missing contract. Until that exists, the clinic-status successor stays unactivated and ordinary suspension changes nothing for an open session. |
| **D2** (a practitioner-recorded withdrawal in a suspended clinic) | Undecided. The consent-decision successor refuses it as written; the patient's own withdrawal stays open. The owner's "blocks new practitioner consent decisions" does not settle whether a withdrawal is "new". |
| **D3** (recording cleanup) | Undecided. Deployed SQL refuses it in a suspended clinic. |
| **D4** (who may place a legal hold on a closed clinic) | Undecided. Nobody can today. |
| **D5** (patient copies while the clinic is closed) | Undecided. WP3's custodial route is a candidate path, but it is not the decision. |
| **G2** | Draft wording only, for Brandon and counsel. |

### New findings

1. **The campaigns gap.** A revoked login keeps campaign staff access until token expiry, and through refresh until
   Cognito disables the user. The fix is a revocation read in the staff route, or keeping campaigns off until there is
   one.
2. **The WP4 missing contract** (§4).
3. **The fence in the emergency path.** With the BLOCKED membership-fence guard applied, a revocation needs the
   `membership-fence/1` acknowledgement. The fence lives in DynamoDB, so a DynamoDB outage would delay a database
   revocation.
   - Design choice for Codex: exempt identity disablement from the guard (the revocation records its own receipt), or
     accept the dependency.
   - Today the service refuses whole, before the database, when the fence cannot begin.
4. **The Cognito username assumption.** The work list's `providerUsername` is the identity subject. That holds only if
   the pool's username equals `sub`, which **Codex must verify** on the workforce pool before any provider adapter
   runs.
5. **Fullscript on deploy.** Every saved connection predates generations, so on first use after deploy each one moves
   to the outbox and asks for a reconnect, by design. Without the fence table, no connection is used at all. Schedule
   this with the practitioners who use Fullscript.
6. **Recording cleanup and legal hold** are refused in a suspended clinic in every stage (D3, D4). This was carried
   forward and re-pinned.

## 9. Ordered AWS hand-back for Codex (nothing here was run)

1. **Ledger first.** Read the migration ledger and confirm that the deployed `set_request_context` prosrc is
   `36d00be9…`. If it is not, stop: the revocation candidate refuses any other parent by design.
2. **Choose between the emergency revocation and the clinic-status successor.** They cannot both be applied. The owner
   has ruled out the clinic-status successor, which ends every session.
3. **On the qualification database only**, apply the onboarding chain through `workforce-onboarding-approval-authority`,
   then the revocation candidate. Repeat the two-session scenarios of `scripts/qualify-emergency-revocation-native.mjs`
   there (that script drives a local disposable cluster; it is the model, not a hosted runner). Then apply the rollback
   and confirm that the parent prosrc is restored byte-exactly.
4. **Cognito verification (read-only).**
   - On the workforce pool, confirm that username equals `sub` (finding 4).
   - Confirm the operator pool's MFA and 15-minute `auth_time`, using the verifier `6ad788ff`.
   - List the exact IAM actions the adapter needs: `cognito-idp:AdminDisableUser` and
     `cognito-idp:AdminUserGlobalSignOut` on the workforce pool ARN only, plus `AdminGetUser` for WP3.
   - Grant nothing until the release is approved.
5. **The approval mode** (`second_operator_before` or `independent_review_after`) and the operator roster are Brandon's
   decisions. Record them in the release row only after step 3 passes.
6. **The fence decision** (finding 3): exempt identity disablement from the membership-fence guard, or accept the
   DynamoDB dependency. Decide before the guard and the revocation are applied together.
7. **The campaigns revocation read** (finding 1), before campaigns are on for any practice with a revocable staff
   login.
8. **Recovery (WP3) stays disabled.** Before its release row can be written it needs:
   - the verification method;
   - the approver roster;
   - the retention policy;
   - the custodial maximum;
   - the scope of a custodial read.

   These come from Brandon and counsel. Then qualify it like step 3.
9. **Fullscript sandbox probes.** Report each one; none is marked passed here.
   1. A connection made under generation N stops being used after a remove-and-re-add (generation N+2), and its outbox
      item revokes at Fullscript.
   2. Reconnect after the re-add works and records the new generation.
   3. A failed provider revocation stays pending and retries.
   4. The read-only legacy email-keyed inventory (fingerprints only). Execute a reviewed plan only after review.
   5. `create_lab_checkout` refused with the flags forced on, in the sandbox.

   **Permissions:** `FULLSCRIPT_MEMBERSHIP_FENCE_TABLE` and the token-table permissions (GetItem, ConditionCheckItem,
   Query, Put/Delete/UpdateItem) ship together, or not at all (finding 5).
10. **The V2 expired-Core probe.** With a fictional owner whose Core has expired, run the deployed personal read,
    active-plan read and lab-result read; each should return 200. Lab-analysis job creation should be refused
    (402 `core_subscription_required`). Report any other answer as a backend dependency.
11. **The V2 release channel.** In the release preflight, assert that the production build's
    `EXPO_PUBLIC_RELEASE_CHANNEL` is exactly `production`. The app now refuses otherwise.

## 10. Desktop local gates

See §11 for the final-head CI. The local gates ran at `66f81ff8`. Later commits change only `docs/`, `CLAUDE.md`, the
Codex audit-review scripts, `package.json` script entries and `ci.yml`. No `src/` file changed after `66f81ff8`.

| Gate | Result |
| --- | --- |
| `tsc --noEmit` | exit 0 |
| `npm run lint` | exit 0 |
| `npm run test:unit` | *(recorded in §11)* |
| `build:clinical` (with `NODE_OPTIONS=--max-old-space-size=8192`) | *(recorded in §11)* |
| `check:clinical-bundle` | *(recorded in §11)* |

## 11. Final heads, CI and verification

*(Filled in last.)*

## Graphify append text (not applied; the shared map was not reachable from here)

```
2026-10-16 Claude continuity + Core release safety. Desktop claude/desktop-continuity-integration-20261016; V2 claude/v2-continuity-integration-20261016.
- WP1: merged Codex f599a8a2 (CI 38971310243), eeb4223e (CI 38974061201; event-order stays BLOCKED, separate), 0beb5d52; V2 bb80340a, be1b9e5, 488c9003. No pinned candidate changed.
- WP2 BLOCKED workforce-identity-emergency-revocation.sql (8d059be1): identity-level, operator-only, two approval modes, entry FOR SHARE (36d00be9 -> 3ee98d29); refuses the clinic-status successor as parent. Failing-before: issued sole-owner session reads/writes/consents. PGlite 24/24; native 8 scenarios / 33 checks; Cognito adapter not called.
- WP3 BLOCKED workforce-identity-recovery.sql (30cadec0): retired subject never rebinds; custodial read one patient, time-bounded, logged. Release decisions unset. 11/11 + 2/2.
- WP4: 5 stages x 6 rows 30/30. MISSING CONTRACT: no token time reaches the DB and no suspended_at exists; no continuity successor built.
- WP5: fullscript-generation/1, revocation outbox, reviewed legacy reconciliation; lab checkout refused with flags forced on. 9 + 8 tests; hosted probes returned.
- WP6 V2: production build fails closed on non-exact channel (G5 closed); expired-Core read stays readable, core_subscription_required no longer "sign in"; export marker proposed, not applied; G2 draft.
- Findings: campaigns keep staff access after revocation (gap); fence in emergency path; Cognito username=sub unverified; Fullscript connections all reconnect on deploy.
```
