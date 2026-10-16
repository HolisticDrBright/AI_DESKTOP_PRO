# AWS review packet for Codex — major source pass (16 October)

**This is a review hand-back, not authorization.**

- Nothing here was applied, registered, deployed or switched on.
- No credential, store product or paid build was created.
- Every row used was fictional.
- Production stays empty of these candidates until Brandon and counsel decide the items marked **decision**.
- PGlite and a throwaway local PostgreSQL 16 are the only engines that ran these candidates. Neither is evidence about
  Aurora, the RDS Data API, a deployed Lambda, DynamoDB or Fullscript.

Desktop source branch: `claude/desktop-major-source-20261016`. The exact head and its CI are in the return document.

## Candidate files (SHA-256 of the file bytes)

| File | SHA-256 | State |
| --- | --- | --- |
| `infra/aws-clinical-core/source-candidates/legacy-claims-clinic-status.sql` | `c3788dc20bed9fe6aae40cc939a08a69773d45d56dc297dea21ae99ed6c7cc66` | BLOCKED, **unchanged** (file bytes pinned by two test files; its definition hashes by a third) |
| `…/legacy-claims-clinic-status-rollback.sql` | `4c311c01148367b82d58e2143c2cce6f21f391fa04d50f1f21e27935224b29a0` | BLOCKED, unchanged |
| `…/workforce-consent-decision-clinic-status.sql` | `0e6a69252cb3e9768d10481153211c746d030104c452f2e25df725c0a373a368` | BLOCKED, new |
| `…/workforce-consent-decision-clinic-status-rollback.sql` | `a8a40a7bd231e8ded3ecf8a07b52063e00591839f4a98794855b6e5758630487` | BLOCKED, new |
| `…/synthetic-invitation-clinic-status.sql` | `775474de8959fe1f6e32fee7598129501b0a7235d685528a3dd4e69422260f63` | BLOCKED, new; synthetic schema only (it refuses any other) |
| `…/synthetic-invitation-clinic-status-rollback.sql` | `ab088d1bfb82800852c79633841e8b78c84f5098332f5fd57c35d7b829eed0b1` | BLOCKED, new |
| `…/workforce-membership-fence-guard.sql` | `d3bb86387a75da63a7742530acb571e0e1a8625c52343fd32db2a726596ff5ec` | BLOCKED, unchanged; Codex's Fullscript install fence depends on it |

## Parent and successor prosrc SHA-256

The candidates check these themselves, before and after they apply.

| Function | Parent | Successor |
| --- | --- | --- |
| `clinical_core.record_consent_grant(uuid,uuid,text,text,text)` | `75d010fcb9ea0a014d72cc056a8606b071e22ee65bf03eb509b266f7d782bba3` | `89ebfcfc7dbf9cb5443fec121ebac0b4eadde24c6fccc802ec2030ea9c3cf33c` |
| `clinical_core.revoke_consent_grant(uuid,text,text)` | `0bb066f2d50d473906527ce1dc2dca38b8416e5d5e6c556751b092a2b22be0af` | `fafbcf48ed8a24c7d50d8171c7955bd7c3ac0bf7a8a863f94ea2795733b8a9a1` |
| `clinical_private.require_active_consent_clinic(uuid)` (helper) | — | `b0831b02f1f634d5d5d49e29a12c3ac2f0f7d634a834cdd14773a991c4a49888` |
| `clinical_core.issue_connection_invitation(uuid,uuid,text,timestamptz,text)` (synthetic) | `5602dbabe5145e522e70c4b6e4d905dd18a39238f8d9052be75bd7d02d2125b7` | `d2b67c8228e9e092302c4100ad40b678708a1ad2c0f36cfe8668675b656649df` |
| `clinical_core.claim_connection_invitation(text,uuid)` (synthetic) | `7decec8ec32ec6e0fcc9c3597d4c1ba96fdc835414515159d37e9a650a19da30` | `5f76b92ab1ef46cd583d7cee2fda01d9dba78cbc1c84a55fef65c03c0aff1baa` |
| `clinical_private.require_active_synthetic_clinic(uuid)` (helper) | — | `846785ecc92ee91b810a08ed88ccd217007b63e85ae689a18816fd9e1b777a65` |
| `clinical_private.set_request_context(…)` (status successor, unchanged) | `36d00be99597f6b527863cece9b9e174a900b49b7c2cd2085224061954b2d0ea` | `4187ce781d95640caa788e1a9a2a49b7d59103bc3b0fa2f37ae85de99955201b` |

## Ordered review steps

Do them in this order. Stop at any step whose precondition is not met.

1. **Read the decision packet first.**
   - Read `docs/suspended-clinic-custody-2026-10-16.md` §1.
   - D1 to D5 are Brandon's and counsel's. Nothing in steps 3 to 6 is applied to any target that serves a real
     clinic before D1 is decided.
   - D1 conflicts with the status successor's semantics. The conflict is recorded there, not chosen.
2. **Read the ledgers.** Read the target qualification database's migration ledger. Confirm that neither status
   candidate, nor any other candidate in the table above, is registered.
   - Read the parent prosrc hashes on that target with
     `select encode(sha256(convert_to(prosrc,'UTF8')),'hex') from pg_proc where oid=to_regprocedure('<signature>')`.
   - A parent that differs refuses by design. Report the difference; do not edit the candidate.
3. **Status successor.** If, and only if, D1 is decided for the successor's semantics:
   - review `legacy-claims-clinic-status.sql`;
   - on a fictional qualification Aurora only, run its suite;
   - run the two-session race on Aurora itself: suspension racing an admitted operation, and an operation waiting on
     a pending suspension. The native script `npm run qualify:clinic-status-native` is the local model of that race.
4. **Consent-decision successor.** If, and only if, D2 is decided:
   - review `workforce-consent-decision-clinic-status.sql`. As written it refuses a practitioner's grant **and** a
     practitioner-recorded withdrawal in a closed clinic, and leaves the patient's own decisions open;
   - apply it after the status successor, on the same fictional target;
   - repeat `npm run qualify:consent-decision-native` on Aurora. Its evidence is
     `docs/evidence/2026-10-16-consent-decision-native-02e8c703.json`.
5. **Recording cleanup in a closed clinic.** Nothing to apply. Deployed SQL refuses it, together with legal-hold
   placement; that is the finding in §4 of the decision packet. Do not unlock cleanup before D3 and D4 are decided,
   and before a closed-clinic hold path exists.
6. **Synthetic invitation successor.** This is for the synthetic staging Aurora only, after Brandon chooses between
   enforcing clinic status there and retiring the synthetic boundary. It refuses any non-synthetic schema. The local
   evidence is `docs/evidence/2026-10-16-synthetic-invitation-native-3189977a.json`.
7. **Fullscript.** Keep it disabled.
   1. Codex's install fence (`e08df97f`, now merged) is conditional on the BLOCKED membership-fence guard, every
      authority-reducing writer beginning the fence, the fence table and its IAM (`GetItem`, `ConditionCheckItem`),
      all released together.
   2. Read the workforce Cognito pool's attribute configuration. Record whether two users may hold the same verified
      email. The subject-bound key repairs the collision either way, but the answer sizes the email-keyed row
      migration.
   3. Inventory the email-keyed token rows in the sandbox token table (`pk ORG#…`, `sk FULLSCRIPT#<hash>`) without
      reading tokens. Run the reconciliation in `docs/fullscript-subject-binding-2026-10-16.md` §6, under review:
      revoke at Fullscript with that installation's own client, delete the row, keep an append-only log, and never
      re-key a row.
   4. Run the hosted probes in §7 of that document with fictional accounts on the sandbox.
   5. Keep `FULLSCRIPT_LAB_ORDERING_ENABLED=false` and `FULLSCRIPT_PRODUCTION_APPROVED=false`. Lab checkout is now
      held in source as well.
8. **The transitional lab host.** Run the four-persona probe in `docs/route-authority-unverified-2026-10-16.md` §2
   against the deployed host. Read its build identifier first. Only that record can move the four unverified cells.
9. **Not built; design only.** These need Brandon and counsel first, then a BLOCKED successor each:
   - the workforce identity disable, with Cognito `AdminUserGlobalSignOut` then `AdminDisableUser` on the workforce
     pool and IAM scoped to that pool;
   - the reviewed replacement-credential rebind;
   - the custodial access path for a closed clinic, and the closed-clinic legal hold.

## What not to do

- Do not apply any candidate to production.
- Do not restore a staging snapshot into production.
- Do not substitute PGlite or native evidence for the Aurora runs above.
- Do not edit a candidate to match a drifted parent. Its refusal is the check.
- Do not enable PHI, Fullscript, lab ordering, peptide or longevity tiers, or any release switch.
