# Desktop E2E order runner qualification — October 13, 2026

Status: **open; not release evidence**. This change repairs the runner's
configuration but does not make the full forward/reverse browser battery pass.
No clinical or production fixture boundary was relaxed.

## Observed failure and repair

`npm run test:e2e:order` previously built a clinical bundle and then started
`next start`. That runtime sets `NODE_ENV=production`, so the local contract
fixture categorically refuses it. This explains the earlier broad browser
failures; a production server must continue refusing fictional fixture data.

The runner now builds the clinical production bundle with the fixture disabled,
then starts `next dev` against a pinned loopback-only fictional backend for the
browser battery. It refuses an external backend, non-fictional credentials, a
production posture, or insufficient memory before any fixture request. Its
Playwright invocation explicitly reuses the server that the runner itself
started, including under CI. Other CI browser jobs still refuse a stray server.
The development-only heap is bounded at 10 GiB with a separate 4 GiB reserve;
no production process receives that setting. The Playwright output buffer is
large enough for the full battery rather than Node's 1 MiB default.

Focused evidence: 7/7 runner configuration checks and 19/19 resource checks
pass. With the 10 GiB dev-server budget, the affected sign-in and patient
overview journeys pass 7/7 against the local stub, including browser → API →
data → response. The production bundle builds with the fixture disabled.

## Remaining browser failure

The full one-process, 39-spec forward/reverse command is still **red**. The
first dev-server run with the default Node heap produced several 120-second
navigation failures. A repeat with the bounded 10 GiB heap ran farther but
still produced these forward-order failures before it was stopped:

- `live-login-readiness`: `page.goto('/login', waitUntil: 'commit')` timed out
  at 120 seconds, then reported `net::ERR_ABORTED` when Playwright ended it.
- `live-lens`: the POST reported evaluation complete, but the subsequent GET
  remained at “Loading evaluation…” and `lens-core` was absent after 45 seconds.

Both failures occurred after multiple prior suites had exercised the same
development server. The isolated 7-test run passed, so that narrower result
cannot stand in for the one-process order-independence proof. The lens UI also
showed its completion notice before its readback settled. A fictional browser
regression reproduced POST 200 followed by GET 503: the old component displayed
both “Evaluation complete” and “Readback unavailable.” The component now
announces completion only after a bounded readback confirms the exact
evaluation id and status. On a failed or mismatched readback it clears the
unconfirmed result and shows an error, without asking the practitioner to
re-run a write that may already have succeeded. Both the failed-readback and
older-id browser cases pass; the ordinary six-case Lens journey passed after
the repair. This closes the **false-success UI defect**, not the underlying
long-run server stall or the sign-in timeout.

The next investigation should retain server logs and memory samples at failure,
measure response timing for `/login` and the lens evaluation readback under
the full battery, and fix the underlying long-run stall. Do not split specs
into separate processes, extend timeouts, skip them, or mark the browser gate
green on the basis of the targeted run. The production-only browser boundary
remains separately tested under its built-runtime CI job.

## October 13 forensic follow-up — worker restart observed, gate still open

A full forward-order **diagnostic** run of all 39 specs in one Playwright process
ended with 304 passed, 1 failed and 99 skipped in 2,526 seconds. Its local-only
trace and list output are under `.forensic/e2e/2026-10-13T23-50-14-018Z/run-1/`.
The failed case was `live-tasks.spec.ts`'s expired-token rotation journey: the
server rotated the fictional access cookie, but the page stayed at “Loading
review queue…” for the 45-second assertion, with no task API request in the
browser trace. This diagnostic result is **red**, not release evidence.

The retained development-server log establishes a cause in the test runtime,
not merely a correlation from memory sampling. Next logged “Server is
approaching the used memory threshold, restarting...”; its worker PID 19660
exited with code 77 at 8.16 GiB V8 heap used and 9.86 GiB RSS. The replacement
worker PID 29456 started during the battery. The task-page failure occurred
after that transition. This does not prove every earlier stall has the same
cause, nor does it prove the application's production runtime is affected.

Two gate-honesty defects were also closed. The canonical order runner now
requires each Playwright child to exit zero even if it printed a passing-count
summary, and requires forward/reverse skipped totals to agree. Eleven focused
runner tests pass. The forensic runner now exits nonzero on any failed test or
failed Playwright child; its earlier terminal code zero despite one failed test
must not be read as a passing diagnostic. Diagnostic artifacts are ignored by
Git, not deleted.

Next.js 15's documented `experimental.webpackMemoryOptimizations` was tested
for Webpack compilation. Typecheck and the 11 focused runner tests passed.
No fixture posture, test timeout, skip, production PHI setting or clinical
release condition was changed.

The first canonical rerun with `webpackMemoryOptimizations` compiled the
production bundle, but its forward-order browser battery recorded at least
three failures: one Lens result never reached its success notice, and both
login-readiness cases timed out. A direct loopback `/login` request also timed
out after eight seconds while the original development worker stayed alive but
idle. That confirmed-red run was interrupted before reverse order; do not
report a forward total or reverse conclusion for it. The bounded Webpack
memory option alone did not close the gate. CI for the source commit
`40a718e39f7a94a7661c4257241c721d28e58301` succeeded, but its partitioned
browser jobs are not this one-process proof.

A second diagnostic started the same one-process battery under Next 15.5's
`next dev --turbopack`, retaining the separate clinical production build and
fixture refusal. The forward run recorded a billing inventory assertion
failure and a Lens run that remained at “Running…” past its 15-second notice
check. A direct loopback `/login` request then timed out while the fixture
backend answered and the original Turbopack worker stayed alive but idle at
about 4 GiB RSS. That confirmed-red run was interrupted before reverse order;
it has no complete totals. The bundler switch did not close the stall and was
removed from the canonical runner. Its unresolved root cause remains a release
gate. The billing test also lacked an authoritative save/finalize wait; a
separate focused run will determine whether that is the entire inventory
failure or whether the product has a defect. With explicit waits for the
server-adopted “Draft saved” receipt and the finalized “Open” status, the
void/reservation case passed alone and the entire 21-test billing file passed
against a fresh fictional local fixture. This supports a test/navigation race
for the billing observation; it does not make the stalled full battery pass or
prove the real billing provider path.

Because neither Webpack memory optimization nor Turbopack closed the full-run
stall, both trial configuration changes were removed. The runner's stricter
exit-code and skipped-count checks stay in place. A separate trace or worker
diagnostic is needed before the browser gate can be called stable.

The stalled Lens screen exposed a separate user-facing recovery defect: its
evaluation POST had no deadline, so a lost response left “Running…” indefinitely.
The request now has a 30-second browser deadline and clears the running state
with an error without claiming completion. The new lost-reply browser test
failed against the prior code (no error after 33 seconds), then passed with the
deadline; all eight Lens browser tests passed on the patched source. This is
an error-recovery improvement, **not** a fix or a pass for the one-process
browser gate or evidence about the production server under load.

## October 13 runner backpressure finding — full gate still running

The canonical runner spawned `next dev` with stdout and stderr pipes drained by
its own event loop, then called `execFileSync` to wait for the entire Playwright
battery. That synchronous wait prevents the same event loop from draining the
server pipes for the duration of the 39-spec battery. A full pipe can block a
live dev worker's writes and make even `/login` stop answering. This is a
specific runner defect consistent with the previously observed idle-worker
stall; whether it explains every failure must be decided by the full run.

The runner now waits for each Playwright process asynchronously while draining
both the browser-child output and the dev-server output. It preserves the
64 MiB browser-output cap, child exit-code requirement, one-process suite per
order, and forward/reverse count checks. A focused test proves the parent
event loop keeps advancing during the child wait, and tests still reject a
nonzero child that printed a passing summary and an oversized child output.
The development-only numeric probe now records event-loop utilization and
delay beside heap/RSS, without request paths, headers or payloads. Fourteen
focused runner tests and lint pass. This is **not** yet a passing full browser
battery or a production-hosted/device observation.
