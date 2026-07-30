# App editions — demo and clinical

This codebase ships two products. `APP_EDITION` decides which one a build is,
and it is the **only** thing that decides.

| | `APP_EDITION=demo` (default) | `APP_EDITION=clinical` |
| --- | --- | --- |
| Data | synthetic fixtures + `sessionStorage` | live records via the Desktop-owned Supabase boundary |
| Auth | none — no login, no credentials | required: real sign-in + active organization membership |
| Network | own origin only (CSP-enforced) | its configured clinical backend |
| Persistence | nothing survives the browser session | real rows under RLS |
| Missing config | irrelevant — there is nothing to configure | **fails closed** |
| Fixture data | the whole point | never rendered |

## The authority: `src/lib/edition.ts`

One typed module resolves the edition; no component, adapter, route, or test
reads an edition environment variable on its own. Scattered `process.env` reads
are how a "demo" build ends up with one live code path, or a clinical build
quietly renders a synthetic patient.

- `src/lib/edition.build.ts` — pure resolution rules, no environment access.
  Imported by `next.config.ts`, by the runtime module, and by the tests, so the
  build and the app cannot disagree about which edition this is.
- `src/lib/edition.ts` — the runtime authority. Exports `APP_EDITION`,
  `IS_DEMO`, `IS_CLINICAL`, `DEMO_BANNER_TEXT`, `describeEdition()`, and the
  `assertDemoEdition` / `assertClinicalEdition` guards.
- `src/lib/edition.server.ts` — server-only configuration gate:
  `inspectEditionConfig()`, `isClinicalBoundaryConfigured()`,
  `assertEditionConfig()`.

Operators set plain `APP_EDITION`. Next.js only inlines `NEXT_PUBLIC_*` into the
browser bundle, so `next.config.ts` validates the value and republishes it as
`NEXT_PUBLIC_APP_EDITION`. That is what the runtime module reads.

### Fail closed, always

An unrecognized edition is never coerced to a default — it throws at build time.
A build whose data boundary nobody chose must not ship.

```
APP_EDITION=prod    npm run build   # fails: not a valid edition
APP_EDITION=bogus   npm run build   # fails: expected demo, clinical
```

### `EDITION_LOCK` — single-edition distributions

A distribution can refuse to become the other product:

```
EDITION_LOCK=demo APP_EDITION=clinical npm run build
# fails: This distribution is locked to the "demo" edition and cannot run as
#        "clinical". Build from the clinical edition repository instead.
```

The demo repository sets `EDITION_LOCK=demo`, so `APP_EDITION=clinical` there is
a hard build failure rather than a demo binary aimed at real infrastructure.

## Building

```bash
npm run build:demo       # APP_EDITION=demo     — needs no credentials at all
npm run build:clinical   # APP_EDITION=clinical
npm run check:clinical-bundle   # inspect the clinical bundle (see below)
```

## Demo edition

- **Synthetic only.** Every screen reads `src/adapters/*.mock.ts` plus
  per-session state under the `aidp:demo:` `sessionStorage` prefix.
- **No egress.** A demo build serves `connect-src 'self'` for every route
  (`next.config.ts`), so the browser itself refuses any request to Supabase,
  Railway, Stripe, OpenAI, email, SMS, storage, or a lab vendor. This is the
  browser enforcing it, not a promise about code.
- **Standing disclosure.** `DemoEditionBanner` is rendered by `AppShell`, so
  "Interactive demo — synthetic data only" appears on every primary screen by
  construction rather than by remembering to annotate each route.
- **Reset Demo.** The banner carries the reset. `resetDemoState()` sweeps every
  `aidp:demo:` key, drops in-memory caches, and notifies subscribers, so open
  screens re-render from the shipped fixtures. Deliberately blunt — the failure
  mode to avoid is a *partial* reset leaving one domain carrying stale edits.
- **No credentials.** The demo requires no login. `getDevContext()` returns `{}`
  in the demo edition, so dev identity overrides cannot conjure a live path.
- **Clinical env cannot activate live behaviour.** `NEXT_PUBLIC_USE_LIVE_API`,
  `NEXT_PUBLIC_DEV_*`, and backend URLs are all inert in a demo build. Proven by
  `src/adapters/clinical-fixture-barrier.test.ts`.

Verified by `e2e/demo-edition.spec.ts` (banner on all 11 primary routes, zero
off-origin requests across every route and during interaction, reset restores
fixtures across reload, all seven guided entry points, no password field).

## Clinical edition

- **Authenticated and organization-scoped.** Sign-in at `/login`; RLS and
  role-gated RPCs remain authoritative. See [`live-api.md`](live-api.md).
- **Fails closed.** `assertEditionConfig()` throws when
  `CLINICAL_SUPABASE_URL` / `CLINICAL_SUPABASE_ANON_KEY` are absent. A
  half-configured clinical deployment must not serve pages.
- **No demo credentials.** The same gate rejects a *demo* build that was handed
  clinical credentials — their presence means someone believes that deployment
  talks to real infrastructure.
- **The fixture barrier.** `src/adapters/index.ts` wraps every namespace with no
  live source in `demoOnly()` / `demoOnlyNamespace()`. In the clinical edition
  these throw `unavailable`, so the UI renders an honest not-yet-available state
  through `ClinicalStates`. It is a **barrier, not a fallback**: there is no code
  path from the clinical edition into a mock module. `demoOnlyNamespace` guards a
  whole namespace so a method added later is barred by default.

Currently barred in the clinical edition: `patients.summary`,
`assistant.session`, `composer.generate`, `imports.plan`,
`calendar.getSchedule`, `reasoning.getWorkspace`, `supplements.getWorkspace`,
`healthTwin.getMap`, `experiments.*`, `labOrders.*`, `inventory.*`. A namespace
leaves this list by gaining a real Desktop-owned implementation — see
[`live-data-readiness.md`](live-data-readiness.md).

- **Worker-bound operations stay on their provider boundary.** `lens.evaluate`
  and `lens.aiStatus` (rules/AI engine), scribe capture/transcription, and lab
  PDF ingestion remain transitional by design; a configured provider failure is
  surfaced explicitly and never reported as success.

Verified by `src/adapters/clinical-fixture-barrier.test.ts` (every barred
namespace refuses; no fixture id or name escapes through the error path) and
`e2e/clinical-edition.spec.ts`, which runs a clinical build against a **down**
backend and asserts honest states with no synthetic patients, no fabricated
health score, and no demo calendar template.

### Bundle presence — enforced vs. known gap

`npm run check:clinical-bundle` distinguishes two properties that are easy to
conflate:

- **Reachability (enforced).** Fixtures cannot *render* in the clinical edition.
  The barrier refuses every fixture namespace; the unit suite proves it.
- **Presence (known gap).** Fixture datasets and demo copy are still code-split
  into the clinical client bundle as **unreachable dead code**, because ~57 sites
  import `*.mock` modules statically (14 in the adapter facade, the rest in
  components). Converting those to edition-gated lazy imports closes it.

The check is advisory by default and reports the gap; `--strict` fails on it, for
tracking the refactor to done. That refactor is deliberately **not** bundled into
the edition split so the split stays reviewable.

## Deprecated: `NEXT_PUBLIC_USE_LIVE_API`

This flag used to be the top-level switch. **It is no longer consulted for the
edition decision.** A demo build cannot be turned live by setting it — that is
the entire point of the split.

It survives only as a derived alias in `src/adapters/mode.ts`:

```ts
/** @deprecated Derived from APP_EDITION. Use IS_CLINICAL from @/lib/edition. */
export const USE_LIVE_API: boolean = IS_CLINICAL;
```

**Why it still exists:** roughly 40 call sites and the existing live e2e suites
import it. Keeping it as a derived alias let the edition authority land without a
40-file mechanical rewrite in the same change.

**Migration:** replace `USE_LIVE_API` with `IS_CLINICAL` from `@/lib/edition`.

**Removal criteria:** the alias goes away once no source file under `src/`
imports it. Until then, setting the environment variable has no effect —
`src/adapters/clinical-fixture-barrier.test.ts` asserts that
`NEXT_PUBLIC_USE_LIVE_API=true` in a demo build leaves `USE_LIVE_API === false`
and `getApiMode() === "mock"`.

## Migrations

The edition split required **no** schema change. Migration history is unchanged
and still ends at `20260730002121` (`worker_callback_ledger_privileges`); nothing
was reapplied.
