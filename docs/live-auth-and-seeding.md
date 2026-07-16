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

### Where each invitation-security property lives

Invitation tokens are **delegated to Supabase Auth (GoTrue)** rather than a
hand-rolled token table — the auth server already implements the hard parts:

| Requirement | Enforced by |
|---|---|
| Expiring, single-use tokens | GoTrue invite/recovery links: hashed one-time tokens with server-side expiry; consumed on first successful use (our e2e proves the reused/expired path gets an honest error) |
| Server-side hashing | GoTrue stores token hashes, never raw tokens; the raw token exists only in the emailed link's URL fragment (read once by `/reset`, stripped from the URL bar) |
| Organization + intended role | `organization_memberships` row created at invite time (`role`, `organization_id`), status `invited` |
| Inviter identity | `organization_memberships.created_by` + the `member.invited` audit event's actor |
| Accepted / revoked / expired state | Accepted: `activate_my_memberships()` flips `invited → active` on the invitee's first sign-in (audited as `member.joined`). Revoked: `remove_org_member()` deletes the pending membership (audited). Expired email link: the auth token expires server-side; the membership stays `invited` and the roster shows it truthfully — re-invite is not blocked |
| Audit events | `member.invited` / `member.joined` / `member.role_changed` / `member.removed`, written atomically inside the SECURITY DEFINER RPCs |
| No elevated role from browser input | The role in the invite call is validated inside `add_org_member`: admins can grant up to `admin`; **only an owner can grant `owner`**; the caller's own role comes from the database, never the request |

**Email delivery — externally blocked:** actual delivery uses the Supabase
project's email sender (built-in for low volume; configure SMTP under Auth →
Email for production). The sandbox cannot reach the auth server, so delivery
has not been exercised end-to-end; the send call, both invite outcomes, and
all failure states are implemented and covered by backend tests + the
contract-fixture e2e. Setup: Supabase Auth → URL Configuration (Site URL +
`/reset` redirect) and, for brand-new-email invites, the two backend env vars
above.

## Seeding the clinical project (seed v2)

`supabase/seed/demo_practice_seed.sql` creates **two** synthetic practices
(NO real PHI) so tenancy and access rules can be exercised with real logins:

- **Org A — Bright Longevity Clinic (Demo)**: P1 (owner) + P2 (plain
  practitioner); patients **Avery Demo** (P1 only) and **Jordan Sample**
  (P1 + P2); a source lab document; observations incl. hs-CRP history for
  trends, one **reviewed** marker (TSH), one **critical** result (potassium
  6.2), one **unclassified** marker (Sodium, no lab flag → the app must show
  "Unclassified"), one **low-confidence 0.55** extraction (review-gated);
  three tasks (one org-level); appointments (in-person, telehealth, break);
  reasoning snapshot + hypotheses; a draft protocol; audit events.
- **Org B — Second Practice (Demo)**: P2 is the **dual-org** practitioner
  (owner here); patient **Riley Crosscheck** (P2 only); a lab document +
  observation, one task, one appointment, audit events.
- **Access matrix** the deployed gate verifies: P1 → Avery ✓ Jordan ✓
  Riley ✗ · P2 → Jordan ✓ (Org A) Riley ✓ (Org B) Avery ✗.

Steps:

1. **Create two logins**: Supabase Dashboard → Authentication → *Add user*,
   twice (P1 and P2). Copy both **UUIDs**.
2. **Edit the five marked lines** at the top of the seed's DO block: both
   UUIDs, both emails, and `allow_demo_seed := true`.
3. **Run the whole file** in the Supabase SQL editor. It is **idempotent**
   (fixed UUIDs + `ON CONFLICT DO NOTHING`) — safe to re-run, never
   duplicates, never overwrites rows you've edited.
4. Sign in at `/login` as P1 or P2 — the organization comes from the
   account's own memberships (no `CLINICAL_ORG_ID` needed).

**Production guard:** the seed **refuses to run** unless the
`allow_demo_seed := true` override is edited in by hand, and refuses when the
database contains organizations it did not create (a sign it is not a
disposable demo environment). This is a development/staging tool only.

The desktop app never needs the service-role key — the seed runs once in the
SQL editor (as `postgres`, which is why the append-only `audit_events`
examples are allowed); everything the app does afterwards goes through RLS
and the SECURITY DEFINER RPCs as your signed-in user.

**Verified (rolled back, real project):** the guard refuses without the
override; with temporary auth users substituted, a double run applies cleanly
and is a no-op the second time; all fixtures land (critical, unclassified,
reviewed, low-confidence, 4 tasks, 4 appointments, audit in both orgs); and
under role-switched RLS the access matrix holds exactly (P1 sees Avery+Jordan
only; P2 sees Jordan+Riley only; P2's memberships span both orgs) — 14/14
checks.

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
