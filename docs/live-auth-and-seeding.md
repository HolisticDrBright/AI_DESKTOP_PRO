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
`CLINICAL_SUPABASE_URL`, `CLINICAL_SUPABASE_ANON_KEY`. See `.env.example`.
(`CLINICAL_ORG_ID` is now only a local/e2e fallback — see below.)

## Organization selection (authenticated, not env-based)

The active organization is a **per-session choice validated against the
signed-in practitioner's real memberships**, not a deployment constant:

- On sign-in, `/api/auth/login` fetches the practitioner's memberships
  (`clinical.organizations.mine`, which reads `org_members` under RLS) and
  auto-selects the first one into an httpOnly `aidp_org` cookie.
- `GET /api/auth/org` lists the caller's memberships + the active org;
  `POST /api/auth/org` switches — the server re-validates that the requested
  org is one of the **caller's own memberships** and answers `forbidden`
  otherwise. The browser can never pick an arbitrary org id.
- Settings → **Data source & environment** shows the active organization
  (name + role) and, when the practitioner belongs to more than one org, an
  **organization switcher**.
- Every live adapter call threads the session's org id through to the
  backend, which re-enforces membership inside RLS and the SECURITY DEFINER
  RPCs — the cookie is a selector, never an authority.

**Env fallback (local/e2e only):** `CLINICAL_ORG_ID` fills in when the
session has no org cookie (contract-fixture runs, headless local). With it
unset — the correct state for a real deployment — a session with no selected
organization gets an honest "No organization selected" error instead of
silently reading another tenant's default.

## Password reset

- **Request**: on `/login`, "Forgot password? Email me a reset link" posts to
  `/api/auth/reset` → Supabase `auth/v1/recover`. The confirmation copy is
  identical whether or not the account exists (enumeration-safe), and the
  endpoint is rate-limited per IP.
- **Complete**: the emailed link opens `/reset` with a one-time recovery
  token in the URL **fragment** (never sent to a server by the browser). The
  page reads it once, strips it from the URL bar, and posts the new password
  to `/api/auth/reset-complete`, which calls Supabase `PUT /auth/v1/user`
  with the recovery token and then clears all session cookies so the
  practitioner signs in fresh with the new password.
- Expired/invalid recovery links get an honest "This reset link is invalid
  or has expired" error — no fake success.
- For the emailed link to point at the app, set the Supabase project's
  **Auth → URL Configuration → Site URL** to the deployed desktop origin and
  add `https://<desktop-domain>/reset` to the redirect allowlist.

## Team members & invitations

Settings → **Organization members** (admins and owners only; everyone else
sees an honest explanation instead of dead controls):

- **Roster** — email, profile name, role, and truthful status
  (Active / *Invited — hasn't signed in yet* / Suspended).
- **Invite by email** — an existing account is linked immediately as an
  `invited` membership and activates on that person's next sign-in. A
  brand-new email additionally gets an auth account + invitation email (they
  set a password on the `/reset` page). Duplicate invites are refused with a
  clear message.
- **Role changes and removal** — removal requires an explicit confirmation.
  The rules are enforced inside the database RPCs (migration 0020), not just
  the UI: only owners grant/revoke the owner role, the last owner can never
  be demoted or removed, and you cannot remove yourself. Every membership
  change writes an audit event (`member.invited` / `member.role_changed` /
  `member.removed` / `member.joined`).

Backend requirements: inviting a **brand-new** email needs
`CLINICAL_SUPABASE_SERVICE_ROLE_KEY` on the backend — its ONLY use is the
`auth.admin.inviteUserByEmail` call (it never touches clinical tables; the
membership row is written through the caller's RLS-scoped RPC). Optional
`CLINICAL_DESKTOP_URL` points invitation links at the deployed desktop's
`/reset`. Without the service key, adding existing accounts still works and
the new-email path fails honestly.

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
PDF upload → extraction → low-confidence review-queue item → audit, the live
calendar (check-in persisting across reload + booking a new appointment),
the persistent audit log, and a console-error sweep against the real stack.
(In sandboxes that block `*.supabase.co`, the same suite runs against the
committed contract fixture instead — see `docs/live-api.md`.)
