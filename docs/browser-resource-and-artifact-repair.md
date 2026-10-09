# Browser resources and isolated migration artifacts — September 17, 2026

This is release-test infrastructure work, not a deployment or PHI activation.
All six original commercial-readiness scopes remain open.

## Full CI qualification result

Desktop source `dd3694eab357164601e0dbc881f75be00e69fb45`, CI **35272294502**,
completed SUCCESS on September 17. The unchanged full live-fixture selection
finished with **295 passed, 19 existing skips** in 25.6 minutes. Job105374355309
logs confirm the requested10240MiB budget and the actual long-lived Next worker
(PID3306):51 memory samples, peak observed heap6,880,107,664bytes, actual V8
heap limit10,787,749,888bytes, and **zero threshold-restart messages**. The
short-lived helper processes in the log are not replacement Next workers.
This qualifies the resource/harness repair for this source/run, not a production
memory-leak fix or hosted clinical acceptance. Later release candidates still
need their own CI result. The earlier failures below remain part of the record.

V2 source `b206b7e62ecdbfaceefda8fcfa4960397646cbec`, CI35274202914, also passed.

## Evidence and changes

Desktop CI 35266197149 failed at the EMR note POST immediately after Next 15.5.25
reported its development memory-threshold restart. The trace records
ERR_CONNECTION_REFUSED, retained note text, Unsaved changes and Retry save.
The editor did not claim persistence. Next's installed start-server restarts
above 80% of its heap limit; next-dev otherwise budgets 50% of physical RAM.

The full single-process live-fixture job now requests 10240 MiB old-space for its
development server only. The harness refuses invalid/competing budgets and
requires at least 4096 MiB additional total/constrained memory for Chromium,
native allocations and the OS. This is capacity provisioning, not a claim to
have eliminated a memory leak. Numeric worker start/sample/exit diagnostics
include the actual heap limit, used heap, RSS, PID and exit code. No request,
token, environment dump, heap snapshot or health content is collected. CI will
not reuse an unowned pre-existing server. Production configuration is unchanged.

The full 314-case selection, one browser worker, zero retries, timeouts and save
assertions are unchanged. Qualification requires the full new CI run, including
inspection for further threshold restarts; a passing focused unit test is not
that evidence. The prior 6834e76 run 35270244009 was still running at this edit.

A full unit run also reproduced an independent shared-build race: parallel
database suites removed/rebuilt the same production-migrations directory,
causing ENOENT in the builder. The canonical builder now validates and hashes
the entire artifact in memory before writing. Its --json mode returns those
same bytes without filesystem writes, allowing each SQL suite to consume its
own complete artifact. All 65 migrations and fictional SQL tests remain.
Parallel CLI builds match each other and the normal release files byte for
byte; the local release digest is `3f3d85410613f81a8188354749ba4535e4ff505fb46e382db837e7ccef3e4620`.

Unit worker concurrency is capped at 2 to avoid CPU/native-bundle/PGlite
overcommit. No test deadline was raised, assertion weakened or case excluded.
The initial overloaded run also exposed two existing 5-second native-process
test timeouts. A four-worker run passed, but a later run overlapping Graphify
still hit one process-startup timeout. That is retained as failed evidence, not
treated as a successful run. The final two-worker check runs without Graphify.

## Executed checks

- 18 new resource/probe tests pass, including invalid budgets, constrained RAM,
  production refusal, real child-process exit and no secret logging.
- 2 new artifact tests pass: concurrent canonical generation and exact release
  file/hash equality.
- Full units before the 2 artifact tests: 2189 passed, 11 existing skips, 194 files.
- Final full two-worker run: **2191 passed, 11 existing skips, 195 files**.
- Typecheck, changed-file lint and production 65-migration/no-seeded-row gate pass.
- Playwright config loading enumerates all 314 live cases in 25 files.
- No hosted acceptance, physical microphone/device test, AWS migration or paid
  mobile build occurred. The numeric memory probe's real Next-child behavior
  and resource budget remain subject to the new CI browser run.

V2 exact source aac09e97de6ecc34dab68dab386b0b7d10513b5c CI35270253655
completed SUCCESS, including final-image/catalog isolation checks. It is not
an AWS or installed-phone nutrition rollout.
