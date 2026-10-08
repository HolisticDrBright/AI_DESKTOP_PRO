# Care erasure acceptance matrix status

The nine required hosted journeys are not complete. Local database tests cover
the registered synthetic erasure contract and the separate production messaging
consent contract. They do not prove simultaneous Aurora transactions, actual
Gateway delivery interruptions, physical second devices, or production activation.
Keep PHI disabled and paid mobile builds held.

## Local evidence

On October 8, the two suites below passed 46 tests: 25 synthetic erasure tests
over all 47 canonical migrations and 21 production messaging tests over the real
production SQL artifact. The production-shaped tests use fictional local PGlite
rows; no production AWS service or real personal data is involved.

```powershell
npx vitest run src/server/clinical-core/care-erasure-recovery.database.test.ts src/server/clinical-core/production-care-messaging.database.test.ts --maxWorkers=1
```

Five new erasure tests verify read-only recovery of a lost terminal reply, both
serialized cancellation/erasure orders, owner privacy access after an actual
messaging-consent revocation and paused link, and byte-for-byte preservation of
another owner's message on a separate connection. The consent fixture initially
used the wrong argument order for `record_consent_grant`; correcting the test
setup made it pass. No runtime defect or migration repair is claimed from that
setup failure.

| Required hosted case | Local evidence and limitation | Hosted status |
| --- | --- | --- |
| `prepared_erased` | Prepared intent admits exactly one erased receipt. | Required |
| `prepared_cancelled` | Settlement fences the prepared UUID and late erase. | Required |
| `lost_prepare_reply` | A fresh service instance discovers a committed intent. No real HTTP reply was lost. | Required |
| `lost_terminal_reply` | The transaction commits before fictional client receipt loss; fresh receipt and discovery reads return the exact receipt without another erase. | Required |
| `second_session_discovery` | Independent service instances share one local database. This is not two physical devices. | Required |
| `cancel_erase_both_race_orders` | Both serialized orders converge on one immutable terminal. PGlite is one session; simultaneous Aurora race testing remains open. | Required |
| `request_replay` | Exact repeats preserve the receipt and one ledger row; changed scope conflicts. | Required |
| `cross_owner_refusal` | The same UUID is owner-scoped; foreign discovery and receipt reads disclose no owner record. Another owner's valid message is preserved byte-for-byte. | Required |
| `consent_withdrawal_refusal` | Production messaging refuses clinical sends/reads after withdrawal and preserves owner export. Synthetic erasure recovery remains available after revocation and pause. The older synthetic messaging function lacks the production scope-consent predicate, so its success cannot qualify this case. | Required |

## Consent and privacy boundaries

Clinical processing and owner privacy operations have different purposes.
Consent withdrawal must stop the relevant sharing; it must not strand an owner
who needs their erasure receipt or retained correspondence export. Do not add a
clinical-consent requirement to `prepare_erasure`, discovery, cancellation or
receipt reads to manufacture a refusal.

The synthetic `care_message_request` is not the production messaging consent
contract. The production candidate checks current signed messaging consent and
coordinates withdrawal with the connection lock. A hosted withdrawal case must
exercise the reviewed candidate and exact target that implement that contract,
or first qualify a separately registered synthetic successor. Do not rewrite
the already-applied 47-migration history or call a paused-connection refusal a
scope-consent test.

## Remaining hosted engineering

1. Bind the matrix runner to an exact reviewed target and designated disposable
   fictional fixtures. Existing five-persona records are not disposable erasure
   fixtures. Inspect identity, source, schema, route and authority independently
   before a mutation; refuse unrelated data or an unknown prior intent.
2. Keep a durable request journal across admission and observation. Lost replies
   need a known admitted request and independent recovery, not a blind second
   erase. Preserve unknown outcomes until independently reconciled.
3. Run simultaneous cancellation and erase transactions in both observed lock
   orders against Aurora. Record the actual terminal winner and preserve one
   receipt. Serialized local calls cannot substitute for this evidence.
4. Prove current consent withdrawal blocks clinical sharing while privacy
   discovery, settlement, receipt and retained export remain owner-accessible.
5. Inspect bounded, owner-scoped fixture deltas and unrelated records before and
   after each journey. Fixture mutations must have their own preservation proof;
   never loosen the registered release's unchanged-database pins to make them pass.
6. Issue acceptance only from actual observations of every required case. Skips,
   mock replies, unconfigured routes and refusal-only routing recovery are not a
   positive matrix pass. Provider copies, backups, clinic retention and physical
   device tests remain separate gates.

The registered release and its 105 routing/recovery observations do not execute
this mutating matrix. These new tests do not change its exact source identity,
the canonical migration manifest, any consent approval, or PHI activation.
