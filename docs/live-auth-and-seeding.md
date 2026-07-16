# Live auth & seeding

How a real practitioner signs in, and how to give the clinical project its
first data. Demo mode needs none of this — with no env, the app stays fully
mock/session and `/login` says so.

## Sign-in (live mode)

Live mode uses **real Supabase Auth** against the clinical project, handled
entirely server-side:

- `/login` posts email/password to `/api/auth/login`, which does the password
  grant against `CLINICAL_SUPABASE_URL/auth/v1/token` and stores the session
  in **httpOnly cookies** (`aidp_at/rt/exp/em`). Tokens never reach browser
  JavaScript and there is no Supabase client in the browser bundle.
- Every `/api/live/*` call presents the cookie session's access token to the
  tRPC backend as a bearer, so **RLS runs as the signed-in practitioner**.
- `/api/auth/session` reports state and rotates near-expiry sessions
  (Supabase refresh-token grant); `/api/auth/logout` clears the cookies.
- Signed-out or expired sessions surface as a distinct clinical-safe state
  with a **Sign in** action (`unauthenticated`) — different from
  `forbidden`, which means signed in but not permitted for that record.
- Settings → **Data source & environment** shows: mock mode / live signed-out
  / live signed-in (with email + sign-out) / backend-unavailable errors
  surface on the screens themselves.

**Env fallback (local/e2e only):** if `CLINICAL_DEMO_EMAIL/PASSWORD` are set,
the server uses them when no cookie session exists. This exists solely for
the contract-fixture e2e suite and headless local runs — do **not** set these
in a real deployment.

Required env (live): `NEXT_PUBLIC_USE_LIVE_API=true`, `TRPC_BASE_URL`,
`CLINICAL_SUPABASE_URL`, `CLINICAL_SUPABASE_ANON_KEY`, `CLINICAL_ORG_ID`.
See `.env.example`.

## Seeding the clinical project

`supabase/seed/demo_practice_seed.sql` creates one synthetic practice
(NO real PHI): organization **Bright Longevity Clinic (Demo)**, your
practitioner membership + profile, patient **Avery Demo**, the
practitioner↔patient access row, one lab document, 5 biomarker definitions,
6 observations (hs-CRP history for trends, one abnormal, one **low-confidence
0.55** to exercise the review gate), 2 review-queue items (one org-level),
a reasoning snapshot + 2 hypotheses, 1 draft supplement protocol, and 3
example audit events.

Steps:

1. **Create your login**: Supabase Dashboard → Authentication → *Add user*
   (email + password). Copy the new user's **UUID**.
2. **Edit two lines** at the top of the seed's DO block:
   `practitioner_user_id := '<that UUID>'` and
   `practitioner_email := '<that email>'`. The script refuses to run with the
   placeholder and verifies the auth user exists.
3. **Run the whole file** in the Supabase SQL editor. It is **idempotent**
   (fixed UUIDs + `ON CONFLICT DO NOTHING`) — safe to re-run, never
   duplicates, never overwrites rows you've edited.
4. Set `CLINICAL_ORG_ID=a0000000-0000-4000-8000-000000000001` in the desktop
   env, sign in at `/login`, and the queue/labs/audit screens load the seeded
   records.

The desktop app never needs the service-role key — the seed runs once in the
SQL editor (as `postgres`, which is why the append-only `audit_events`
examples are allowed); everything the app does afterwards goes through RLS
and the SECURITY DEFINER RPCs as your signed-in user.

**Verified:** the exact seed (with a temporary auth user substituted) was run
against the real project inside a rolled-back transaction — all inserts pass
the live constraints, a second run is a clean no-op, and under role-switched
RLS the seeded practitioner sees 2 queue rows + 6 observations and
`resolve_review_queue_item` returns `resolved`.

## Deployed-environment verification (run after Railway deploy)

From this repo, with the backend deployed (see
`rork-ai-longevity-coach/docs/deploy-railway.md`) and the seed applied:

```
NEXT_PUBLIC_USE_LIVE_API=true npm run build
E2E_LIVE=1 TRPC_BASE_URL=https://<railway-domain>/api/trpc \
  CLINICAL_SUPABASE_URL=<clinical url> CLINICAL_SUPABASE_ANON_KEY=<anon key> \
  CLINICAL_DEMO_EMAIL=<seeded email> CLINICAL_DEMO_PASSWORD=<password> \
  CLINICAL_ORG_ID=a0000000-0000-4000-8000-000000000001 \
  npm run test:e2e -- e2e/live-tasks.spec.ts
```

This exercises sign-in/sign-out, live queue load, resolve → reload
persistence, the labs workspace + marker review → reload persistence, a lab
PDF upload → extraction → low-confidence review-queue item → audit, the
persistent audit log, and a console-error sweep against the real stack. (In
sandboxes that block `*.supabase.co`, the same suite runs against the
committed contract fixture instead — see `docs/live-api.md`.)
