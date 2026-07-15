# Live API path (Item 6) — status & verification

The desktop consumes data through the adapter façade (`src/adapters/index.ts`).
Item 6 swapped **one namespace — `patients`** — from mock to the authenticated
tRPC backend, behind a feature flag, with the rest still mock.

## What is wired

- **Flag:** `NEXT_PUBLIC_USE_LIVE_API` (default off → mock). See
  `src/adapters/config.ts`.
- **Path:** desktop server code → `src/adapters/trpc.server.ts` (dependency-free
  tRPC HTTP client) → the shared backend's `clinical.*` namespace → clinical
  Supabase under RLS. The desktop **never** talks to Postgres/Supabase data
  directly (ADR 0002); the only Supabase call it makes is identity
  (`session.server.ts`, a demo bootstrap until the real login ships).
- **Swapped:** `api.patients.list` and `api.patients.get` map real
  `patient_profiles` rows to `PatientDirectoryEntry` (clinical fields real;
  presentation-only fields — avatar, goals, care team, visit dates — defaulted
  and clearly not DB-backed).
- **Not swapped (still mock, flag or no flag):** `api.patients.summary` (it
  synthesizes health scores / radars / series with no DB source), and all of
  `practice`, `assistant`, `commands`, `composer`, `imports`. These stay mock
  until their data exists and parity is proven.

## Verification (real command output)

| Layer | How verified | Result |
| --- | --- | --- |
| Default mock build | `tsc` + `eslint` + `next build` with flag off | green, 24 routes |
| Backend serves `clinical.*` + enforces auth | live HTTP to the running backend | `clinical.patients.list` / `whoami` unauth → **UNAUTHORIZED 401**; forged token → **UNAUTHORIZED**; legacy `nutrition` still protected |
| Backend authz helpers (allow/deny × 5) | `vitest` unit tests | **198/198** (19 new) |
| RLS gates (assignment, role-write, soft-delete, cross-patient) | live SQL vs the real project (MCP), rolled back | **37/37** assertions |
| Desktop adapter (fetch, superjson-unwrap, row→entry mapping, flag branch, NOT_FOUND→undefined) | ran the real `patientsLive` over HTTP against a fixture returning the backend's RLS-filtered wire shape | list → 2 mapped entries; `get(assigned)` → row; `get(unassigned)` → `undefined` |

## The one hop not exercised here, and why

The final wire — **real backend → real clinical Supabase host over HTTP** —
could not be exercised from this sandbox. The environment's egress proxy
rejects direct requests to `*.supabase.co` (`request rejected: host not
permitted`); the project is reachable only through the MCP channel (which is
why the schema was applied via MCP and the CLI `db push` path is blocked too).
That hop is standard Supabase client traffic and works in any normal deployment
where the backend can reach the project. Everything on both sides of it is
verified above.

## To run it live in a real environment

1. Backend (`rork-ai-longevity-coach/expo`): set `CLINICAL_SUPABASE_URL`,
   `CLINICAL_SUPABASE_ANON_KEY`, `CLINICAL_SUPABASE_SERVICE_ROLE_KEY`,
   `CORS_ALLOWED_ORIGINS`; `bun run backend/server.ts`.
2. Desktop: `NEXT_PUBLIC_USE_LIVE_API=1`, `TRPC_BASE_URL`, `CLINICAL_ORG_ID`,
   and (until real login) `CLINICAL_DEMO_EMAIL` / `CLINICAL_DEMO_PASSWORD`.
3. Prove parity for `patients`, then delete `patients.mock` usage for
   list/get; repeat per namespace.
