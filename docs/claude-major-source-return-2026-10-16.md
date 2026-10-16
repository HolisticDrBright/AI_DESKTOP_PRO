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

_See below._

### WP7 — the live-lens "Page not found" observation

_See below._

## Verification

_See below._

## Unresolved risks

_See below._

## Hand-backs

- **AWS review packet for Codex** (ordered): `docs/codex-aws-review-packet-major-2026-10-16.md`.
- **Graphify:** append text is at the end of this document. The shared map was not changed from here.
