# Major source return (16 October)

_Draft in progress: WP6, WP7, verification and risks are filled in by the final commit on this branch._

**Scope:** source engineering only, with fictional data. Nothing was deployed or applied. No credential, store product
or paid build was created, PHI stayed off, and nothing was merged to `main`. Neither product is commercial-ready or
PHI-ready. Every SQL candidate here is BLOCKED.

## Heads

| Repository | Branch | Base | Final head | Exact-head CI |
| --- | --- | --- | --- | --- |
| Desktop | `claude/desktop-major-source-20261016` | `3c863b7b` (CI 38951421034, success) | _see §Verification_ | _see §Verification_ |
| V2 | `claude/v2-existing-data-journeys-20261016` | `ac621a1c720db16b37e7245b3e3e63f39992a811` | _see §WP6_ | _see §WP6_ |

**Codex's Fullscript branch.**

- Branch `agent/fullscript-revocation-evidence-20261016` at `e08df97f`; exact-head
  [CI 38955809006](https://github.com/HolisticDrBright/AI_DESKTOP_PRO/actions/runs/38955809006) **success**, attempt 1.
- Reviewed on its own branch: against the parent, 7 failed and 61 passed; at its head, 26 files and 882 tests pass.
- Merged into the Desktop branch at `b56e3bb0` by a merge commit. Nothing was cherry-picked or redone.

**V2 base.** Codex's V2 branches were left untouched:

- the Fly provenance branch at `be1b9e5`, built on `ac621a1`;
- the three billing-observability branches.

They touch CI, the release kit and billing scripts, not the journeys tested here.

## Per work package

The evidence-level labels used below:

- **local** = this container;
- **CI** = exact-head GitHub Actions;
- **hosted / device / human** = not done here.

### WP1 — suspended-clinic custody (design; decision packet)

- **Packet:** `docs/suspended-clinic-custody-2026-10-16.md`. It contains:
  - what the source defines for suspended, archived, ordinary revocation, credential compromise and closure. There is
    no archive writer, no reinstatement writer and no workforce-disable writer;
  - the five-actor matrix in both modes;
  - decisions D1 to D5 in exact text. The conflict between the owner's two directions is recorded, not chosen;
  - the threat model, a continuity path that does not trust the suspect login, and the evidence still required.
- **New test:** `suspended-clinic-custody.database.test.ts` runs three stages on the 106-migration production schema.
  A session open before the suspension:
  - deployed: keeps reading, writing and deciding;
  - with the status successor: refused for reads and writes, still admitted for consent decisions;
  - with both successors: refused for all three.

  Records, consent history and audit survive every stage, and the patient is never refused.
- **Corrections, from reading the source.**
  - The status successor's header (byte-pinned, so not edited) and the earlier inventory text overstated what the
    `consent_management` exception keeps running:
    - erasure recovery and the care-data lifecycle run in the consumer pool;
    - recording cleanup refuses itself in a closed clinic.
  - `care_connection_actor` also reads clinic status.
  - The inventory decision text and the onboarding document are corrected.
- **Not changed:** the successor's hash and every release switch.
- **Evidence:** implemented (design and tests); local only.

### WP2 — consent decisions versus withdrawal cleanup

- **Defect, reproduced:** a practitioner of a suspended or archived clinic could still record a new consent grant or
  withdrawal. The status successor admits all workforce `consent_management`.
- **Repair:** BLOCKED `workforce-consent-decision-clinic-status.sql`, with a byte-for-byte rollback.
  - It gates only the workforce branch of `record_consent_grant` and `revoke_consent_grant`, the boundary that tells a
    practitioner's decision from cleanup.
  - The clinic must be active, share-locked in the operation's transaction.
  - The refusal is the existing `consent_actor_refused`.
  - The patient's own decisions, the retention service, privacy operators and recording cleanup are unchanged, and
    no generic bypass is granted.
- **Failing before** (stage 3 without the candidate): **8 failed, 37 passed**. **Passing after: 49/49.**
- **Native two-session PostgreSQL 16:** 5 scenarios, 19 checks, all pass
  (`docs/evidence/2026-10-16-consent-decision-native-02e8c703.json`). They cover both race orders, the retry after a
  suspension, the patient's withdrawal and the retention sweep not held back, and a sibling clinic.
- **Disabled cleanup identity:** the retention service is refused when its release is revoked and when its identity
  is disabled.
- **Finding, not repaired:** cleanup of an already-withdrawn recording consent, and placing a legal hold, are refused
  in a closed clinic by deployed SQL in every stage. Unlocking deletion where nobody can place a hold needs D3 and D4.
- **Evidence:** implemented; local.

### WP3 — the five unverified cells

- **`unconverted_claims_families / legacy_claims / removed_membership` → `refused`.**
  - Every route was traced path by path, and each now has a test showing a removed member refused on the next request
    after succeeding while active. The new tests cover recording capture (with an issued capture token), transcription
    and drafting; calendar, including busy sync; Ask ALP; consult links, requests and retention; disputes and
    revisions; outcomes; protocol carts; note templates; intake; and the clinic's notification-settings view.
  - This is coverage, not repair.
  - Inventory counts: refused 57 → 58, unverified 5 → 4.
- **`transitional_lab_documents / legacy_claims` × 4 stay `unverified`.**
  - The host's last source was deleted from V2 at `b2850a2` (22 July) and is on no current branch head. The deployed
    build is unknown.
  - The exact hosted four-persona probe is in `docs/route-authority-unverified-2026-10-16.md` §2.
- **Unchanged:** the `token_lifetime` / `gap` / `unverified` distinctions. Two non-route residuals are recorded: Ask
  ALP's global prompt actions, and calendar busy sync in a suspended clinic.
- **Evidence:** local; the lab host needs hosted evidence.

### WP4 — Fullscript beyond installation

- **Codex's callback repair:** reviewed, then merged after its exact-head CI.
- **Defect reproduced with two fictional accounts:** the connection key was clinic + lower-case email, so two accounts
  with the same verified address in one clinic shared a row. Either could see, use and revoke the other's
  authorization.
- **Repair:**
  - the key is clinic + Cognito subject, versioned;
  - an older email-keyed row is never claimed. It reports `reconnectRequired`, and it is not used, refreshed, revoked
    or deleted;
  - the action route re-reads current clinics after Fullscript answers, so a mid-call removal or suspension withholds
    the result;
  - lab checkout is held before any token use, whatever its flag says.
- **Failing before: 9 failed, 4 passed.** **Passing after:** 13/13, and the Fullscript, panel and inventory suites
  pass 28 files and 1,052 tests.
- **Further material** in `docs/fullscript-subject-binding-2026-10-16.md`: the route-by-route survey, the residuals and
  the provider-side reconciliation plan.
- **Evidence:** local. Hosted DynamoDB, Fullscript sandbox and the Cognito pool setting are not observed.

### WP5 — synthetic invitation and clinic suspension

- **Defect reproduced:** an invitation issued into a suspended or archived fictional clinic, and one issued before the
  suspension and claimed after it, became a verified connection.
- **Repair:** BLOCKED `synthetic-invitation-clinic-status.sql`, separate from the production candidate, with a
  rollback.
  - It works on the synthetic schema only.
  - Issue and claim both require an active clinic, share-locked.
  - The refusal is the existing `synthetic_context_refused`.
  - `legacy-claims-clinic-status.sql` and its rollback stay byte-pinned.
- **Failing before: 4 failed, 3 passed.** **Passing after: 16/16.**
- **Native:** 5 scenarios, 17 checks (`docs/evidence/2026-10-16-synthetic-invitation-native-3189977a.json`). They cover
  an invitation issued before the suspension, a retry, two clinics, an already-issued session and both in-flight
  orders.
- **Evidence:** implemented; local.

### WP6 — V2 existing-data journeys

- **Branch and base:** V2 `claude/v2-existing-data-journeys-20261016` on the deliberate base `ac621a1`. The note is
  `expo/docs/claude-existing-data-journeys-2026-10-16.md`.
- **Traced:** an owner with an old saved lab-derived plan, an expired Core membership, a second owner on the same
  phone, a restored offline cache, Ask ALP, adoption, coaching, old plan cards, deep links and the caregiver view.
  - In production, nothing renders AI lab-derived supplement directions, order links or add-ons.
  - Account isolation and rehydration hold.

  Both are existing coverage, and the tests are named in the note.
- **Three source defects, reproduced and repaired.** **Failing before: 6 failed, 2 passed. Passing after: 8/8.**
  - **G1:** the saved fasting window was readable only on paid Today. It is now on the free Plan tab.
  - **G3:** the copy comparison printed a held plan's fasting notes. Now only the window is shown.
  - **G4:** the caregiver mask missed bare shop domains and short links. It now catches them.
- **V2 suite:** 348 files passed, 1 skipped; 3,914 tests passed, 1 skipped. `tsc` is clean.
- **Draft for Brandon and counsel (G2):** a held plan's released routines are readable only on paid Today, while the
  Plan tab's withheld card says such actions are withheld. Draft wording is in the note; it is not applied.
- **Recorded:** G5 to G8, and one hosted question (whether the personal-storage read refuses an expired account).
- **Untouched:** the nine external launch cases and the 51 preflight values.
- **Evidence:** local plus V2 CI (§Verification). Device, hosted and human acceptance are not observed.

### WP7 — the live-lens "Page not found" observation

The record is `docs/evidence/2026-10-16-live-lens-page-not-found.json`. **The observation stays unresolved.**

- **What renders that page.** The patient layout calls `notFound()` only when the patient read returns no row; a
  failed read goes to the error boundary instead. The fixture backend returns no row for a revoked bearer, a no-clinic
  or outsider bearer, or another clinic. Every fixture session shares one bearer, and four specs revoke it and restore
  it later.
- **Not reproduced.** There were six cold runs, each on a fresh fixture backend and a fresh `next dev`, with a
  debugging-only fetch preload logging each patient read (time, pid, clinic, rows, bearer digest; never the token).
  All passed 9/9. Of 66 patient reads none was empty, with one bearer, one clinic and no dev-server restart.
- **One deterministic producer of the identical page.** Revoking the shared bearer through the backend's control
  makes the encounter answer 404 with an empty patient read; a reset restores 200.
- **Why it is not the diagnosis.** Nothing shows a revocation or a second client in the original run: it had its own
  backend, ran only the lens spec (which never revokes), and a process check right after it found nothing else.
- **What did not change:** no timeout, no retry, no source change.
- **Evidence:** local only.

## Verification

_See below._

## Unresolved risks

1. **D1 (Brandon and counsel).** Whether a session open in a clinic outlives that clinic's suspension conflicts with
   the BLOCKED status successor. The source has no workforce-identity disable, no replacement-credential rebind and no
   custodial path for a closed clinic. A stolen sole-owner credential can be stopped only by suspending the clinic.
2. **Closed-clinic cleanup and holds.** Recording cleanup of withdrawn recording consents, and legal-hold placement,
   are refused in a closed clinic by deployed SQL (D3, D4). A patient's copy of clinic-held records is refused there
   too (D5).
3. **Practitioner-recorded withdrawal.** In a closed clinic it is refused by the consent-decision candidate as
   written (D2).
4. **Fullscript residuals.**
   - A removed member's token row stays in DynamoDB and returns if they are re-added.
   - The post-call re-read narrows a race; it does not linearize it.
   - The install fence depends on the BLOCKED guard and writers.
   - The Cognito pool's email-uniqueness setting is unknown.
   - Email-keyed rows need the reviewed reconciliation.
5. **The transitional lab host.** Four cells are unverified: its source is deleted and its deployed build is unknown.
6. **Ask ALP direct actions.** A removed member's unexpired token can read the global prompt configuration
   (`active_prompt`, `active_rules`) directly. It is not clinic data, and no Desktop route sends it.
7. **V2.**
   - G2 is a disclosure decision.
   - The G5 release-channel string falls back to development.
   - G7: the export is raw.
   - Whether personal storage refuses an expired account is hosted-only.
8. **WP7** stays unresolved.
9. **Status of every SQL successor.** Each is BLOCKED; none is applied anywhere. PGlite and native PostgreSQL are not
   Aurora. Neither product is commercial-ready or PHI-ready.

## Hand-backs

- **AWS review packet for Codex** (ordered): `docs/codex-aws-review-packet-major-2026-10-16.md`.
- **Graphify:** append text is at the end of this document. The shared map was not changed from here.

## Graphify append text (not applied; the shared map was not reachable from here)

```
2026-10-16 Claude major source pass. Desktop claude/desktop-major-source-20261016; V2 claude/v2-existing-data-journeys-20261016 (a713998).
- Suspended-clinic custody: decision packet D1-D5 (docs/suspended-clinic-custody-2026-10-16.md). The owner-direction conflict is recorded, not chosen.
- BLOCKED workforce-consent-decision-clinic-status.sql: practitioner consent decisions refused in a closed clinic; cleanup, retention, privacy and patient untouched. 8F/37P -> 49/49; native 19/19.
- BLOCKED synthetic-invitation-clinic-status.sql: synthetic issue/claim need an active clinic. 4F/3P -> 16/16; native 17/17.
- Finding: recording cleanup and legal holds are refused in a closed clinic by deployed SQL.
- Fullscript: Codex's e08df97f merged after CI 38955809006. Connection keyed by Cognito subject, not email; email-keyed rows never claimed; mid-call authority change withholds the result; lab checkout held. 9F/4P -> 13/13.
- Route authority: unconverted removed-membership cell -> refused (path by path); lab-host 4 cells stay unverified (source deleted from V2 at b2850a2); refused 58, unverified 4, gaps 4.
- V2 existing data: G1 fasting window on the free Plan tab; G3 held fasting notes withheld; G4 caregiver mask catches bare domains. 6F/2P -> 8/8. G2 draft for Brandon and counsel.
- Live-lens "Page not found": unresolved; not reproduced in 6 cold runs; a revoked shared fixture bearer produces it deterministically.
```
