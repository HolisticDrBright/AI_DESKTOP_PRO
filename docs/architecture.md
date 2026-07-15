# Architecture — Phase 1 front end

## Shell composition

```
RootLayout (server)
└─ MaterialProvider (client)        solid|glass + atmosphere, persisted to localStorage
   └─ ShellUiProvider (client)      cmdOpen/aiOpen + global ⌘K / Esc key handling
      └─ AppShell (client)          sets data-material / data-atmosphere
         ├─ Sidebar                 active item derived from usePathname()
         ├─ TopBar                  search → palette, Assistant → drawer
         ├─ <main>                  the scroll container (atmosphere layer inside)
         │   └─ {children}          route content
         ├─ CommandPalette          fixed overlay, z-100
         └─ AssistantDrawer         fixed overlay, z-90
```

Glass material is implemented with CSS only: `[data-material="glass"]
.glassable { backdrop-filter … }`, so components never branch on it.

## Route map

| Route | Renders |
| --- | --- |
| `/` | redirect → `/patients/p-78435/summary` (default demo patient) |
| `/patients/[patientId]` | redirect → `…/summary` |
| `/patients/[patientId]/summary` | flagship Patient Overview |
| `/patients/[patientId]/[tab]` | `twin · timeline · labs · reasoning · supplements · nof1-lab · protocols · reports` → in-patient “next design phase” card (patient header, tabs and right rail stay live) |
| `/practice` | Practice Dashboard |
| `/tasks` `/messages` `/wearables` `/assessments` `/quantum-mind` `/integrations` `/calendar` `/programs` `/settings` | designed full-screen placeholders (Settings also hosts the live Appearance card) |

`patients/[patientId]/layout.tsx` owns the patient header card, tab bar and
right rail, so tab switches only swap the left-column content — matching the
prototype’s SPA behavior.

## Data flow

Server components fetch through the async `api` façade
(`src/adapters/index.ts`), which is shaped like the future tRPC client:

```ts
const patient = await api.patients.get(patientId);
const summary = await api.patients.summary(patientId);
const dash    = await api.practice.dashboard();
```

Two client components (`CommandPalette`, `AssistantDrawer`) import their
mock functions synchronously today; with a real backend those call sites
become tRPC hooks (`api.commands.groups.useQuery(...)`).

Rules the data layer already follows:

- **Semantic tones, not hex** — adapters express color as
  `Tone = action | teal | positive | warning | critical | ai | slate | navy`;
  components map tones to the exact handoff colors via `src/lib/tones.ts`.
- **Backend-friendly shapes** — IDs, display strings and enums only; no JSX,
  no class names, no component references in adapter data.
- **Synthetic data only** — six demo patients; Alexandra Morgan (`p-78435`)
  is the exact handoff dataset, the others are derived from the
  practice-dashboard mock so queue/risk/adherence links resolve to real
  routes.

### Swapping to tRPC later

1. Stand up the shared backend (Hono + tRPC + Supabase per
   [`docs/platform/backend-prompt.md`](platform/backend-prompt.md) and its
   [enhancement addendum](platform/backend-addendum.md)) and expose routers
   matching the `api` namespaces (`patients`, `practice`, `assistant`,
   `commands`). The addendum also specifies `billing`, `claims`,
   `automations`, `telehealth`, `population`, `outcomes` and `imports`
   routers — each will arrive here as a new adapter namespace plus screens
   once designed.
2. Replace the function bodies in `src/adapters/index.ts` with tRPC calls;
   the interfaces in `src/adapters/types.ts` become the shared output
   schemas (Zod on the server).
3. Move `CommandPalette` / `AssistantDrawer` to query hooks; add TanStack
   Query at that point (deliberately not installed while data is static).
4. Delete the `*.mock.ts` files.

## Charts

All charts are hand-rolled SVG to match the prototype geometry exactly
(no chart library in Phase 1):

- `ScoreRing` — r=52, stroke 10, dasharray = value % of 2π·52.
- `RadarChart` — 8 axes, center (126, 95), R=62, rings at 0.33/0.66/1.
- `Sparkline` — identical point math to the prototype’s `spark()`
  (2 px x-inset, 3 px bottom margin).

## Accessibility

- Tabs and segmented controls use `role="tablist"` / `aria-selected`;
  the palette exposes `role="listbox"` + `aria-activedescendant`.
- Icon-only buttons and both overlays carry `aria-label`s; charts are
  `role="img"` with descriptive labels.
- Status is never conveyed by color alone (always paired text such as
  “High” / “Low” / “Monitor”).
- Visible `:focus-visible` rings everywhere (violet for assistant
  controls); `prefers-reduced-motion` disables all animation.

## Verification

`npm run build` (includes type checking + lint) is green; the screens in
`docs/screenshots/` were captured from the production build at 1440×900
(the design’s primary viewport) and cross-checked against the handoff
values. Layout holds at the 1280 px minimum supported width.
