# Withdrawal-only consent in a suspended clinic, across every workforce route

**Status: BLOCKED.** This is a source candidate only. Nothing was applied, registered or deployed. The evidence is local:
PGlite, plus a disposable PostgreSQL 16 cluster.

## 1. The rule

The owner's rule for a suspended clinic:

- A practitioner may record an authorized **withdrawal** of an existing consent.
- Nobody may record a **new grant**, a revision or a superseding grant.
- Patient-direct withdrawal and authorized withdrawal cleanup continue.

The integrated consent-decision candidate (`workforce-consent-decision-clinic-status.sql`) enforces this for
`record_consent_grant` and `revoke_consent_grant`. This pass asked whether anything goes around it.

## 2. Every route that writes consent

The inventory is pinned against the schema: the test lists every function the API role may execute that writes a
consent table.

| SQL function | Actor and route | Kind | Before this pass | After |
| --- | --- | --- | --- | --- |
| `record_consent_grant` | workforce `consent_management` (identity API, legacy). Under `database_current` the general setter refuses a suspended clinic. | grant | refused (consent-decision candidate) | refused |
| `revoke_consent_grant` | workforce `consent_management` | withdrawal | admitted for an active clinical member | admitted |
| `revoke_current_workforce_consent` | workforce, `database_current`, one operation (BLOCKED wrapper) | withdrawal | admitted for a current clinical member | unchanged |
| **`set_sync_consent_scope(_grant => true)`** | workforce `clinical_data`, a production Desktop RPC **on the pilot allow-list** | **grant** | **admitted in a suspended clinic** | **refused** |
| `set_sync_consent_scope(_grant => false)` | same | withdrawal | admitted | admitted |
| `revoke_sync_connection` | workforce `clinical_data` | withdrawal (the whole connection) | admitted | unchanged |
| **`grant_encounter_recording_consent`** | workforce `clinical_data` (recording family) | **grant** | **admitted in a suspended clinic** | **refused** (a retried grant still gets its receipt) |
| `withdraw_encounter_recording_consent` | workforce | withdrawal | admitted | unchanged |
| `production_care_connection_request` | consumer: the patient's own claim and consent | patient | out of this rule | unchanged |
| `set_owned_consumer_consent` | consumer storage consent | patient | out of this rule | unchanged |

**Other actors:**

- **Patient-direct withdrawal** (consumer pool) runs in every stage.
- **Retention sweep and privacy operators** write no grants. They run under workforce `consent_management` with their
  own assignments (continuity matrix).
- **Recording cleanup and legal hold** are refused in a suspended clinic by their own deployed checks (D3, D4; unchanged).
- **Provider callbacks:** no callback writes a consent row. Telehealth consent is the consumer's own
  (`production-telehealth-consent.ts`).

## 3. The gap and the successor

**Failing before.** With the consent-decision candidate alone, a practitioner in a suspended clinic could still record a
new grant through the sync screen, and a new recording consent (PGlite 2 cases; native scenario 1).

**The successor.** `infra/aws-clinical-core/source-candidates/workforce-consent-grant-paths-clinic-status.sql`, with a
preserving rollback, adds the consent-decision candidate's own check to the **grant half** of those two functions, at
the mutation, and nothing else:

- The check is `require_active_consent_clinic`: the clinic row is share-locked and active, else the existing
  `consent_actor_refused`.
- Their withdrawal halves are unchanged.
- A retried recording grant's receipt is unchanged.
- Signatures, owner, `SECURITY DEFINER`, `search_path` and grants are kept.

## 4. Evidence

| Kind | Result |
| --- | --- |
| PGlite (`workforce-consent-grant-paths.database.test.ts`) | 12/12, plus 2 failing-before cases on the parent. |
| Native (`scripts/qualify-consent-grant-paths-native.mjs`) | 4 scenarios, 11 checks, all passing (`docs/evidence/2026-10-17-consent-grant-paths-native-*.json`). |

The PGlite cases:

- the pin, and the consent-writer inventory;
- every new grant refused, with nothing written, in a suspended and in an archived clinic;
- every withdrawal path admitted, and the patient's own withdrawal;
- a revision or superseding grant refused, and a retried grant receipt-only;
- no fabricated withdrawal: nothing-to-withdraw writes nothing; another clinic, a staff role and a removed member are
  refused;
- an active clinic unchanged;
- the rollback, the guards;
- with the emergency revocation and the ordinary-suspension window applied as well:
  - a revoked login withdraws nothing;
  - a lawful colleague still can;
  - consent management is not windowed.

The native scenarios:

1. the failing-before;
2. a grant admitted first holds off the suspension;
3. a grant waiting on a suspension in flight is refused, with nothing written (both paths);
4. a withdrawal lands in both orders without waiting on the clinic row.

## 5. Held and noted

1. **The sync-screen withdrawal under the ordinary-suspension window.** `set_sync_consent_scope` is a `clinical_data`
   write, so once the window candidate is applied it is refused (no evidence) or held (with evidence), like every write.
   The withdrawal-only path stays open through `revoke_consent_grant`. Making the sync-screen withdrawal pass the window
   is a decision: it would be the window's first admitted write.
2. **Time bounds on practitioner withdrawal.** A practitioner withdrawal through `consent_management` is not
   time-bounded by the window (see `docs/ordinary-suspension-window-2026-10-17.md` §7).
3. **D3, D4 and D5** are untouched.

## 6. Identities

| Artifact | SHA-256 |
| --- | --- |
| `workforce-consent-grant-paths-clinic-status.sql` | `b6f4b53a640dd362df28613a2953d58cf81082d04bbcc1e55c1530022ac24346` |
| `workforce-consent-grant-paths-clinic-status-rollback.sql` | `6382c13c6dd1c3d2789cd1ccafd54a1418a45ae61e115b3d77ef6f48d0784a96` |
| `set_sync_consent_scope` successor prosrc | `6dc59bb3337cd6135a901444b14fddf701adb5b33513c332b87bf3d62270f723` (parent `ebbd09fd…202ad`) |
| `grant_encounter_recording_consent` successor prosrc | `a7df57f5e4e8e7f29839d47ef1202460dedd0a8d8b92a9644cf6dabcc3ff860f` (parent `e28248a0…54625`) |
| Required helper (consent-decision candidate) | `b0831b02f1f634d5d5d49e29a12c3ac2f0f7d634a834cdd14773a991c4a49888` |

## 7. Codex hand-back (not run)

1. Apply the consent-decision candidate, then this one, to isolated fictional qualification Aurora. Repeat the four
   native scenarios.
2. Roll back. Confirm both parents byte for byte and that every consent row remains.
3. On the qualification stack, check:
   - the Desktop sync screen's grant in a suspended fictional clinic is refused with a 403, not a 5xx;
   - its withdrawal lands.
