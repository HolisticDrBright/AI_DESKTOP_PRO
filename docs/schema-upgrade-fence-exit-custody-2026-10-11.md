# Schema operator custody through fence exit

This source-only repair follows the separately approved 462496a operator. It changes both compiled operator identities and therefore requires a new exact executable review before a forward AWS upgrade. Historical SQL, 107/111/112 ledgers, target identity, engine-bound whole-schema verification, provider/consent gates and PHI restrictions are unchanged.

## Actual AWS boundary

The approved 462496a Fullscript inspect56518 passed at 107, 209 historical tables and 56 rows. Rollback rehearsal94631 passed with rolledBack true and identical preservation hashes; post-inspection40927 passed at the unchanged predecessor. No forward upgrade, dependent consent operation, fixture, provider, consent copy or activation was performed. The qualification account remains synthetic-only with PHI false and activation blocked.

## Reproduced defect

Both Fullscript and telehealth-consent commands previously removed native custody from inside their outer DB fence callback. The actual Data API adapter commits that outer transaction after the callback returns. A lost completion could therefore leave a failed command with no original recovery lock. The read-only recovery path also retired its guard and original lock before that completion.

An initial native test correctly reproduced the two writer failures; its recovery cases had a mismatching fixture target digest and were not valid before evidence. Corrected independent diagnostics loaded the original frozen 462496a command/native modules without editing that checkout: all four upgrade/reconcile cases failed specifically because the actual local original lock was absent after a simulated lost outer-fence reply. The two temporary diagnostic copies were removed after execution; the repaired regression suite remains in source. The outer DB transport and observations were fictional; this is real file/process custody evidence, not a native PostgreSQL lock or Aurora interruption test.

## Repair

Settlement now returns only a prepared local retirement closure and immutable public identity. The command requires exactly one fence callback, its exact unchanged result and the original closure; missing, repeated, substituted or mutated replies are refused. Only a successful outer completion permits local retirement. No database work occurs after that exit. Public custodySettled true is emitted only after local retirement succeeds; a prepared archive is explicitly version2 and retirement prepared_only, not a settled or deletion receipt.

The closure rechecks source/directory guards, original header, journal, archived operator, prepared receipt, archived lock, and their file identities and exact bytes. Recovery also rechecks the stopped original process and both guards. Retirement has no await between final local checks and removal; recovery removes the subsidiary guard first and original lock last. Changed or same-byte-replaced archives retain original custody. Lost exits, local failures and uncertain outcomes never cause a write retry or completed command result. Existing read-only recovery still requires its original binding and settlement interval.

## Evidence and remaining work

Six operator/native/embedded-database suites45227 passed116 tests, including the corrected four lost-exit negatives and successful exit, changed-archive and identical-byte replacement for both writer and recovery. The shared wrapper suite now passes13 independent cases, including a retained callback refused after fence exit. Final typecheck86379 and targeted lint pass. Earlier typecheck exposed a generic-result inference error and then a test-only generic-port typing error; both were repaired and the final check is clean. Three initially guessed gate names did not exist and were not counted as executed. Correct repository production-core, compatibility, operation-inventory and stub-reset gates then passed; all226 operations remain blocked and140 provider-specific rewrites remain. Dirty development builds compile but are explicitly not usable operators; the artifact/refusal gate passes5 cases. No successful full suite, CI, new clean build or new executable approval is claimed for this increment yet.

Before AWS forward execution: final typecheck/lint, both clean builds and artifact gates, full exact-source suite/CI, new digests and exact reviewed targets, and fresh managed identity/preservation/rollback/custody checks. The previous approval remains recorded for its old exact bytes, not these replacements. Hosted interrupted-response/fence contention qualification remains separate. All six original commercial-readiness scopes, device journeys, provider/store acceptance and policy approvals remain unfinished.

Final focused suite20571 passed all129 cases across seven files after the retained-callback guard was added. Final typecheck86379, targeted lint, whitespace check and the explicit CI hook are verified. AST generation remains a separate observation and final clean builds/full-suite/CI must be bound to the published exact source. No runtime code was changed after this final focused suite.
