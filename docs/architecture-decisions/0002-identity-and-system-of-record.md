# ADR 0002 — Identity provider and clinical system of record

- **Status:** Accepted (2026-07-15)
- **Owners:** HolisticDrBright (product), platform engineering
- **Depends on:** ADR 0001 (clinical data isolation)
- **Applies to:** `AI_DESKTOP_PRO` (desktop app + clinical schema),
  `rork-ai-longevity-coach` (shared backend + Expo mobile app)

## Context

ADR 0001 split clinical PHI into the dedicated project
(`urcjiehlxoehievobezf`). The Expo mobile app still authenticates against the
legacy shared project. That leaves **two `auth.users` pools**, and the product
goal — "the AI Longevity mobile app plugs into the desktop platform" — is
impossible until exactly one identity is authoritative for a given human.

Options considered:

1. **Single Supabase Auth (clinical project) for both apps** — one user pool;
   the mobile app re-points its auth at the clinical project when it plugs in.
2. **Federated identity with a mapping table** — both pools live on; a
   `user_links` table maps legacy ids ↔ clinical ids and a sync process keeps
   them coherent.

## Decision

**Option 1 — single identity provider.** The dedicated clinical project's
Supabase Auth is the identity provider for BOTH apps, and the clinical project
is the **system of record for all clinical PHI**.

- New signups (desktop and, after cutover, mobile) are created only in the
  clinical project's `auth.users`.
- Mobile clinical reads/writes target the clinical project **via the shared
  authenticated tRPC backend** — never directly.
- Legacy clinical data is migrated **once**, through the staged import path
  (detect → map → resolve conflicts → preview → commit-to-review-queue, with
  `source` + `source_record_id` preserved and practitioner review before any
  row becomes chart data). Never a silent bulk copy.
- Federation (Option 2) is explicitly rejected: a permanent two-pool world
  doubles the attack surface for account-takeover, makes "who is this user" a
  sync problem in a PHI system, and every future feature pays the mapping tax.

### Transitional state (explicitly allowed, time-boxed)

Until the mobile cutover ships, the shared backend accepts **both** token
pools, routed by procedure family — legacy procedures (`clinic.*`,
`nutrition.*`, `supplements.*`) validate against the legacy project exactly as
today; clinical procedures (`clinical.*`) validate against the clinical
project (`backend/trpc/clinical-authorization.ts`). A token is only ever valid
in its own pool; nothing cross-validates. This keeps the mobile app fully
working while the desktop goes live, with no forked backend.

## Identity linkage specification

All columns below refer to the **clinical** project's `auth.users`.

| Column | Meaning |
| --- | --- |
| `practitioner_profiles.user_id` (not null) | The practitioner's login. Created by admin invitation; membership row in `organization_memberships` carries the role. |
| `patient_profiles.user_id` (nullable) | The patient's own login, **only if/when the patient uses the patient-facing app**. Org-owned patient records exist and function with `user_id is null`. |
| `organization_memberships.user_id` | Staff/practitioner/admin/owner membership; `private.is_org_member / has_org_role / is_org_admin` read this. |

**How a mobile patient account links to an org-owned `patient_profiles` row:**

1. The practice creates (or imports) the `patient_profiles` row — no login yet.
2. A practitioner/admin issues a patient invitation: a single-use, expiring
   token whose **hash** is stored (`invitations`, hashed per migration 0012 —
   tokens are credentials and are never stored in plaintext).
3. The patient installs the app, authenticates against the clinical project
   (creating their `auth.users` row), and presents the invitation token.
4. The backend (service role, server-side only) verifies the token hash +
   expiry, then sets `patient_profiles.user_id = auth.users.id` for exactly
   that org's patient row, and marks the invitation accepted. This is the ONLY
   path that links a login to a patient record — patients can never self-link
   by guessing ids.
5. From then on `private.can_access_patient()` grants the patient-self lane:
   the patient reads their own record; writes remain role-gated per the
   policy split (migration 0012) until per-table patient-writable
   classifications are deliberately opened (journals, symptoms, device data).

**Legacy → clinical user migration (at mobile cutover):** legacy accounts are
invited into the clinical pool by email (same claim flow as above; email match
is a hint, the token is the proof). Legacy `auth.users` ids appear in clinical
tables only as `source_record_id` provenance on imported rows, never as
foreign keys.

## Consequences

- One human = one identity = one `auth.uid()` for every RLS gate. No mapping
  table, no sync daemon, no split-brain.
- The mobile app takes a one-time auth cutover (new project URL/keys + session
  re-login + invitation claim). This is scheduled work, gated on this ADR, and
  does not block any desktop work.
- Until cutover, mobile users cannot see clinical-project data — this is the
  current behavior, unchanged; the transitional dual-pool backend is additive.
- **Rollback:** pre-cutover, none needed (legacy untouched). Mid-cutover, the
  legacy pool still exists; re-pointing the mobile app back is a config
  change. Post-migration rollback of imported data follows the import audit
  trail (`source_record_id`) — imports are reversible by construction.
