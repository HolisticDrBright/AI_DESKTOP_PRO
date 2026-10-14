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
