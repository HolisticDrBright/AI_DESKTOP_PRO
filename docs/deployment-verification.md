# Deployed real-data verification gate

**Status: NOT RUN.** This gate requires a deployed backend (Railway) and
dashboard actions in the clinical Supabase project — credentials and console
access only the operator has. Nothing below has been executed against a
deployed environment, and the contract-fixture browser suite is **not** a
substitute for this run. When the gate is executed, record the results in the
table at the bottom and commit the update.

What HAS been verified without deployment (labeled honestly, none of it
replaces this gate):

- The full browser workflow against the committed contract fixture
  (`e2e/live-tasks.spec.ts`, 17 tests) — locally and in GitHub Actions.
- All SECURITY DEFINER RPCs, RLS policies, tenant-isolation attacks, and the
  seed itself against the **real clinical project** in rolled-back
  transactions (`supabase/tests/*.sql`, seed access-matrix run).
- The production Docker image build (frozen lockfile, pinned Bun) in CI.

## Operator checklist (the steps only you can do)

1. **Deploy the backend**: Railway → new service from
   `rork-ai-longevity-coach` (Dockerfile build; `railway.json` already sets
   the `/health` healthcheck). Set env per `expo/backend/ENV.md`:
   `CLINICAL_SUPABASE_URL`, `CLINICAL_SUPABASE_ANON_KEY`,
   `CORS_ALLOWED_ORIGINS=<desktop origin>`; optional
   `CLINICAL_SUPABASE_SERVICE_ROLE_KEY` + `CLINICAL_DESKTOP_URL` for
   new-email invitations. Confirm `/health` answers `healthy`.
2. **Create two practitioner logins**: Supabase Dashboard → Authentication →
   Add user, twice (P1, P2). Copy both UUIDs.
3. **Run the seed**: edit the five marked lines in
   `supabase/seed/demo_practice_seed.sql` (both UUIDs, both emails,
   `allow_demo_seed := true`) and run the whole file in the SQL editor.
   It refuses to run on anything that looks like a real environment.
4. **Auth URL config**: Supabase → Auth → URL Configuration → set Site URL to
   the deployed desktop origin and allowlist `<desktop origin>/reset`.
5. **Deploy or start the desktop** with `NEXT_PUBLIC_USE_LIVE_API=true`,
   `TRPC_BASE_URL=https://<railway-domain>/api/trpc`,
   `CLINICAL_SUPABASE_URL`, `CLINICAL_SUPABASE_ANON_KEY`. Do **not** set
   `CLINICAL_DEMO_*` or `CLINICAL_ORG_ID` — those are local/e2e fallbacks.
6. Either walk the 15 steps below by hand, or add the `DEPLOYED_*` secrets in
   GitHub (see `.github/workflows/ci.yml`) so the gated job runs the suite
   against the deployed stack on every push.

## The 15-step gate

Sign in as **P1** (owner of Org A) unless stated otherwise. Seeded data:
Org A has patients Avery Demo + Jordan Sample; Org B has Riley Crosscheck;
P2 belongs to both orgs (practitioner in A, owner of B).

| # | Step | Expected |
|---|---|---|
| 1 | `/login` → sign in as P1 | Lands on the app; Settings shows the account email |
| 2 | Organization | Org A auto-selected from membership (Settings → Data source shows it) |
| 3 | Open `/clients` | Real directory renders |
| 4 | Authorized patients only | P1 sees **exactly** Avery + Jordan, never Riley |
| 5 | Open Avery's summary | Real header (name/MRN/DOB), honest not-yet-live panels |
| 6 | Open Avery's labs | hs-CRP **High**, Vitamin D **Low**, Potassium **Critical**, Sodium **Unclassified** ("Not provided" confidence), TSH already reviewed |
| 7 | "Open source PDF (audited)" | Original document streams; `document.viewed` lands in audit |
| 8 | Review a marker (accept hs-CRP) | Saves; reload keeps it; audit row written |
| 9 | Resolve the critical-potassium task (or create follow-up) | State changes persist |
| 10 | Reload the browser | Steps 8–9 results still present (server persistence, not client state) |
| 11 | `/audit-log` | Shows the review/resolve/document events with server-owned text |
| 12 | Sign in as **P2**, switch Org A → Org B in Settings | After switch: only Riley visible; no Org A tasks/patients anywhere |
| 13 | Cross-tenant attempt: open Avery's URL as P2-in-Org-B; POST `/api/auth/org` with Org A's id while P2's membership to A is removed | Refused (404/403); no data leak |
| 14 | Expire the access token (wait out expiry or edit the `aidp_exp` cookie to a past time) | Next navigation silently refreshes with rotation; work continues |
| 15 | Revoke the session (Supabase → Auth → user → sign out everywhere) | App clears the session and lands on `/login` — no loop, no stale data |

Suite form of the same gate (run from this repo against the deployed stack):

```
NEXT_PUBLIC_USE_LIVE_API=true npm run build
E2E_LIVE=1 TRPC_BASE_URL=https://<railway-domain>/api/trpc \
  CLINICAL_SUPABASE_URL=<clinical url> CLINICAL_SUPABASE_ANON_KEY=<anon key> \
  CLINICAL_DEMO_EMAIL=<P1 email> CLINICAL_DEMO_PASSWORD=<P1 password> \
  CLINICAL_ORG_ID=a0000000-0000-4000-8000-000000000001 \
  npm run test:e2e -- e2e/live-tasks.spec.ts
```

(The org-fixture-specific tests — membership roster, multi-org switching,
revocation — assume the contract fixture's control endpoints and will not all
pass verbatim against a deployed stack; the manual steps 12–13 above cover
those behaviors with the seeded dual-org practitioner instead.)

## Results (fill in when executed)

| Field | Value |
|---|---|
| Date / operator | _not yet run_ |
| Backend URL / commit | _not yet run_ |
| Desktop URL / commit | _not yet run_ |
| Steps passed | _not yet run_ |
| Failures + follow-ups | _not yet run_ |
