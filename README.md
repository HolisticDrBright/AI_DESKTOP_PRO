# AI Longevity Pro — Clinical Intelligence (Desktop)

Desktop-first practitioner web application for a premium longevity /
functional-medicine practice. It combines patient health intelligence (labs,
biomarkers, sleep and wearables, supplements, N-of-1 experiments) with
practice operations (review queue, tasks, appointments, team workload) and a
differentiated AI layer (clinical reasoning snapshot, evidence for/against,
contextual assistant, command palette).

This repository contains the **desktop front end** plus the **clinical
database schema** (`supabase/`). The UI renders from clearly isolated, typed
mock adapters (`src/adapters/*`); the authenticated tRPC backend lives in the
platform repo and one namespace (`patients`) is already flag-swappable to it
(see [`docs/live-api.md`](docs/live-api.md)). Everything else still reads from
mock adapters, and all mutable UI state (review outcomes, audit events) is
**demo/session-only** — see [Demo persistence boundaries](#demo-persistence-boundaries).

![Patient Overview](docs/screenshots/patient-overview.png)

## Stack

- [Next.js 15](https://nextjs.org) (App Router) + React 19 + TypeScript
- Tailwind CSS v4 (design tokens declared in `src/app/globals.css`)
- [lucide-react](https://lucide.dev) icons
- Inter (variable) via `next/font`

## Getting started

```bash
npm install
npm run dev        # http://localhost:3000  (demo mode — no env needed)
```

Other scripts: `npm run build` · `npm run start` · `npm run lint` ·
`npm run typecheck`.

**End-to-end tests (Playwright, mock app):**

```bash
npx playwright install chromium   # once, downloads the test browser
npm run build                     # the suite runs the production server
npm run test:e2e                  # 13 tests: shell, review loop, labs, imports…
npm run test:e2e:headed           # same, with a visible browser
```

The suite lives in [`e2e/mock-app.spec.ts`](e2e/mock-app.spec.ts) and needs no
backend or env vars. In sandboxed CI images with a pre-installed browser, point
`PW_CHROMIUM_PATH` at the Chromium binary instead of running `playwright install`.

**Demo vs live.** With no env, the app runs entirely on mock/session adapters —
nothing is persisted. Setting `NEXT_PUBLIC_USE_LIVE_API=true` (plus the backend
env in [`.env.example`](.env.example)) routes the wired vertical slice —
real patient read, labs workspace, marker review + persistent audit, and a
downstream review task — through the authenticated backend under RLS. See
[`docs/live-api.md`](docs/live-api.md) for the architecture, the secure write
path (migration `0013`), what's wired vs still mock, security assumptions, and
how to wire future domains. Settings → **Data source & environment** shows the
resolved mode and configured backend vars (presence only).
[`docs/live-data-readiness.md`](docs/live-data-readiness.md) maps every domain
(adapter → mock source → session state → live tables → first mutation) and the
recommended wiring order — **Tasks/Review queue is the next live slice**.

The app targets a 1440×900 desktop viewport (1280 px minimum supported
width).

## What's in Phase 1

| Area | Status |
| --- | --- |
| App shell — grouped sidebar (Workspace / Clinical / Operations / System), 58 px top bar with working notifications / messages / account popovers, glass/solid material, atmospheric background | ✅ Live |
| Patient Overview (`/patients/:id/summary`) — header card with working actions, tabs, health score ring, system-balance radar, priorities, risk flags, biomarker trends, sleep & recovery, N-of-1 experiments, right rail | ✅ Live |
| **Review-to-action** — reusable `ActionBar` on cards / hypotheses / queue rows / lab markers; destructive & patient-facing actions confirm; outcomes announced and audited | ✅ Live |
| **Provenance & confidence** — reusable `Provenance` / `ProvenanceBadge` (source type, range, completeness, conflicts, review state) across summary, reasoning, assistant, tasks, labs | ✅ Live |
| **Clinical Reasoning Snapshot** — per-hypothesis provenance + actions, missing info, what-changed, safety considerations; **approve/reject updates the visible status in-session** and disables settled actions | ✅ Live (demo state) |
| **Note / report composer** — 8 draft types behind a mock adapter; drafts show sources / range / missing info / review state; never final until approved; patient-facing drafts confirm | ✅ Live (demo) |
| **Tasks & Review Queue** (`/tasks`) — 12 review categories, provenance per row, resolve / convert-to-note / request-data / open-patient / assign / snooze / change-priority, search + category + priority + status + my/all filters, empty state | ✅ Live (demo state) |
| **Imports & migration wizard** (`/imports`) — source → detect → map → resolve conflicts → preview → commit → audit; preserves `source_record_id`; links into the review queue | ✅ Live (demo) |
| **AI / decision-support safety registry** (`/ai-safety`) — per-feature classification with a no-regulatory-claims scope banner | ✅ Live |
| **Audit Log** (`/audit-log`) — demo session audit viewer, **survives reloads via `sessionStorage`**, clears with the session | ✅ Live (session) |
| System-of-record navigation + operational spec screens (Nutrition, Templates, Automations, Billing, Claims, Reports, Team) — honest workflow / permissions / next-action specs | ✅ Live |
| Practice Dashboard (`/practice`), Command palette (⌘K), Clinical Assistant drawer | ✅ Live |
| Appearance & accessibility — solid/glass material, atmospheric background, **display scale (compact / default / large)** | ✅ Live |
| Remaining sections (Health Twin, Timeline, Clinical Reasoning workspace, Supplements, N-of-1 Lab, Protocols, Reports tab, Wearables, Assessments, Quantum Mind, Messages, Integrations, Calendar, Program Builder) | 🔜 Placeholders — build from [`docs/design-handoff/product-spec.txt`](docs/design-handoff/product-spec.txt) |
| **Labs Workspace** (`/patients/:id/labs`) — marker table (lab + optimal ranges, confidence, review), trend panel, source inspector, extraction review, upload demo, optimal-range config | ✅ Live (demo) |

Six synthetic patients ship with the mock adapters; Alexandra Morgan
(`p-78435`) carries the exact flagship dataset from the handoff, and the
other records are derived from the practice-dashboard data so cross-links
stay coherent. **All health data is synthetic.**

## Demo persistence boundaries

This build has **no backend persistence** for interactions. Two kinds of
mutable state exist, both demo-only and isolated behind the adapter facade so
they can become tRPC mutations later:

- **Review outcomes** (approve / reject / accept hypothesis / resolve queue
  item / mark lab reviewed) and the **audit log** are stored in the browser's
  `sessionStorage` via `src/adapters/session-store.ts`. They survive page
  reloads **within a browser session** and are **cleared when the session
  ends** — this is a demo, not a database. The Audit Log screen says so, and
  action toasts read "demo — not persisted".
- **Everything read** (patients, labs, queue, reasoning, imports, composer
  drafts) comes from typed mock adapters in `src/adapters/*`. The `patients`
  namespace can be flag-swapped to the real backend
  (`NEXT_PUBLIC_USE_LIVE_API`, see [`docs/live-api.md`](docs/live-api.md)); the
  rest await their tRPC routers.

Backend persistence — writing review actions, audit events, and lab reviews to
the clinical Supabase project — still requires the tRPC mutations + `audit_events`
table wiring described in [`docs/live-api.md`](docs/live-api.md). No UI copy
implies real persistence.

## Architecture

```
src/
  adapters/        Typed mock data layer — THE swap point for tRPC later
    types.ts         Domain interfaces shared with the UI
    *.mock.ts        Synthetic datasets (patients, practice, assistant, commands)
    index.ts         `api` façade shaped like the future tRPC client
  app/             App Router routes (patient tabs, practice, placeholders)
  components/
    shell/           Sidebar, TopBar, CommandPalette, AssistantDrawer, AppShell
    patient/         Patient header, tabs, right rail, summary cards
    practice/        Practice dashboard cards
    ui/              Card, charts (ring / radar / sparkline), segmented control…
  lib/             Routes, providers (material + shell UI state), tone maps
```

See [`docs/architecture.md`](docs/architecture.md) for the route map, data
flow, and the tRPC swap plan.

### Design system notes

- Tokens (colors, borders, ink scale) are declared as Tailwind v4 `@theme`
  variables in `src/app/globals.css`; data-driven colors go through the
  semantic tone maps in `src/lib/tones.ts`.
- Color semantics are binding: blue = action / practitioner-confirmed,
  teal = patient-reported, violet = AI / inference, green = positive,
  amber = warning, coral = critical, navy = measured.
- Surfaces support `solid | glass` material (glass adds
  `backdrop-filter: blur(22px) saturate(1.5)` to the sidebar, top bar and
  patient header). Glass is the shipped default per the handoff; toggle it
  under **Settings → Appearance**.
- Tabular numerals everywhere numbers appear; Inter variable 400–700
  (true 650 for active tabs).
- Reduced motion is respected globally; focus rings are visible on all
  interactive elements (violet for assistant controls).

### AI guardrails (already enforced in the UI)

- Hypothesis strength chips are labelled *“Strength reflects internal
  evidence weighting — not a medical probability.”*
- Every assistant statement carries a provenance badge, plus sources used,
  date range, missing information, and a *“Not reviewed — assistant output
  requires practitioner review”* notice.
- Experiment conclusions use the cautious vocabulary only
  (*Likely beneficial · Possibly beneficial · No measurable effect ·
  Possibly harmful · Inconclusive*).

## Screenshots

| | |
| --- | --- |
| ![Practice dashboard](docs/screenshots/practice-dashboard.png) | ![Command palette](docs/screenshots/command-palette.png) |

## Roadmap

The platform-level plan lives in [`docs/platform/`](docs/platform/):
the original backend prompt (`backend-prompt.md`, targeting the
`rork-ai-longevity-coach` repo that hosts the Expo app and shared backend)
plus the enhancement addendum (`backend-addendum.md`) that adds billing &
claims, telehealth and automations, an outcomes/population layer, migration
importers, and a versioned connector framework.

Shipped since the handoff (see the status table): review-to-action,
provenance, the Clinical Reasoning Snapshot upgrade, system-of-record
navigation, the composer, the imports wizard, the AI/CDS safety registry, the
session audit log, appearance/display-scale settings, the Tasks & Review
Queue, and the Labs Workspace.

For this desktop repo, in order:

1. **Remaining Phase 2+ screens** from `product-spec.txt` — Health Twin
   system map, three-pane Clinical Reasoning workspace, Supplement
   Intelligence, N-of-1 Lab, unified Timeline, Program / Assessment builders.
2. **Backend integration** — replace `src/adapters/*` with tRPC queries
   against the shared Hono/Supabase backend; the desktop app must share
   domain schemas with the Expo patient app rather than duplicating them.
   Blocked on the backend's Phase 1 (tenant isolation, patient access,
   audit) landing in the platform repo first.
3. **Ops surfaces from the addendum** (after the corresponding backend
   routers exist): Billing (invoices, payments, packages), insurance claims
   status, Automations rules + run history, connector-health Integrations
   screen, staged migration-import review, telehealth join links on
   appointments, and population/outcomes analytics views. These need design
   passes first — the approved v2 shell does not yet include them, so they
   must not be improvised into the sidebar.
4. **Trust surfaces** — the addendum's AI data-use guarantee ("processed
   in-region, never used to train external models") gets a visible home in
   the assistant UI and Settings once the config exists server-side.
