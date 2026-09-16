# September 16 integration and repair evidence

Claude's Desktop branch at `222e68a3959b3cf8a7324693615e6a0ab9fca25f` and V2 branch at
`e32858343526f9e739477b7c6b0f58b8e28978f4` were fast-forwarded into the existing
`codex/commercial-release-readiness` working branches. No live workload, mobile
build, provider activation, approval record or PHI flag changed.

## Defects repaired

1. Reproductive collection context called a consent-management-only SQL function
   from a clinical-data transaction. The new migration `20260916060000` introduces
   a purpose-limited boolean check using the same owner lock as writes/withdrawal,
   plus an insert trigger that enforces consent when bypassing the TypeScript
   adapter. API reads withhold context after withdrawal. The separate SQL statement
   after acquiring the lock observes committed withdrawal at READ COMMITTED.
   This does not claim that already-delivered network responses can be recalled.
2. Active-plan resolution trusted record ID alone. V2 now reads the exact stored
   revision, checks its content digest, rechecks the pointer, and compares the local
   wire payload. Failed verification returns no active regimen; saved copies remain.
   The Plan screen explains the state and offers a read-only retry. Same-ID changes
   are adopted again; only exact revision/hash/consent matches are no-ops.
3. Server adoption now binds the digest to stored content under the owner lock;
   verifies acknowledgment hash, consent, request and predecessor; and casts Data
   API integer parameters explicitly. The SQL pointer is not clinical approval.
4. Active-plan/privacy adapters expected decoded objects, but Aurora Data API
   returns JSON text. Both now decode and validate database responses; malformed
   JSON still fails closed. Raw request bodies are not reinterpreted as JSON strings.
5. Privacy fulfillment could delete identity while voice was `not_enumerable`
   and lab cleanup only `tombstoned`. All nine stores are now represented first;
   unresolved stores and unverified retention block disable/sign-out/deletion.
   Provider exceptions are replaced with bounded codes, not copied into receipts.
   Full account fulfillment is still incomplete, explicitly not certified.
6. The load qualification CLI did nothing on Windows because it compared native
   paths to URL paths. It now uses `fileURLToPath`, rejects negative body sizes,
   and releases response bodies without storing their content. Native-process
   infrastructure tests have explicit child-process deadlines rather than relying
   on a five-second unit-test budget for three Node startups.

## Executed evidence

- Real Aurora rollback-only acceptance: **107 assertions passed** through the
  actual handler/adapter/Data API. Includes collection consent grant/refusal/
  withdrawal, direct-SQL insert refusal, isolation, active-plan lineage/adoption/
  digest refusal/replay, privacy submission/replay/tombstones, and restricted
  workforce/guardian functions. Rollback verified; **zero retained fixture rows,
  no retained schema, PHI false**. No production migration was committed.
- Voice provider/storage/payment dependencies in that test remain doubles. The
  run is not hosted Lambda, physical device, provider, or concurrent-session evidence.
- Production migration artifact: **55 migrations**, zero seeded approvals/rows;
  omission gate passes. Generated owned-lab/voice CloudFormation lint passes.
- Credential-free Desktop security matrix **29/29**; evidence hash
  `13b94f5151e514d0782002bf10c8072a48f01a1f46b47732e6d58447df061f1a`.
- V2 security refusal matrix passes; evidence hash
  `6492b9ed7fd1afaf8b5e5e5209cedad3f86f9877ec15ab7429883776a783c8da`.
- Load runner self-tests and dry run pass; **no hosted load run** was performed.
- Full local unit suites: Desktop **1,671 passed / 11 existing skips**; V2
  **1,043 passed / one existing hosted skip**. Typechecks pass. V2 lint is clean;
  Desktop retains four pre-existing warnings. Machine-contention timeouts were
  observed in native-process tests and resolved with bounded process deadlines.

## Release status and remaining engineering

Not commercial ready. All six original phases remain partial in V2's fixed
`expo/docs/commercial-six-phase-ledger.md`; no additional numbered phase is invented.

Remaining code/integration includes functional production hosting/bootstrap and
personal-storage activation infrastructure; full multi-store export/correction/
deletion and guardian access; server age-at-draw matching and clinic collection
context transport; provider and store integrations with real test callbacks; exact
release deployment, restore/rollback/load/security and physical device acceptance.
Cross-device plan review/revalidation is not completed merely by verifying a pointer.

Human/external gates remain separate: executed agreements/BAAs, approved retention
and response ownership, signed/source-verified clinical releases, store products/
merchant agreements, provider approvals, alarm recipients, paid-build authorization
and physical iOS/Android tests. A populated credential or source approval is not a
substitute. Preserve all clinical holds, exclusions and source-verification gates.

Hosted synthetic lab source remains `883623f`; Desktop web remains `4ffd5f2`.
Installed V2 is unchanged. GitHub CI for the newly pushed heads must be checked
independently; prior green CI and hosted tests skipped for missing secrets are not
evidence for these exact new commits.
