# Registered release sign in failure reconciliation

The combined synthetic release deployed the exact registered API artifact,
then failed before admitting a recovery permission or route switch. Its final
record is `synthetic_member_principal_refused`. The writer deliberately emits
that finite code, but the stopped-run reader previously rejected it. This
repair recognizes only that exact additional value, not arbitrary error text.

The regression fails against the original reader and passes after the repair.
It preserves the failed outcome and original bytes, requires a new valid
assumed-role identity, refuses foreign accounts and malformed lookalike codes,
and never certifies recovery or performs an AWS write. The combined local
reconciliation and restoration suites pass 47 tests without skips.

Run `77bc69e39399b71cebd525ad9d64098c` remains failed. Desktop application source
`9597fcb709482c8eb9bedb2841b27993844a4a6e` and V2 source
`38ea48c07dc7d4ca7c2c37962b2a50ac178e381b` identify the deployed artifact
`285f33d0c033d266b34febbf53336e1f1853873d31c29138f3fc92e52941b0fc`.
The repaired operator must be attributed separately from that immutable
application source. Read-only reconciliation, a separately admitted recovery
rehearsal, and positive functional acceptance remain distinct requirements.
No paid mobile build or real patient data is authorized by this change.

The first repaired hosted observation then refused historical freshness before
reaching a new AWS inspection. A database read naturally finishes before the
enclosing snapshot; the old reconciliation reader required it to be no earlier
than that later snapshot. A second failing-before regression gives those reads
distinct timestamps. Historical journal validation now uses the original run
start, while deployment reconciliation uses the historical database-read time
as its lower bound. The five-minute database age and two-minute admission
snapshot bounds stay enforced; future and stale reads still refuse. Current
database observations still require the new operator's start and source.
