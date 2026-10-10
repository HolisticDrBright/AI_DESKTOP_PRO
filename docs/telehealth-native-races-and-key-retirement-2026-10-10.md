# Telehealth native races and key retirement

Real local PostgreSQL sessions reproduced a chart-transfer defect not exposed
by the embedded delay tests: a registered admission key could be retired while
the transfer waited on its destination lock, but the transfer still created an
encounter, unsigned note, receipt and audit after retirement committed. The
separate forward key-fence candidate repairs that ordering. This is local
fictional source qualification, not an AWS deployment or PHI approval.

## Concurrency contract and repair

The transfer validates the selected unretired key with `FOR SHARE` and retains
that row lock through transaction completion. If retirement wins before key
admission, the transfer is refused without destination writes. If a transfer
holds the key first, retirement cannot commit until that admitted transaction
settles. Once retirement commits, new attempts and receipt retries using that
key are refused; an already completed chart record is not erased.

The SQL change is exactly that lock on the existing selected key. Admission
signatures, byte hashes, authority, binding, expiry checks, patient custody and
chart draft semantics remain unchanged. No key, consent, review or record is
seeded. `FOR KEY SHARE` would not protect a non-key retirement update; the
candidate validator rejects that substitution. See PostgreSQL's
[row locking contracts](https://www.postgresql.org/docs/17/explicit-locking.html).

The exact 112, 113 and 114 source files remain byte-identical. The repair is a
distinct unregistered forward proposal, not a replacement of approved or
historical migration bytes:

| Identity | Value |
| --- | --- |
| Contract | `telehealth-transfer-key-fence-candidate/1` |
| Proposed forward file | `20261010210000_production_telehealth_transfer_key_fence.sql` |
| Exact parent count | 114 |
| Parent ledger | `7c09615ba12bd1122d34d459c57e1c88c42f1c51d598f4f71183e472b15d802c` |
| Parent assembly | `8e4fc72b54015f1f0b183fa308aeba8ff3db886e6e4c236fad88bf53f7820f3e` |
| Extension SQL | `813d2adebd908050f9307871b0ac0476a249d7c5abf45710c1ea4d5f851ba456` |
| Proposed 115 ledger | `cf9e9a80ec6e2973cf53ce1718ce1b48b48e6c62c90af360fb33bb45d6635119` |
| Proposed 115 assembly | `3172e6b60c62edbb9e9cec10fbc74fe908eb7c41bad562e499b08620d5d670a9` |

These are source identities, not review hashes or approval to register/apply 115.
The current runtime inspector still refuses 115 and still requires its original
18.3 owner profile. Preserving operators and independently qualified native
owner admission remain separate engineering.

## Local native matrix

The optional runner mode compiles its own fresh source cluster first. It admits
only the exact source ledger **and** assembly, random source database name,
PostgreSQL 17.7 and owner `postgres`, then creates fictional fixtures. Four
independent sessions exercise the actual `clinical_core_api` role and observe
blocking through `pg_blocking_pids`; a fixed sleep alone is not proof that a
writer reached the lock. The admin connection only sets up and observes the
fictional fixture. No AWS or Zoom/provider connection is accepted.

```powershell
# Baseline 114: expected FAILED verdict reproducing the retirement defect
npm run qualify:telehealth-native-source -- --binary-directory <absolute-pgsql-bin> --driver-directory <absolute-driver-directory> --matrix telehealth-transfer

# Same matrix plus the distinct forward source proposal: expected PASSED
npm run qualify:telehealth-native-source -- --binary-directory <absolute-pgsql-bin> --driver-directory <absolute-driver-directory> --matrix telehealth-transfer --candidate key-fence
```

Every case is mandatory:

1. Restricted API role cannot read the private key table.
2. Valid transfer and its exact retry return one unsigned note/receipt.
3. An admission expiring during the actual transfer lock wait writes nothing.
4. Authority revoked while waiting on that lock causes refusal and no writes.
5. A key retired before serialized admission causes refusal and no writes.
6. Concurrent identical transfers settle as one create and one receipt reuse.
7. Retirement during the actual destination lock wait obeys the ordering above;
   after retirement, the key cannot authorize even a receipt retry.

The runner independently observes a retirement committed before releasing the
destination lock, or a retirement blocked by the admitted writer. It never
treats an unobserved wait or unknown outcome as either order. The latter case
proved the baseline defect: retirement committed first, yet one destination and
receipt were created. The fixed source instead blocked retirement until the
writer settled. This is serialization, not a claim that every concurrent
retirement cancels a previously admitted writer.

## Verified runs and evidence limits

The initial six-case run `pg17-NUeMeX` failed on the baseline retirement case;
`pg17-62NwOa` passed after the repair. The expanded same-code seven-case pair
then reproduced the baseline failure in `pg17-tI2bl5` and passed all seven with
the forward candidate in `pg17-1rtelR`. Both paired reports confirm owned server
shutdown. The final pair with bounded secondary-session statement timeouts
reproduced the same baseline failure in `pg17-PzVsrA` and passed all seven in
`pg17-AjYbRH`, both with confirmed shutdown. The fixed local 115 schema fingerprint was
`896110af509d23b7d86abba9fb503c6b228a2c271f5101c00abfb6fae947678b`.
This is an observed local `postgres` fingerprint, not an admitted Aurora
`clinical_admin` profile.

Before fixtures, all 223 selected application tables were empty. Afterwards
the matrix intentionally holds fictional records and keys; reports therefore
state `sourceTablesInitiallyEmpty`, **not** that the final database is empty.
Execution is `local_fictional_sql_matrix`, never `qualification`; PHI remains
false, activation blocked, and upgrade/provider authorization false. Failed
case verdicts produce exit 1 after shutdown and are retained as findings.

Credential-free tests cover source candidate identity/immutability, refusal of
changed lock/approval/seeded-key claims, native session/ledger admission and
unsupported CLI modes. They do not replace the positive native matrix. CI runs
those source tests, not portable Windows PostgreSQL execution.

Current focused verification: 59 credential-free native-runner, key-fence and
race-admission tests; 75 retained schema tests; typecheck; targeted lint;
compatibility, operation-inventory and stub-reset gates all pass. The inventory
still reports 228 implemented but activation-blocked operations, zero enabled,
and 140 requiring provider-specific rewrites. No runtime activation changed.

The preceding exact `27a54c3` full application suite completed: 437 files,
6,870 passes, 11 existing skips. That is predecessor evidence, not this head's
full suite or current CI. All seven matrix cases concern local SQL, not MFA,
runtime release admission, a physical device or actual Zoom custody.

Remaining Codex work includes the true native owner profile, reviewed preserving
107→112 and 112→113→114→115 operators with custody/recovery/rollback, later
authority/key/appointment races, AWS deployment and hosted two-clinic/participant
acceptance. The exact replacement upgrade review is still pending. Claude's
independent clinic-record privacy/V2 Clinic Data Center lane remains unchanged.
All six original commercial phases remain open. Paid mobile builds and PHI
activation remain held.
