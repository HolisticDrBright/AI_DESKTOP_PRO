# Desktop browser acceptance runner, 2026-10-13

_Work package 3 of "Next Claude Code handoff — lab safety, provenance, and browser acceptance", continued under the
October 13 late addendum (instrument the long-run stall, reproduce it with retained logs and memory samples, repair it
without skipping specs, splitting them into fresh processes or extending timeouts; fix the LensPanel honest-state bug
separately). Branch `claude/browser-acceptance-runner-20261013`. Source and local test work only: nothing deployed, no
AWS call, no provider, no PHI. Codex's own runner work (`34330b2c`, `docs/e2e-order-runner-qualification-2026-10-13.md`)
its Lens readback confirmation (`8a998736`) and its later runner work (`f97bb2d8`: real file reversal, a fresh server
per order, the bounded child) are merged in and kept. Nothing in this file is hosted, device or PHI qualification._

## Four defects, in order

**1. The production runtime refused the fixture (correctly).** The documented battery drove `next start`, which forces
`NODE_ENV=production`, a deployment signal; the contract-fixture boundary refused the loopback fixture and 45 live
specs failed in both orders at `ea91196c` (20 passed, 45 failed, 91 skipped — most of the "skipped" were tests a failed
`beforeAll` never ran). Codex and this branch both moved the battery to `next dev` with the fixture; the refusal in
`src/server/runtime/contractFixture.ts` is unchanged.

**2. The runner froze its own development server.** On `next dev`, Codex's full run still went red under accumulated
load: `/login` timed out at 120 s, and a lens readback stayed "Loading evaluation…". The runner owned the server's
stdout and stderr pipes but ran Playwright with `execFileSync`, which blocks its event loop for an entire order, so
nothing drained them; Next puts its stdio into **blocking** mode when it loads its SWC bindings
(`node_modules/next/dist/build/swc/index.js`: `process.stdout._handle.setBlocking(true)`) and `next dev` logs every
request, so once the pipe buffer filled the server stopped mid-write and answered nothing. Reproduced outside the
battery (`next dev` from this tree, `/api/health` requested sequentially by a child process, 10 s per request):

| Driver | Result | Server worker wait channel |
| --- | --- | --- |
| synchronous child (`execFileSync`, as the runner did) | stopped answering at request **172**, 31 s in | `sock_alloc_send_pskb` (blocked in the kernel socket send) |
| asynchronous child (the repair) | **4,000 of 4,000** answered in 435,572 ms; 116,913 bytes drained before the child started | `ep_poll` (idle, waiting for work) |

A fast mechanism test reproduces the same thing without Next (`scripts/e2e-order-config.test.mjs`: a server with
blocking stdout that logs each request stalls under a synchronous child and answers all 400 requests under an
asynchronous one), and the driver is held to an asynchronous Playwright child.

**3. The development server ran itself out of memory, two ways.** With defect 2 repaired, the full battery at
`7bc68274` ran two complete passes on one server (both in the same order — see defect 4). First pass: 305 passed, 2
failed, 10 did not run; second pass: 314 passed, 1 failed, 2 did not run (99 declared skips in each, never counted).
Every failing test passed in the other pass, and each one was running across a server event, not an assertion about
the product:

| Pass | Test | What the server was doing |
| --- | --- | --- |
| first | `live-scribe.spec.ts:331` network interruption (then 4 serial followers did not run) | a ~20 s silence (00:51:34.7 → 00:51:55.2): one chunk upload took 18.9 s, the 30 s memory sample fired a minute late; the app correctly paused capture ("Capture authorization is unavailable") instead of recovering |
| first | `live-sync-worker.spec.ts:495` (14) timed out in `page.goto` (then 6 followers did not run) | Next restarted its worker at 00:55:13 while that navigation was in flight |
| second | `live-overview-reasoning.spec.ts:110` timed out (then 2 followers did not run) | started 01:20:44.8; the worker restarted at 01:20:55.5 |

The worker heap grew 1.5 → 7.6 GiB in 26 minutes; when the used heap passed 80 % of the limit Next exited the worker
itself (`node_modules/next/dist/server/lib/start-server.js:234`, "Server is approaching the used memory threshold,
restarting...") — once per pass — dropping whatever was in flight. A larger heap only moves that point. Two separate
causes, measured without a browser over the battery's own 86 GET routes (same fixture, same 9,216 MiB heap; "retained"
is the heap just after a major collection, which separates live memory from garbage):

- **3a — recompile churn.** `next dev` disposes a route idle for 60 s beyond the 5 most recent (`onDemandEntries`
  defaults) and recompiles it on the next visit; the battery moves across hundreds of routes, so the server recompiled
  about ten times a minute throughout.
- **3b — React's development async-debug hook.** The development build of React's server renderer that Next 15.5
  bundles (`19.2.0-canary-0bdb9206-20250818`, in `next/dist/compiled/next-server/app-page.runtime.dev.js`) enables,
  unconditionally when it loads, an `async_hooks` hook that records a node for every promise created while a render is
  pending — owner, a captured stack trace, timings and the promises it awaited — for DevTools' async debug information.
  Nodes leave its map only when a promise is collected. Sampled live allocations that grew under steady traffic were
  this hook's `init` / `collectStackTrace*` / `promiseResolve` and related renderer code, plus Next's per-request
  development manifest evaluation; none were in application code under `src/`. No Next or React setting turns it off in
  this version.

| Run (12 min each unless noted) | Compiles | Retained heap | Longest event-loop stall | Worker restarts |
| --- | --- | --- | --- | --- |
| A — Next defaults, laps padded past the 60 s window | 292 | 0.6 → **5.8 GiB** in 10 min | 3.9 s | **1** (81 requests failed during it) |
| B — routes kept compiled, same laps | 63 (first lap only) | about 1.9 → 2.7 GiB | 1.8 s | 0 |
| C2 — routes kept compiled, continuous traffic | 63 | 1.98 → **3.13 GiB**, still rising | **7.5 s** | 0 |
| D2 — as C2, React's async-debug hook off | 63 | **flat at about 1.83 GiB** for 8 min | about 0.2 s once warm | 0 |
| F — as D2, every entry compiled first (10 min) | 16, all up front | **flat at 1.88–2.16 GiB** | about 0.2 s | 0 |

Each repair was then tried alone against the full browser battery, which is the only test that counts, and each alone
was not enough:

- **Routes kept compiled, nothing else** (`0fe57ac9`): retained heap still grew 0.9 → 5.7 GiB in 21 minutes of the
  first pass (125 compiles, no failure yet), on course for the restart; stopped there.
- **Kept compiled, hook off, no precompile** (`5e518ccb`): growth slowed, but each first compile now carried every kept
  entry (3,100+ modules, 3–15 s each), and `live-lens.spec.ts:199` failed when its note autosave was the first request
  to `/api/live/emr/note` — an 8.8 s compile against the test's save window. Stopped after that failure.
- **Hook off, Next's default disposal** (`d22b7692`): about ten recompiles a minute still left memory behind
  (0.9 → 4.1 GiB in 18 minutes of the first pass, 224 compiles, no failure yet), on course for the restart; stopped
  there.

Observation, not an application failure: during the 20 s silence the server logged `uncaughtException: [Error:
aborted] { code: 'ECONNRESET' }` beside `/api/live/scribe/chunk`. The route had already refused the partial body ("No
partial audio was forwarded"); the duplicate stream error is Next's own, and Next installs handlers that log it and keep
the process alive in development and production (`next-server.js:216`, `router-server.js:566`).

**4. The "reverse order" was not reversed (found by Codex, `a24ecc28`).** Playwright treats file arguments as filters
and sorts what it collects, so passing the spec list reversed ran it forward again. Every two-order run in this file
before the merge with Codex's runner — including the first green one below — therefore ran **the same order twice**:
both orders began with `aws-recording-capture.spec.ts` and ended with `zoom-sdk-bootstrap.spec.ts` (from the runs'
own timelines). Those runs show the server holding up across two full passes; they do not show order independence.
Codex's numbered alias files force the collection order, and each order is checked with `--list` before a browser
starts.

## The repair

- **Playwright runs as an asynchronous child**, so the server's pipes are drained throughout (defect 2).
- **The whole app is compiled once, before any spec, and kept compiled.** The runner lists every `page` and `route`
  file under `src/app` (`appEntryUrls` in `scripts/e2e-order-config.mjs`: groups, slots and private folders removed,
  dynamic segments filled with a placeholder) and requests them 24 at a time (`precompileApp`), so `next dev` batches
  them — 293 entries in about 165 s and 13–16 compilations. The harness's server keeps them compiled (`next.config.ts`:
  `onDemandEntries` with a 24 h inactivity window and a 10,000-route buffer, only when `E2E_DEV_SERVER=1`; `next build`
  and `next start` never read it). After that no test waits on a compile (3a). It is a bounded warm-up step — past its
  cap the battery stops loudly — and no test timeout changes. Tests: the setting is held to that flag (failing before: 1
  of 21); the entry list and that the precompile runs before the warm-up and before any spec (failing before: the
  helper did not exist).
- **React's development async-debug hook is left off in that server only** (`scripts/e2e-dev-react-async-debug-off.mjs`,
  loaded by the harness's preload when `E2E_DEV_SERVER=1`, `NODE_ENV=development` and in Next's worker). It disables
  exactly one hook: one created from Next's bundled development renderer with React's callback shape. Every other
  `async_hooks` user is untouched, routes, responses and data are unchanged, and one line in the server log records
  that it acted. What is lost is DevTools' async debug information in this test server (3b). Tests: it disables only the
  renderer's hook and says so once, an identically shaped hook from another module keeps working, and it does nothing in
  production or outside the harness (failing before: 1 of 23).
- **One preload.** The probe and the switch load through `scripts/e2e-dev-preload.mjs`: `next dev` re-parses
  `NODE_OPTIONS` for its worker into one value per option (`getParsedNodeOptionsWithoutInspect`), so a second `--import`
  silently replaced the first — observed when the probe went quiet. The budget's test asserts exactly one `--import`.
- **Nothing is lightened.** Every spec runs in one Playwright process per order (the ten that need a posture of their
  own skip by their own declaration and are reported, never counted); no timeout, retry, assertion or spec changes.
  Each order runs on its own development server with the fixture backend reset between them (Codex's `f97bb2d8`), so
  both start from the same state; each server compiles the whole app before its first spec. No spec is split into a
  process of its own.
- **Real reversal** (Codex's `e2e-ordered-specs.mjs`): numbered aliases force each order, `--list` confirms it before
  any browser runs, stale aliases from an interrupted run are refused, and ordinary browser runs ignore them.
- **Codex's guards are kept**: the bounded asynchronous child (64 MiB cap; a non-zero exit fails the order whatever
  its report says), the TCP port check and the listener check after each server stops, the Windows process-tree kill,
  pinned fictional targets and credentials (an explicit non-fictional value is refused —
  the session environment here carried a non-fictional 46-character anon key, which the first unpinned local run
  handed to the loopback stub only), a loopback-only stub origin, the clinical production bundle built with the
  fixture disabled (now with the same explicit heap as the server: with `NODE_OPTIONS` unset the build worker ran out of
  memory at about 2 GiB), the bounded development heap with its 4 GiB reserve, CI reuse only for the runner's own
  server, and the whole server process group stopped at the end (stopping only the `next` CLI orphaned its worker).
- **Posture observed, not assumed.** A signed-out `/today` renders only when the fixture is allowed; otherwise the runner
  stops with one line before any spec.
- **Accounting by test identity** from Playwright's JSON report: only an expected pass counts; a declared skip is listed
  with its reason; a test a failed hook never ran is "did not run" and fails; both orders must pass the same tests.
- **A worker restart fails the battery** even when every test passed: Next's own "approaching the used memory threshold"
  line is counted from the server log (`workerRestarts`), because a restart dropped whatever was in flight.
- **Instrumentation, kept outside `test-results/`** (which Playwright empties per run) in `e2e-order-evidence/<run>/`:
  the server's whole stamped log with its 30 s probe samples — heap, RSS, and now the window's longest event-loop delay,
  major-collection pauses and the heap after a major collection (no collection is forced) — a 15 s latency canary for
  `/login`, `/api/health` and the lens readback, each order's JSON report and test timeline, `precompile.json`, and
  `summary.json` (now with the precompile, the longest event-loop delay, the peak heap after a major collection and the
  worker restarts); the runner's own log streams Playwright's progress as it happens. Titles, timings, status codes and memory figures
  only.

## LensPanel honest state (separate fix)

The panel set "Evaluation complete" from the POST reply before the readback was requested, so a slow, failed or empty
readback still showed completion. This branch sequenced the loads (only the newest applies its result and ends the
loading state) and set the notice only after the run's own readback (`b0bf7feb`; `e2e/live-lens.spec.ts` holds, then
refuses, the browser's own readback — **failing before 1 of 6, 6 of 6 after**). Codex repaired the same defect in
parallel (`8a998736`: the POST must return a verifiable id and status, the readback must show that exact evaluation,
bounded at 30 s, an unconfirmed result is cleared). The merge (`7bc68274`) keeps both: Codex's confirmation rules and
this branch's sequencing. `live-lens.spec.ts`: **8 of 8**, Codex's two cases included.

## Result

**Locally verified at `575e0908`** (this branch merged with Codex's `f97bb2d8`), one command, nothing else running:

| | Forward (`aws-recording-capture` → `zoom-sdk-bootstrap`) | Reverse (`zoom-sdk-bootstrap` → `aws-recording-capture`) |
| --- | --- | --- |
| Collection order proven with `--list` before any browser | yes, 39 specs | yes, 39 specs |
| Fresh development server; whole app compiled first | 295 entries, 13 compilations, 194 s | 295 entries, 13 compilations, 173 s |
| Passed | **318** | **318** |
| Failed or did not run | **0** | **0** |
| Skipped by declaration (not counted) | 99 | 99 |
| Playwright process | exit 0 | exit 0 |

The same 318 tests passed in both orders (by identity). Server: no worker restart, retained heap at most 2,289 MiB,
the longest event-loop delay while tests ran 321 ms (2.8 s only while the app was compiling), the 15 s canary 408
requests with no failure and a slowest answer of 1.16 s (it had reached 29.9 s before the repair). `npm run
check:stub-reset`: PASS (141 mutable bindings, every one covered). Wall time 43 min, build included. Evidence:
`summary.json` (contract `e2e-order-summary/3`), both reports and timelines, the stamped server log, the canary and
both precompile records.

Earlier, before the reversal defect was known, `5ed92244` ran two complete same-order passes on one server with the
memory repair (317 of 317 each, no restart, retained heap at most 2,465 MiB) — evidence that one server holds across
634 tests, not of order independence.

**No genuine application failure was found.** Every failure observed in this work package was the runner or the
development server (defects 2–3) or the not-reversed reverse order (defect 4); the one application defect found —
LensPanel claiming completion before its readback — is repaired below. Not hosted, device or PHI qualification.

## The command

```bash
PW_CHROMIUM_PATH=/opt/pw-browsers/chromium npm run test:e2e:order   # every spec, forward then truly reversed, a fresh server each
npm run check:stub-reset
```

Works with `CI=1`. The default development heap is 10 GiB with a 4 GiB reserve (Codex's `f97bb2d8` raised it to 12 GiB;
kept at 10 here because 12 GiB plus the reserve exceeds a 16 GiB runner, and the repaired server peaks near 2.3 GiB);
on a smaller or cgroup-limited machine set `E2E_DEV_HEAP_MB` explicitly (the runs here used 9,216 on a 16 GiB
machine). Do not set a heap in `NODE_OPTIONS` as well. It is not added as a CI job here: one run is two fresh servers,
each compiling the app and running every spec (43 minutes locally, build included); whether to spend that per push is
Codex's call. CI's sharded live-fixture job remains the per-push gate; its comment about one dev server degrading
across a 300-test battery describes defect 3, which the shards no longer need to absorb, though nothing here changes
them.
