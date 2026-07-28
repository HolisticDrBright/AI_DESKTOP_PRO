# Desktop-owned identity and patient directory

This slice moves practitioner authentication, organization selection and
membership management, and patient-directory reads into `AI_DESKTOP_PRO`.
It does not add code or branches to AI Longevity Pro.

## Request path

```
browser
  → same-origin Next.js route or server component
  → Desktop server adapter
  → Supabase Auth or Data API
  → authenticated role + practitioner JWT
  → grants + RLS / guarded RPC
```

The browser never receives the Supabase publishable key, access token, refresh
token, or a database client. The Desktop server never uses a service-role key.

## Authorization rules

- `list_my_organizations()` is `SECURITY INVOKER` and returns only the
  caller's active memberships in active, non-deleted organizations.
- The selected organization cookie is a UI selector, not authorization.
- Patient list and direct patient URL reads include the selected organization
  filter and are still constrained by `patient_profiles` RLS.
- Membership writes continue through the audited migration-0020 functions;
  owner/admin, self-removal, and last-owner rules remain database-enforced.
- Member management links an existing Auth account. It does not silently
  create users or claim to send an invitation email.
- Refresh-token rotation retains the validated selected organization.
- Sign-out requests Supabase `scope=local` revocation, then clears every local
  auth cookie even if the identity provider is unavailable.

## Database change

Migration `20260728210837_desktop_owned_identity_directory.sql` adds the
caller-scoped organization-list function and explicit `authenticated` Data API
grants for `organizations`, `organization_memberships`, and
`patient_profiles`. Grants expose objects to PostgREST; RLS still decides
which rows are visible.

The rolled-back acceptance suite is
`supabase/tests/desktop_identity_directory.sql`.

## Verification

- Database acceptance suite against the clinical project: **6/6**.
- Adapter and auth unit suite: **39/39** across all unit test files.
- Mock browser suites: **41/41**.
- Full live-mode contract fixture: **31/31** across tasks/auth/orgs, scribe,
  lens, labs, scheduling, EMR, and audit.
- Typecheck, lint, and live production build: green.

The fixture deliberately exercises the same browser/server contracts with
synthetic in-memory data. A signed-in run against the deployed staging stack is
still required before calling the deployment gate complete.
