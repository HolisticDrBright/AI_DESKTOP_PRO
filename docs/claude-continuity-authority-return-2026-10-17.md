# Continuity authority and Core release safety: the return

**Date:** October 17, 2026.

This pass was source engineering and local verification. None of the following happened:

- AWS writes;
- SQL registration or application;
- Cognito or Fullscript calls;
- production activation;
- PHI or real patient data;
- a paid mobile build;
- a PR, a force-push, or a merge to `main`.

Every new SQL candidate is **BLOCKED and unregistered**, and every release switch keeps its blocked value. Candidate
ancestry is preserved: each successor names its exact parent, refuses any other, and has a preserving rollback.

The evidence comes in four classes, never merged:

| Class | What it is |
| --- | --- |
| **PGlite** | In-process PostgreSQL on the real 106-migration chain. |
| **native** | A disposable PostgreSQL 16 cluster with two real sessions. |
| **unit** | Fictional boundaries. |
| **CI** | GitHub Actions on the exact head. |

Nothing here is hosted evidence.

## 0. Heads

| Repo | Branch | Started from | Final |
| --- | --- | --- | --- |
| Desktop | `claude/desktop-continuity-authority-20261017` | `daaf6291` (CI 38991896019) | §8 |
| V2 | `claude/v2-continuity-regression-20261017` | `67601a8` (metadata) / `ea7b356` (code) | §8 |

## 1. WP1: bounded ordinary-suspension sessions (BLOCKED)

`docs/ordinary-suspension-window-2026-10-17.md`

**The rule:** a session already valid at an ordinary suspension reads until its own token's `exp`, and nothing extends
it. Refreshed tokens are refused, writes are held, and an emergency revocation still refuses at once.

**The candidate** records each status transition with the database clock. A ten-argument entry carries the verified
`iat`/`exp` and the declared access. The window is read-only, with statement and lock time bounded by the time left.

**Added this pass:** expired evidence is refused for every purpose.

**Evidence:**

| Kind | Result |
| --- | --- |
| PGlite | 21/21 |
| Unit | 9/9 |
| Native | 8 scenarios, 23 checks (`docs/evidence/2026-10-17-ordinary-suspension-window-native-e28a3c9e.json`) |

**Switch:** `ORDINARY_SUSPENSION_WINDOW_RELEASE='blocked'`.

## 2. WP2: withdrawal-only as a whole-route property (BLOCKED)

`docs/withdrawal-only-whole-route-2026-10-17.md`

**The gap:** with the consent-decision candidate applied, two paths still recorded new grants in a suspended clinic:

- `set_sync_consent_scope(_grant => true)`, which is on the pilot allow-list;
- `grant_encounter_recording_consent`.

**The successor** adds the candidate's own active-clinic check to their grant halves only.

**Evidence:**

| Kind | Result |
| --- | --- |
| PGlite | 12/12, including the failing-before and the consent-writer inventory pinned against the schema |
| Native | 4 scenarios, 11 checks (`docs/evidence/2026-10-17-consent-grant-paths-native-e28a3c9e.json`) |

## 3. WP3: campaign staff revocation

`docs/campaign-staff-revocation-2026-10-17.md`

**The reader is in source and fails closed.** The campaign staff route reads a revocation signal before every staff
operation:

| Signal | Answer |
| --- | --- |
| Revoked | 403 |
| Unreadable or unconfigured | 503, never "not revoked" |

Public sign-up is untouched. The API role gets `GetItem` on one table only.

**The writer is BLOCKED.** It publishes first after the revocation commits. A BLOCKED SQL successor makes it a recorded
third step, so a failed or lost publication stays actionable, and older revocations are backfilled.

**Inventory:** both campaign `compromised_identity` cells move from `gap` to `refused`.

**Evidence:**

| Suite | Result |
| --- | --- |
| Unit | 16/16 |
| Publisher | 4/4 |
| PGlite | 9/9 |
| Integration | 2/2 |

## 4. WP4: Fullscript reconnect safety (source only; Fullscript off)

`docs/fullscript-reconnect-safety-2026-10-17.md`

**What changed:**

- An outage no longer reads as "Not configured".
- A live connection is never silently replaced. It is refused before any code exchange.
- A superseded connection is queued for revocation in the install transaction.
- Callback outcomes are a closed, true set.
- A disconnect Fullscript does not confirm keeps the connection and says so.
- Reconnect text names its reason, and action errors are mapped.
- Connect and disconnect show in-flight states.

**Proposed, not run:** a legacy-row migration and rollback.

**Evidence:** two new suites (7 + 8) plus 10 added cases. All 32 Fullscript files pass (939 tests).

## 5. WP5: V2 regression (V2)

`expo/docs/claude-v2-core-refusal-regression-2026-10-17.md`

**The fix:** `core_subscription_required` was shown as "Sign in again" by Courses and Programs, read as a lost reply in
plan adoption, shown raw on two screens, and read as a food-database outage on the meal screens. All are fixed.

**Also added:**

- the regression matrix for meals, labs, plans and progress, mapped to its tests;
- an invariant that G2 and the export marker stay draft.

**Held:**

- synthetic/TestFlight builds share labs and plans across accounts on one phone, which matters for the device
  worksheet;
- there is no offline UI.

## 6. Verification

| Check | Result |
| --- | --- |
| Desktop full unit suite | §8 |
| Desktop typecheck, lint (changed files) | clean |
| Desktop clinical build, `check:clinical-bundle` | pass; 353 client chunks, no synthetic identity, demo copy or server-only marker |
| `check:stub-reset` | pass (142 bindings covered) |
| Desktop browser battery (`test:e2e:order`) | §8 |
| V2 full suite | 353 files passed, 1 skipped; 3,933 tests passed, 1 skipped |
| V2 typecheck, lint | clean |
| V2 launch-acceptance, release-preflight | 22/22, 10/10 |

**The two earlier full-run timeouts did not reproduce:**

- the export-retention acceptance at 30 s;
- an emergency-revocation DB test at 5 s.

They did not appear in a full local run (1,034 s, zero timeouts), nor in CI on this branch. They were not widened, and
the failed run is not erased: it stays as reported in the packet.

**Two Desktop CI runs failed on this branch, and both causes are fixed:**

| Run | Head | Cause |
| --- | --- | --- |
| 38995897886 | `4a67fc85` | four typecheck errors in a WP1 test |
| 38996832785 | `94e01df9` | the generated Desktop operation inventory was stale after the WP1 adapter change |

- **The typecheck errors** were fixed in `e28a3c9e`.
- **The inventory** was regenerated with the repo's own script in `65fef781`. Only five source hashes changed;
  activation is unchanged (228 operations, 0 enabled).
- **Run 38998319582** (WP3, `da471043`) failed on the same inventory suite alone, 669 of 670 files.
- **Run 38998454155** (`65fef781`) passed.

## 7. Held decisions (owner and counsel)

1. **D3–D5** remain undecided:
   - closed-clinic recording cleanup;
   - legal hold;
   - patient copies.
2. **Writes in a suspended clinic** stay held; the window is read-only. It is not decided which unconverted workforce
   families should carry token evidence.
3. **Campaign sends a revoked login already scheduled** keep going. Pausing them is a decision about the practice's
   mail.
4. **Fullscript:**
   - two Desktop accounts may connect the same Fullscript practitioner;
   - the Cognito pool's email uniqueness is unread;
   - the status never probes Fullscript;
   - there is no outbox reconciler or IAM.
5. **V2:**
   - which channel runs the `two-account-isolation` worksheet row, or whether to owner-scope the synthetic path;
   - the offline UI;
   - G2 and the export marker, which stay draft.
6. **Core** stays education-only at $19.99. PHI is off, the nine external cases are unobserved, and there are no paid
   builds.

## 8. Final heads, CI and the kit binding

Written last; see the bottom of this file.

## 9. Codex hand-back (ordered, not run)

1. **Verify the target.** Read the ledger. Confirm the deployed `set_request_context` prosrc `36d00be9…` and every file
   hash in the five docs above.
2. **Emergency revocation.** Apply it to isolated fictional qualification Aurora, then:
   - the campaign-signal successor;
   - the consent-decision candidate;
   - the grant-path successor;
   - the ordinary-suspension window.

   Each refuses a wrong parent. Repeat each doc's native scenarios there. Roll back in reverse order, and confirm every
   parent byte for byte.
3. **Cognito.** Read `IdTokenValidity` and `RefreshTokenValidity`, how the HTTP API authorizer passes `iat`/`exp`, and
   the workforce pool's email-uniqueness setting.
4. **The campaign stack, fictional account.** Check the signal table, the API's single `GetItem`, and a 503 with the
   table unreadable. Grant the revocation host `PutItem` on that table alone. Revoke a fictional login and confirm its
   next staff request is 403.
5. **The Fullscript sandbox, fictional.** Run the five checks in `docs/fullscript-reconnect-safety-2026-10-17.md` §6.
   Then run the legacy-row inventory on a restored copy only.
6. **V2 on device, fictional.** Check the Core-inactive wording for Courses and Programs. Decide the
   `two-account-isolation` channel. Confirm the consumer routes' 403 body for a Core refusal.
7. **Only after all of the above,** consider moving any release switch. Each is a reviewed code change on its own.

## 10. Graphify text

```
[continuity-authority-2026-10-17]
ordinary-suspension-window (BLOCKED) -> parent: emergency-revocation entry 3ee98d29; adds organization_status_transitions, 10-arg set_request_context(iat,exp,access); rule: iat <= suspended_at-60s, now < exp, read-only; evidence native e28a3c9e
consent-grant-paths-clinic-status (BLOCKED) -> parents: set_sync_consent_scope ebbd09fd, grant_encounter_recording_consent e28248a0; requires require_active_consent_clinic b0831b02; closes grants-in-suspended-clinic gap
workforce-revocation-campaign-signal (BLOCKED) -> parents: revocation summary 775819dd, recorder 60817476; adds step campaign_signal; work list keeps item until signal confirmed
campaign staff route -> reads alp-campaign-staff-revocations (GetItem, consistent); revoked=403; unreadable/unconfigured=503; public routes never read it; inventory campaigns/compromised_identity: gap -> refused
fullscript reconnect -> live connection never replaced (already_connected before exchange); superseded row -> outbox in install transaction; status outage = 503 Unavailable (never Not configured); callback outcomes closed set
v2 core refusal -> core_subscription_required never a sign-in failure (courses, programs, adoption, known message, meal screens); G2 and export marker stay draft (invariant test)
held -> D3-D5; writes in suspended clinic; campaign scheduled sends after revocation; fullscript multi-account, pool email uniqueness, outbox reconciler; v2 synthetic two-account sharing, offline UI
```
