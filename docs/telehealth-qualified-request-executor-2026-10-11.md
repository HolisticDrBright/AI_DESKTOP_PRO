# Telehealth qualified request executor

This source-only increment extracts the 29 public appointment routes into the same domain dispatcher used by the historical handler. A separate executor accepts independently admitted actors and request-local transports. It does not install a Lambda, compose the complete native factory, activate a provider, or authorize a schema upgrade.

## Admission and isolation

`createTelehealthQualificationRequestExecutor` requires synthetic mode, PHI off, Zoom and payment providers off, reminders off, and no chart-admission secret. Internal events and webhooks cannot enter this executor. Forwarded authorizer claims are removed, not rewritten into fictional claims. A server admission port must issue an instance-owned receipt for the exact route, pool, request digest, actor and bearer. Future, expired, mutated or foreign receipts are refused.

Every request supplies all five transports: document storage, secrets, email, scheduling and fetch. There is no omitted-port fallback to the historical global clients. Async-local request state isolates interleaved owners, checks the admission deadline before and after each transport reply, rejects a backwards clock and closes the scope after the response. An inherited background callback cannot reopen it. Late responses report unavailability; this does not certify cancellation or reversal of an already admitted write.

The historical handler keeps its original production PHI guard, authorizer path and internal-event dispatch. The build still names the historical entry point. Both handlers execute the same actual public appointment domain code; no parallel simulated implementation replaces it.

## Verification and preserved failures

The initial new positive hold fixture omitted the required visit type and modeled a Get instead of the real Query. Its 400 refusal was retained until the fixture was corrected. An initial typecheck found an overloaded SDK method typing error; the method is now checked as an unknown function before invocation. Final typecheck and lint passed.

The predecessor `8c0b669` failed its original normal full run and exact CI 38172768083: 7,954 tests passed, one failed, 11 unchanged skips. The strict constructor scan required the single-attempt pin directly on the RDS constructor, while the constructor used a shared configuration containing the pin. This increment keeps the scan unchanged and makes the literal pin explicit. The focused repair run passed 252 cases across four files, including 65 new executor cases. Earlier core compatibility verification passed 396 cases across six files. None of these narrower results erases the predecessor failure.

The new executor cases cover all 29 route admissions, direct actor use, forged claims and receipts, missing transports, owner isolation, expired and late responses, input mutation, disabled providers, safe errors, inherited background work, and a positive hold through the actual domain dispatcher. The normal successor full run is tracked separately; parent results do not certify it.

The normal successor full run finished exit 0: 475 files, 8,020 tests passed, 11 unchanged skips, 869.79 seconds. Log: `handoffs/evidence/desktop-native-request-normal-full-20261011.log` in the root workspace. The historical artifact build and the actual operation-inventory/compatibility gates passed. An initial invocation of a nonexistent inventory script ran no gate; it is not counted as verification. Exact successor CI remains a separate observation.

## Remaining native integration

The trusted admission seam is not implemented by the fictional test port. The complete native factory still needs an immutable reviewed target loader, composition of independent Cognito/MFA and deployment observations, exact whole-ledger/function authority, current per-action rights, native restricted transports, durable write admission, replay, settlement and reconciliation. A temporary transport deadline is not durable write authority or proof of provider cancellation. External requests must not hold database locks.

The managed qualification database remains last observed at 112. Source 117/118 is not a deployed target and prior 107 to 112 approval does not authorize it. Hosted cross-owner refusals, concurrent changes, IAM isolation, provider coverage and physical journeys remain unverified. No AWS write, secret retrieval, provider call, migration application, paid mobile build, main merge, PR, production activation or PHI enablement occurs in this increment.
