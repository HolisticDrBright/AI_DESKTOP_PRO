# Telehealth admission repair recheck — October 10, 2026

## Decision

Do not integrate, register migration 113, provision an admission key, or deploy
the returned candidate yet. The original A1/A2/A3 repair tests pass, but a new
expiry regression is reproduced at the actual restricted-role SQL boundary.
No AWS write, secret retrieval, provider call, paid build, or activation occurred
during this recheck. PHI remains disabled.

Reviewed return: `HolisticDrBright/AI_DESKTOP_PRO`, branch
`claude/telehealth-chart-lifecycle-20261010`, commit
`7ff170b70f6fd887aa0e7c5d8e7b9f7424ff2b2f`. Candidate
`20261010150000_production_telehealth_chart_lifecycle.sql`, contract
`telehealth-chart-lifecycle-candidate/2`, SQL SHA-256
`1afc499793172f0a3ce76ca465bc857063dd2105044c9009fff73498dfa1d070`.
This remains a proposed extension of the exact 112 parent, not a registered or
hosted migration.

## B1 — P1: expiry is checked against function-entry time

In `infra/aws-clinical-core/production-candidates/telehealth-chart-lifecycle.sql`,
`transfer_telehealth_note` initializes `_now := clock_timestamp()` at line 260.
It then resolves clinical authority (line 264), parses the admission and waits
on the appointment advisory lock (line 288). The admission check at lines
314–315 still compares `expires_at` to that entry-time value. No fresh clock is
read before creating the encounter, draft and receipt.

Reproduction leaves the candidate transfer function unchanged. The real SQL
authority dependency is wrapped with its original authority check followed by
`pg_sleep(0.25)`. A real HMAC-signed admission expires 100 milliseconds after a
database clock reading. The restricted API-role call nevertheless returns
`created:true` and creates the destination instead of rejecting the expired
admission. The wrapper is restored in `finally`.

Result: **18 existing database tests passed; this new nineteenth test failed**.
The failure is an unexpectedly fulfilled transfer, not a setup failure. The
case took 784 milliseconds, then reproduced again in 787 milliseconds with
the same 18-pass/1-fail result. This controlled dependency-delay test proves the
stale-clock defect; it is not a claim that an actual parallel PostgreSQL
advisory-lock race has been hosted-tested.

### Repair and acceptance

1. Validate expiry against a fresh database clock after blocking authority/lock
   work, and ensure admission is still valid at the mutation admission point.
   Do not merely rename the original timestamp or rely on `now()`/transaction
   start time. Preserve the refused-request rollback/no-write guarantee.
2. Preserve current authority and key-revocation checks. Add a real PostgreSQL
   lock-wait negative during hosted qualification and verify revoked-authority
   and retired-key race behavior; those races are not yet certified by this
   embedded test.
3. Keep the new negative test unchanged in intent: expiry during processing
   must reject and leave no destination writes. Continue running the original
   admission, receipt, retry, signature and correction tests.
4. Return a distinct repaired candidate identity, its exact SQL hash and
   validator/mapping updates. Do not rewrite the frozen 112 parent or alter
   historical preserving operators. Coordinate registration of 113 separately.

### Diagnostic test to add

Insert inside the existing `Codex A1: source admission at the chart write
boundary` describe block in
`src/server/clinical-core/telehealth-chart-lifecycle.database.test.ts`.
All helpers below already exist in that test file.

```ts
it('Codex B1 refuses an admission that expires while current clinical authority is being resolved', async () => {
  await pg.exec(`alter function clinical_private.require_clinical_patient(uuid,uuid) rename to codex_authority_before_delay;
    create function clinical_private.require_clinical_patient(uuid,uuid) returns uuid
    language plpgsql security definer set search_path='' as $$
    declare actor uuid;
    begin
      actor:=clinical_private.codex_authority_before_delay($1,$2);
      perform pg_catalog.pg_sleep(0.25);
      return actor;
    end $$;`);
  try {
    const start=(await pg.query<{at:string}>(`select to_char(clock_timestamp() at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') at`)).rows[0].at;
    const issuedAt=new Date(Date.parse(start)-1000).toISOString();
    const expiresAt=new Date(Date.parse(start)+100).toISOString();
    await expect(transfer({issuedAt,expiresAt})).rejects.toThrow('telehealth_admission_mismatch');
    await noWrites();
  } finally {
    await pg.exec(`drop function clinical_private.require_clinical_patient(uuid,uuid);
      alter function clinical_private.codex_authority_before_delay(uuid,uuid) rename to require_clinical_patient;`);
  }
});
```

Run with `npx vitest run
src/server/clinical-core/telehealth-chart-lifecycle.database.test.ts
--no-file-parallelism`.

## Independently observed evidence

- The returned database suite passed its original 18 cases before the new
  negative was added, including the production dispatcher against the database.
- The telehealth Lambda suite passed 95 cases. Together with the RDS rejection
  mapping suite, the three selected files passed 292 cases. No fresh inventory,
  full 6,272-test battery, or positive real-Zoom test is claimed by this recheck.
- CI for the returned head was still in progress at observation:
  [run 38082420214](https://github.com/HolisticDrBright/AI_DESKTOP_PRO/actions/runs/38082420214).
  The predecessor's green run is not evidence for this head.
- Separate Codex integration head
  `e7f1cab4a0a5710e5993f1e39c1023d17df8d8d0` passed a stable full local run:
  433 files, 6,744 passed, 11 existing skips, zero failures. Its source-input hash
  was `0fcb7e964a0e32ca20f1ebf0f0a36a5f010eade567947dda084d25cf912252d5`.
  Both exact-head hosted checks succeeded:
  [38081784517](https://github.com/HolisticDrBright/AI_DESKTOP_PRO/actions/runs/38081784517)
  and [38081781927](https://github.com/HolisticDrBright/AI_DESKTOP_PRO/actions/runs/38081781927).
  These do not qualify or integrate Claude's new chart candidate.
- The earlier `5fd2f4e` main CI run failed a consent-copy database test selecting
  the older copy. Its ordering uses approval time, creation time and a UUID
  tiebreaker; fixture timestamp ties need investigation. Later green runs are
  recorded separately, not used to rewrite that failure as a pass. No assertion
  or historical SQL was weakened in this recheck.

## Work after source repair, still not done

Integrate the two source lanes without dropping the exact clinic-host/secret
authority controls. Obtain exact preserving-upgrade review where bytes changed;
then coordinate a separately reviewed admission-key registrar, exact candidate
mapping and synthetic deployment. Never expose the key in the browser, logs,
handoffs or reviewer hashes. Test the real negative/race matrix and both
participants with fictional data before claiming hosted acceptance.

Clinic export scope, record retention/disposition, Zoom-copy retention,
per-clinic hosts, V2 consent and physical journeys remain open. Commercial and
PHI readiness are not established by these source tests or a green CI run.
