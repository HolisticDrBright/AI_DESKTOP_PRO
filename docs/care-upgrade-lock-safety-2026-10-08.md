# Care upgrade writer safety

October 8, 2026. These are source repairs to synthetic and qualification operators,
not new hosted migrations or readiness approvals. PHI remains disabled and paid
mobile builds remain held.

## Admission repairs

Five preserving-upgrade writers selected repeatable read before acquiring their
table locks. An initial identity or history query can fix that snapshot before a
competing writer commits. Waiting for a table lock does not refresh the snapshot.
The writer must therefore use fresh statement snapshots and acquire all existing
preservation-table and ledger locks before establishing its mutation witness.
See PostgreSQL's [transaction isolation](https://www.postgresql.org/docs/current/transaction-iso.html)
and [explicit locking](https://www.postgresql.org/docs/current/explicit-locking.html).

The affected writers now explicitly select read committed. After the complete
bounded lock succeeds, they re-read exact migration history and refuse any change
from the admitted predecessor before verification, fingerprinting or successor
DDL. They also recheck table inventory. Their read-only inspectors retain
repeatable-read snapshots. The five-second lock timeout, thirty-second statement
timeout, RLS checks, target pins and artifact identities are unchanged.

| Operator | Historical transition | Source repair |
| --- | --- | --- |
| Care erasure schema | Synthetic source45/live46 to source46/live47 | Fresh writer snapshot and core/reference history recheck |
| Care erasure intent | Synthetic source46/live47 to source47/live48 | Fresh writer snapshot and core/reference history recheck |
| Care messaging | Qualification103 to104 | Fresh writer snapshot, history recheck and captured input artifacts |
| Care connections | Qualification104 to105 | Fresh writer snapshot and history recheck |
| Care claim recovery | Qualification105 to106 | Fresh writer snapshot and history recheck |
| Qualification export recovery | Qualification102 to103 | Explicit writer isolation and captured inputs; existing post-lock history ordering retained |

The care-messaging and qualification export-recovery operators copy the supplied migration records
and configuration before its first asynchronous operation. Its admitted SQL,
target and activation values cannot change underneath the transaction. Existing
connection, claim and erasure operators already capture those inputs. Structured
operator refusals preserve their category and attach the actual failed stage;
provider details and SQL are not exposed.

Historical migration SQL, manifests, completed receipts, frozen deployment
artifacts and existing database history are untouched. These operators do not
acquire new deployment, consent, release, erasure or PHI authority from the repair.
Historical predecessor operators continue to refuse incompatible current ledgers.

## Verification

Fourteen new negative tests failed against the preceding implementations:
six in the two erasure suites, six in messaging/connection/claim, and two covering
explicit qualification isolation and messaging caller mutation. After repair,
all six complete database suites pass:117tests,106.91seconds, one worker.
Standalone typecheck and focused lint pass. No test deadline was widened, case
waived or source-verification requirement removed.

The ledger-change tests execute actual local SQL at the modeled lock-admission
boundary. They assert a refusal before any operator migration DDL and verify the
unchanged predecessor after rollback. They are PGlite order/rollback evidence,
not independent-session Aurora concurrency evidence. The separately recorded
catalog AWS concurrency pass does not qualify these different historical writers.
Any future admitted use still needs its own exact-source hosted qualification.

The first repair's full source suite is recorded below; later source and CI are qualified separately.
Previously completed PR81 CI at093b646 andb5669e1 is historical evidence for the
catalog journal repair and its evidence commit, not this increment.

### Full suite and qualification input capture

Full suite27957 terminated exit0 at exact source
`cde80f9edc42ef2256c5edbc61d75bbd08203ca1`:350files,4446passing tests,
11existing skips,614.22seconds. The checkout remained unchanged throughout that
run. CI37876631475 completed successfully at that commit;37876626628 was still
in progress at the last observation.

A later qualification input-capture check exposed two more regressions. Before
repair, a supplied artifact changed during the first asynchronous request could
execute an appended statement; a changed configuration could also alter subsequent
boundary checks. Both tests failed against that implementation. Their disposable
local adapter forced rollback even on wrongly admitted SQL; no AWS mutation or
lasting fixture change occurred.

The qualification operator now copies its admitted migrations and configuration
before awaiting, as the messaging operator does. Its complete fifteen-test suite
passes in7.04seconds after this later repair; standalone typecheck and focused lint
also pass. The full4446 result belongs to earliercde80f9, not the later source.
Final-source CI remains separate. Sixteen new regressions in total were shown to
fail before their corresponding repairs; no waiver, timeout increase or activation
substitution was used.

## Remaining original launch requirements

All six original phases remain open. The next engineering dependency is coherent
reference3 canonical registration and a custodied apply workflow with matched
catalog/identity runtime. Existing current bindings intentionally pin reference2;
old receipts must not be edited or bypassed to make a release appear current.

The authoritative owner-adopted plan and same-target verified ingredient inventory
remain incomplete. V2's plan-inventory helper has no runtime caller and cannot
stand in for server verification. Every program supplement step remains held
until the complete authorized inventory exists; lesson-only scope is not a
substitute for the owner's requested lab-driven Core launch.

Positive lab/document/audio, all nine erasure journeys, privacy/retention/recovery,
provider and Core19.99 store acceptance, matched releases and physical iOS/Android
verification remain distinct engineering and acceptance obligations. Executed
agreement coverage, security/retention review, source verification, clinical holds,
store/provider setup, paid-build authorization and physical participation remain
separate human or external gates. Neither app is commercial or PHI ready.
