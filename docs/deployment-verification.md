# Staging deployment verification gate (v3 — through migration 0025)

**Status: NOT RUN.** This gate requires the Railway STAGING backend and the
STAGING clinical Supabase project (`urcjiehlxoehievobezf` — its PERMANENT
designation; this project is never called "live" or "production").
The contract-fixture browser suites are
**supporting evidence only, never a substitute** — the gate is complete only
when every step below has run against the deployed stack. Record results in
the table at the bottom and commit the update.

Covers everything shipped through migration `0024`: tenancy + auth (0012–0020),
labs + ingestion (0013–0016), scheduling (0017), EMR encounters/notes/
signatures/addenda (0021), consent-gated recording + AI scribe (0022/0023),
and the differential-questions + clinical-lens engine (0024).

What HAS been verified without deployment (labeled honestly, none of it
replaces this gate):

- Browser workflows against the committed contract fixture: `live-tasks`
  (18), `live-scribe` (8), `live-lens` (5 — the milestone's 14-step lens
  gate), `mock-app` (14), locally and in GitHub Actions.
- All SECURITY DEFINER RPCs, RLS policies, tenant-isolation attacks, state
  machines, and the seed itself against the **staging clinical project** in
  rolled-back transactions (`supabase/tests/*.sql`).
- The production Docker image build (frozen lockfile, pinned Bun) in CI.
- Backend vitest (389) including the deployed-environment fixture-refusal
  guard and the 11 adversarial lens evaluations.

## Deployment posture (fail closed — no fixtures when deployed)

**Staging only, here.** The gate runs against the Railway STAGING
environment + the staging Supabase project — synthetic users and seed data
only. The desktop pins a persistent "Staging environment — synthetic data
only" banner whenever it is connected to a staging project. After the gate
passes, promote the SAME verified revision to a SEPARATE production
environment (see "Production (future)").

The backend REFUSES fixture providers whenever it detects a deployment
platform (`RAILWAY_*`, `FLY_APP_NAME`) or `DEPLOYED_ENVIRONMENT` is set:

- `SCRIBE_MODE=disabled` — the honest posture while no approved production
  provider exists: every scribe entry point answers "Not configured" and
  fails closed. (`live` also refuses until a provider is fully configured
  AND administrator-enabled, but implies a provider is expected; env flags
  are never proof — the BAA is an external, human-verified fact.) Leaving
  the mode unset does **not** fall back to fixture.
- `LENS_AI_MODE=disabled` — AI assistance off ("Not configured"). The
  deterministic (non-AI) lens engine runs regardless, independently.
- The desktop's live routes are gated by `NEXT_PUBLIC_USE_LIVE_API=true`;
  demo fallbacks (`CLINICAL_DEMO_*`, `CLINICAL_ORG_ID`) must NOT be set on a
  deployed desktop.

## Operator checklist (dashboard steps only the operator can do)

1. **Deploy the backend to a STAGING environment**: Railway → service from
   `rork-ai-longevity-coach` `main` (Dockerfile build; `railway.json` sets
   the `/health` healthcheck — the endpoint returns status/uptime/version
   only, no secrets, provider config, or patient data). Start with ONE
   replica (the rate limiter is process-local) in a region close to the
   clinical Supabase project (`us-east-2` → Railway US East). Variables
   (see `expo/backend/ENV.md`): `CLINICAL_SUPABASE_URL`,
   `CLINICAL_SUPABASE_ANON_KEY`, `CORS_ALLOWED_ORIGINS=<exact desktop
   origin(s) only>`, `SCRIBE_MODE=disabled`, `LENS_AI_MODE=disabled`,
   `NODE_ENV=production`. OMIT `SCRIBE_CALLBACK_SECRET` (only fixture/live
   modes use it; the disabled callback route answers not-configured without
   it). Keep the service-role key ABSENT. Confirm `GET /health` answers healthy
   and the boot log prints `deployment=deployed scribe_mode=disabled
   lens_ai_mode=disabled` (worker log: "workers not started" — worker
   absence never makes `/health` unhealthy).
2. **Create two synthetic practitioner logins** (P1, P2) through an
   ADMIN-CONTROLLED path only — Supabase Dashboard → Authentication → Add
   user (or an authorized invitation flow). Practitioner registration is
   never open public signup; keep signups disabled in Auth settings.
   Synthetic emails; never reuse real credentials. Put the temporary test
   credentials in PROTECTED environment secrets (Railway/CI/Claude
   environment secrets) — never chat, files, or repos — and rotate or
   remove them after testing.
3. **Run seed v2** (`supabase/seed/demo_practice_seed.sql`): edit the five
   marked lines (both UUIDs, both emails, `allow_demo_seed := true`) and run
   the whole file. It refuses on anything that looks like a real practice.
4. **Auth URL config** (only needed for email flows): staging Supabase →
   Auth → URL Configuration → Site URL = the STAGING desktop origin;
   allowlist `<staging desktop origin>/reset`. Production uses its own
   project with production-specific URLs — never shared.
5. **Desktop live environment**: build/run with
   `NEXT_PUBLIC_USE_LIVE_API=true`,
   `TRPC_BASE_URL=https://<railway-domain>/api/trpc`,
   `CLINICAL_SUPABASE_URL`, `CLINICAL_SUPABASE_ANON_KEY`. Do **not** set
   `CLINICAL_DEMO_*` or `CLINICAL_ORG_ID`.
6. **Network allowlist for the gate runner**: allow the EXACT clinical
   Supabase hostname and the EXACT generated Railway hostname only — no
   wildcards, no full network access.
7. **Protected CI secrets** (optional, after the gate): add `DEPLOYED_*`
   secrets in GitHub (`.github/workflows/ci.yml`) so the gated job re-runs
   the live suite against the deployed stack on every push. Use dedicated
   synthetic gate credentials, rotated by the operator.
8. **Promotion**: after the gate passes in staging, promote the same
   verified revision to production with providers still `disabled`.

## Production (future) — hard requirements

Production is a fully separate environment. It must receive:

- A NEW Supabase project (never `urcjiehlxoehievobezf`, which is staging
  forever).
- A separate Railway production environment/service.
- Separate storage buckets and separate secrets — nothing shared with
  staging.
- Migrations only — NO seed data, NO synthetic users, NO demo fixtures.
- Admin-created REAL practitioner accounts (invitation/admin flows only;
  public signup stays disabled).
- Production-specific authentication URLs and CORS origins.
- Providers remaining `disabled` until their contracts (BAA) and
  operational approval are complete — no environment flag is ever proof.

Seeded fixtures: Org A "Bright Longevity Clinic (Demo)" — P1 owner, P2
practitioner; patients Avery Demo (P1 only) + Jordan Sample (P1+P2); Avery
carries labs (hs-CRP high w/ history, vitamin D low, TSH reviewed, ferritin
low-confidence, **potassium critical**, sodium unclassified), an appointment,
tasks, a reasoning snapshot, and deliberate lens fixtures (Sertraline +
St. John's Wort → interaction caution; Penicillin VK + penicillin allergy →
conflicting chart data). Org B — P2 owner; patient Riley Crosscheck.
ALL SYNTHETIC.

## The 20-step deployed acceptance gate

Sign in as **P1** unless stated otherwise. Every step runs against the
staging backend + staging clinical project, with the staging banner
visible throughout.

| # | Step | Expected |
|---|---|---|
| 1 | Sign in; then expire the access token (edit the `aidp_exp` cookie to a past time) and navigate | Lands in the app; expired session refreshes silently with rotation; work continues |
| 2 | Organization selection; as **P2**, switch Org A → Org B in Settings | Org auto-selected from membership; switch swaps the working org |
| 3 | After the P2 switch, revisit `/clients`, `/tasks`, `/calendar` | Only Org B data anywhere; nothing cached from Org A leaks across the switch (and vice versa on switching back) |
| 4 | Open Avery Demo (P1) | Real header (name/MRN/DOB) from `patient_profiles`; P1 sees exactly Avery + Jordan, never Riley |
| 5 | Open Avery's labs; upload the synthetic PDF; open "source PDF (audited)" | Markers render with honest statuses (critical potassium, unclassified sodium, low-confidence ferritin); upload extracts + queues review; the authorized document streams and `document.viewed` lands in audit |
| 6 | Calendar → open Avery's appointment → start the encounter | Encounter workspace opens `in_progress`, linked to the appointment |
| 7 | Note lifecycle: type → autosave → reload → mark ready → sign → try to edit → addendum | Autosave v1 confirmed by the server; reload restores server copy; signing locks content (edits refused); addendum appends without changing the original |
| 8 | Patient timeline + `/audit-log` | Timeline shows encounter/note clinical events; audit shows server-owned rows for review/document/sign actions |
| 9 | Lens panel → run evaluation (western_conventional) | Deterministic run completes; invariant core shows URGENT critical-lab flag, the Sertraline+St. John's Wort interaction, and the penicillin conflict; provider line shows NO AI participation (deterministic only) |
| 10 | Run the evaluation under all six paradigms | The invariant-core panel is byte-identical under every lens; only framing/ranking of non-urgent domains changes; urgent domains stay pinned first |
| 11 | Question lifecycle: accept → ask → answer → correct → defer → dismiss (with feedback) | Transitions follow the 0024 map; the corrected answer preserves v1; dismissal requires structured feedback |
| 12 | Change supporting evidence (review/accept a marker on Avery) and reload the lens panel | Evaluation shows STALE with the reason; not-yet-asked questions become stale; asked/answered keep their state; re-run clears it |
| 13 | Accept a question with a draft note open, WITHOUT clicking add-to-note; then click "Add to note" | Accepting inserts nothing anywhere; only the explicit add-to-note writes into the draft (audited), and signed notes are never a target |
| 14 | Cross-tenant attacks: open Avery's URL as P2-in-Org-B; POST `/api/auth/org` with a forged org id | Refused (403/404); session org unchanged; no data leak |
| 15 | Scribe panel + lens AI status on the deployed stack | Both display an honest "Not configured" state and fail closed — fixtures are refused, recording cannot start, no fixture content appears anywhere, and no audio or chart data can reach any unapproved provider |
| 16 | With devtools network open, walk the recording/consent routes | Every request stays on the app + backend origins; CSP `connect-src 'self'`; no third-party request fires |
| 17 | Railway boot logs + worker behavior | Startup prints deployment/mode posture (names only); scribe workers do NOT start (no provider in live mode); no PHI, transcript text, question text, or tokens in any log line |
| 18 | Stop the backend (or point the desktop at a dead URL) mid-session; then restore | Desktop shows honest unavailable states with retry affordances — no fake data, no crash; recovery resumes cleanly |
| 19 | Full reload after steps 5–13 | Every authoritative state (review decisions, notes, signatures, question lifecycle, evaluations) persists server-side |
| 20 | Record results | Fill the table below: date, operator, deployed backend URL + git SHA, desktop SHA, per-step pass/fail, failures + follow-ups, screenshots where useful |

Suite form (supporting evidence for steps 1–8, run from this repo against the
deployed stack — the org-fixture control-endpoint tests are expected to skip
or fail verbatim and are covered manually):

```
NEXT_PUBLIC_USE_LIVE_API=true npm run build
E2E_LIVE=1 TRPC_BASE_URL=https://<railway-domain>/api/trpc \
  CLINICAL_SUPABASE_URL=<clinical url> CLINICAL_SUPABASE_ANON_KEY=<anon key> \
  CLINICAL_DEMO_EMAIL=<P1 email> CLINICAL_DEMO_PASSWORD=<P1 password> \
  CLINICAL_ORG_ID=a0000000-0000-4000-8000-000000000001 \
  npm run test:e2e -- e2e/live-tasks.spec.ts
```

## Results (fill in when executed)

**Gate status: NOT RUN — run attempt on 2026-07-19 BLOCKED in Preflight B
(staging Supabase rejects the runner's P1 credentials). Preflight A passed;
no gate steps were executed, the desktop was not built, and nothing on
Supabase or Railway was changed. Statuses/codes/operation names and row
counts only below — no credentials, tokens, emails, keys, or row contents.**

| Field | Value |
|---|---|
| Date / operator | 2026-07-19 (~22:30 UTC) / automated gate runner (Claude session) — **BLOCKED in Preflight B, gate not run** |
| Backend URL / commit | https://rork-ai-longevity-coach-production.up.railway.app / `c96ab6a` (not exercised beyond Preflight A transport) |
| Desktop commit | `2a79d57` (origin/main; build not attempted) |
| Steps passed | 0 of 20 attempted — all NOT RUN |
| Failures + follow-ups | Preflight B(1) password grant rejected; see attempt log below |
| Evidence (screenshots/logs) | None (no UI reached). HTTP statuses + error codes only, recorded below |

### Run attempt log — 2026-07-19 (blocked in Preflight B)

An earlier attempt the same day was blocked in Preflight A (runner
unprovisioned: five gate variables absent, egress denied). Both of those
blockers are RESOLVED in the current runner — this attempt got further and
stopped at credential validation instead.

Preflight A(1) — environment variables (names + present/absent only):
`GATE_P1_EMAIL`, `GATE_P1_PASSWORD`, `GATE_P2_EMAIL`, `GATE_P2_PASSWORD`,
`CLINICAL_SUPABASE_ANON_KEY` — all five present and non-empty.

Preflight A(2) — transport: HEAD `/rest/v1/` on the staging clinical
Supabase host with the `apikey` header → **HTTP 401 received**, which per
the gate's transport rule proves the transport is reachable (and is not
used to judge key validity either way).

Preflight B — signed-in comparison (P1):

| Probe | Result |
|---|---|
| B1: POST `/auth/v1/token?grant_type=password` (apikey header + P1 email/password JSON) | **Token acquired: no.** HTTP 400, `error_code=invalid_credentials` — identical on the initial attempt and the single permitted retry |
| B1 hygiene check (booleans only, values never read into output) | All five runner env values have no leading/trailing whitespace, no CR/LF, no wrapping quotes — the rejection is not a formatting artifact |
| B2: direct REST `organization_memberships` / `organizations` with P1 JWT | NOT ATTEMPTED — no token |
| B3: Railway tRPC `clinical.organizations.mine` with P1 JWT | NOT ATTEMPTED — no token |

Key-validity inference (allowed here — this is Preflight B, not the A(2)
transport probe): an invalid publishable key is rejected at the Supabase
gateway with HTTP 401 "Invalid API key" before auth logic runs. B1 instead
returned a GoTrue application-level **400 `invalid_credentials`**, so the
runner's `CLINICAL_SUPABASE_ANON_KEY` IS accepted by the staging project;
the failure isolates to the **P1 email/password pair** as provisioned in
the runner environment (wrong/rotated password, or the synthetic user no
longer exists — GoTrue deliberately does not distinguish these).

Decision per the gate protocol: the signed-in entry condition failed →
STOP. No fixes, no retries beyond the one permitted, no gate steps run.
The earlier desktop failures can NOT yet be attributed to stale
cookies/demo routing — that comparison never became possible.

Follow-ups required before a re-run (operator actions only, no code
changes):

1. In the staging Supabase project (Authentication → Users), confirm the
   two synthetic practitioner accounts (P1, P2) still exist. The operator
   checklist itself mandates rotating/removing test credentials after
   testing — if a rotation or cleanup happened after the last run, the
   runner secrets are stale by design.
2. Re-sync the CURRENT P1/P2 passwords (or recreate the users via the
   admin-controlled path, checklist item 2, re-running seed v2 if the
   auth users were recreated with new UUIDs, checklist item 3) into the
   runner environment secrets `GATE_P1_EMAIL`, `GATE_P1_PASSWORD`,
   `GATE_P2_EMAIL`, `GATE_P2_PASSWORD`.
3. Re-run the gate from Preflight A. Runner environment and transport are
   now proven good; the anon key is proven accepted. Nothing about backend
   `c96ab6a`, desktop `2a79d57`, or either host was changed by this
   attempt.

### Run attempt 3 — 2026-07-20T08:20Z (coordinating session, fresh container; blocked in Preflight B)

Environment provisioning and network policy are now PROVEN GOOD from the
coordinating session itself: all five gate variables present; Supabase
transport reachable (HEAD `/rest/v1/` → 401 per the transport rule); Railway
`GET /health` → 200. Preflight B (statuses/codes only):

| Probe | Result |
|---|---|
| B1: P1 password grant | HTTP 400 `invalid_credentials` (single attempt) |
| B1': P2 password grant | HTTP 400 `invalid_credentials` (single attempt) |

Both stored password values remain out of sync with staging auth (the
database-side passwords were last verified working 2026-07-19 ~01:25Z via
successful `action: login` events). Remaining operator action: re-sync
`GATE_P1_PASSWORD`/`GATE_P2_PASSWORD` with the working passwords, or set
fresh ones in both the SQL editor and the environment secrets in one
sitting. Everything else is ready; the coordinating session will auto-retry
the sign-in and start the full gate the moment credentials validate.
