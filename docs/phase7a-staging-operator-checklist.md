# Phase 7A operator checklist — staging activation of the patient-sync bridge

Status as of 2026-07-30 (UTC): every code, test, migration-file, and review
gate below the infrastructure line is DONE and green. What remains is
exclusively operator-provisioned infrastructure that does not exist yet and
cannot be created from automation credentials. **PRs
`rork-ai-longevity-coach#18` and `AI_DESKTOP_PRO#21` stay unmerged and AI
Longevity Pro stays unconnected until the acceptance gate at the bottom
passes on real staging services.**

Verified infrastructure facts (by safe identifier):

- Reachable Supabase org `pjhkzzztlkidfjlkilth` contains ONLY
  `urcjiehlxoehievobezf` (AI Desktop Pro clinical, ACTIVE, us-east-2) plus
  two INACTIVE non-ALP projects (`iwrqvrfklmyppfhrikfb`,
  `pmrhvztjvnmprrhcrmom`). **There is no ALP Supabase project in scope and
  no ALP STAGING project anywhere known.**
- The only known ALP deployment is PRODUCTION: Fly app
  `expo-sunlit-resonance-4543` (region `sin`). Per policy it must NOT be
  used for Phase 7A.
- No Fly CLI/credentials exist in the automation environment; the desktop
  repository has no deployment configuration, so no desktop web or
  sync-worker staging deployment exists.
- Desktop clinical staging database: `urcjiehlxoehievobezf` (migrations
  through `20260730231721` applied; this doubles as the staging DB until a
  separate clinical staging project is provisioned — if one is created
  instead, apply `supabase/migrations/*` in ledger order first).

## Operator steps (in order; each is blocking for the next)

1. **Create the ALP STAGING Supabase project** (new project; never reuse
   production). Record its project ref. Prove the ref before touching it:
   `select current_database()` + empty `supabase_migrations.schema_migrations`
   ledger expected.
2. **Apply the receiver migration once** to that project:
   `expo/supabase/migrations/20260730231500_patient_sync_receiver.sql`
   (from PR #18's head). Confirm the ledger records exactly one entry and
   local/remote versions agree. Run the security + performance advisors.
3. **Create the ALP STAGING Fly app** (new app, e.g. `alp-staging-sync`;
   region operator's choice) from `expo/backend/Dockerfile` at PR #18's
   head revision. Public signup must remain disabled; synthetic accounts
   only via the admin path.
4. **Set ALP staging secrets** (Fly secrets; never in chat, never
   `EXPO_PUBLIC_*`): `PATIENT_SYNC_ENABLED=true`,
   `PATIENT_SYNC_INBOUND_SECRET`, `PATIENT_SYNC_INBOUND_KEY_ID`,
   `PATIENT_SYNC_OUTBOUND_URL` (the desktop worker callback base URL from
   step 6), `PATIENT_SYNC_OUTBOUND_SECRET`, `PATIENT_SYNC_OUTBOUND_KEY_ID`,
   `SYNC_SUPABASE_SERVICE_ROLE_KEY` (staging project's key),
   `EXPO_PUBLIC_SUPABASE_URL`/`EXPO_PUBLIC_SUPABASE_ANON_KEY` (staging
   project). Verify `/health` returns no secrets or identifiers and that
   `/patient-sync/v1/envelopes` answers 401 to unsigned requests.
5. **Provision the desktop staging web app** (host of choice) from
   `AI_DESKTOP_PRO` PR #21's head with `APP_EDITION=clinical` and the
   staging `CLINICAL_SUPABASE_*` values.
6. **Provision the desktop sync-worker staging process** (separate
   process/machine): `node scripts/sync/worker.mjs --callback-port <port>`
   with `SYNC_PROVIDER=alp`, `SYNC_WORKER_SUPABASE_URL`,
   `SYNC_WORKER_SERVICE_ROLE_KEY`, `SYNC_WORKER_ORG_ID` (the synthetic
   staging organization), `SYNC_ALP_BASE_URL` (step 3's app),
   `SYNC_ALP_OUTBOUND_SECRET`/`SYNC_ALP_KEY_ID` (matching step 4's inbound
   pair), `SYNC_CALLBACK_SECRET`/`SYNC_CALLBACK_KEY_ID` (matching step 4's
   outbound pair). Expose the callback port to the ALP staging app only
   (approved origins recorded); confirm `/api/health` on the web app is
   independent of the worker.
7. **Register the provider** for the synthetic staging organization ONLY:
   insert the CONNECTED `alp_patient_sync` connector row (the governed
   registry act). Confirm Integrations shows posture "Approved provider
   (alp_patient_sync)" — never "Fixture test" — and that removing any one
   `SYNC_ALP_*` secret makes the worker refuse (`alp configuration
   incomplete`).
8. **Create the synthetic cohort** through admin paths: two synthetic
   practitioners in different staging organizations, two synthetic
   patients (one to connect, one never connected), one cross-tenant
   adversarial case. No real patient data anywhere.
9. **Run the 30-step synthetic acceptance gate** exactly as written in
   Phase 7A Part 5 (invitation → redemption → refusals → scoped consent →
   share → real worker delivery → receiver receipts → patient
   acknowledgment/adherence → desktop review → idempotency/out-of-order/
   tamper/expiry/replay/cross-tenant refusals → withdrawal → no-resend on
   re-grant → explicit reshare generation → revocation both ways → timeout/
   retry/circuit/dead-letter/reconciliation → tombstones → no silent
   mutation → no auto-sign/order/charge/send → zero PHI/secrets in logs →
   tenant invisibility → zero production traffic → fixture cleanup per
   staging policy). Record UTC timestamps, revisions, operation ids, and
   status codes — never tokens, keys, signatures, or payload text.
10. **Only after 9 passes end-to-end:** mark rork#18 ready → confirm final
    head → merge FIRST; smoke ALP main. Then AI_DESKTOP_PRO#21 ready →
    confirm CI on final head → merge SECOND; smoke desktop main. Redeploy
    merged revisions to staging, repeat the core smoke workflow, leave
    production disabled, and update both repos' docs with merged SHAs and
    acceptance results.

Rollback at any point: remove the connector row (desktop stops sending),
then unset `PATIENT_SYNC_ENABLED` (receiver unmounts). Nothing received is
deleted. Sender first, always.
