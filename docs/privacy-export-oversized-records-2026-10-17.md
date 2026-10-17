# Privacy export: records larger than the page (2026-10-17)

**Scope.** Source and local tests only, on Desktop base `c327e9ae`, branch `claude/desktop-export-oversize-20261017`.
- No SQL was applied or registered anywhere. No AWS, Fly or Cognito call was made.
- Every owner, record and object store below is fictional.
- No production migration, qualification-target or acceptance file, campaign, revocation signal, Fullscript or V2 file
  was changed.

**Evidence labels.**
- **FAILING-BEFORE**: a test that failed on unchanged TypeScript.
- **COVERAGE**: existing behaviour, already correct, now pinned.
- **HOLD**: local source cannot settle it.

PGlite runs the real production SQL. It is not Aurora, and it is not the RDS Data API.

## 1. The defect (D1)

Three limits disagree:

| Where | Limit |
| --- | --- |
| `20260918010000_production_owned_lab_analyses.sql` | A `lab_analyses` payload may be 262,144 octets (`octet_length(payload::text)`). |
| `20260916010000_production_owned_privacy_export.sql`, `read_owned_privacy_export` | A page holds at most 24,576 bytes of item JSON. When the first record alone does not fit, it raises `privacy_export_request_invalid`. The bound exists because the RDS Data API limits each result row to 64 KiB, and the function returns one JSON field. |
| `src/server/clinical-core/owned-privacy-export.ts:62` (before) | Refuses any payload over 32,768 bytes. |

The in-app copy and the server-packaged job both read the same function. One saved analysis over about 24 KB therefore
withholds the owner's whole personal-storage copy: every record, not only the large one.

### What the owner actually sees

V2's write-up (`expo/docs/claude-v2-export-lineage-2026-10-17.md` §5) predicted `storage_unavailable` and up to 2,000
polls. **The source and an executed probe show something different.**

The path traced in source:
1. SQL raises `privacy_export_request_invalid`.
2. `rds-data-database.ts:523` classifies it as `ClinicalCoreDatabaseRejection('request_invalid')`.
3. `runPrivacy` (`owned-consumer-records.ts`), which is the `run` the production Lambda passes to the job module
   (`owned-consumer-api-lambda.ts:43`), maps that to `OwnedStorageError('request_invalid')`.
4. `advancePrivacyExportJob` rethrows it, and the API answers **HTTP 400 `request_invalid`**.

The probe ran on unchanged code (log `wp1b-failing-before-probe.log`). Three advancing polls each returned HTTP 400.
After each one the job was still `running` at 0/3, with no part or staging object written. Its deadline was 48 hours
after the snapshot.

In V2 (read-only, from source, not run on a device):
- `machineError` keeps `request_invalid`. That code is not in `drive()`'s transient list, so `drive()` stops at once; it
  does not poll 2,000 times.
- The card shows the generic "The personal-storage copy could not be prepared or shared. Nothing was marked as a
  completed account export. Please try again later."
- Every "Continue packaging" repeats the refusal. The job ends only at `deadline_passed`.
- The in-app copy gets the same 400 and the same generic text, not the `personal_export_invalid` sentence.

The effect is as stated in V2's write-up: the privacy-right copy is withheld. Only the mechanism differs.

## 2. Evidence

All logs are in `/tmp/claude-0/-home-user/66320678-ef33-50b0-bb92-9936dae56d06/scratchpad/agents/`.

### Failing before, passing after

The test file is `src/server/clinical-core/owned-privacy-export-oversize.database.test.ts`, with 17 tests:
- it uses the 106-migration chain in PGlite;
- its transport classifies errors with the production `classifyDatabaseRejection`;
- it returns JSON columns as the server's raw text, as the Data API does;
- the in-app copy goes through the real `createOwnedConsumerApi` handler, paged at limit 25 with V2's own refusals
  restated as assertions.

| Run | Source | Result | Log |
| --- | --- | --- | --- |
| Failing before | final test text, with `owned-privacy-export.ts` and `owned-privacy-export-job.ts` at `c327e9ae`, and the candidate SQL present | **12 failed, 5 passed** (exit 1) | `wp1b-failing-before.log` |
| Probe before | unchanged code: three advancing polls through the API | HTTP 400 ×3, job `running` 0/3 | `wp1b-failing-before-probe.log` |
| Earlier draft | an earlier test text (15 tests), same unchanged code | 10 failed, 5 passed | `wp1b-failing-before-draft.log` |
| After | this branch | **17/17 pass** | (in focused run) |
| Focused | the 26 test files that import the changed modules | **26 files, 408 tests pass**, exit 0 | `wp1b-focused-after.log` |

The 12 tests that failed before:
- **The release switch.** It is blocked, and no production wiring passes an override.
- **The job ends honestly in one pass.** Before: HTTP 400 `request_invalid`. After: HTTP 200 with `failed` /
  `record_exceeds_export_page`.
- **The job ends the same way** when it meets the record on a later page, so the probe runs with a non-null cursor.
- **Switch moved without the candidate.** Records pages fail closed (`storage_unavailable`), and consents are still read.
- **Pins.** Both file digests, the function body and both parent bodies.
- **In-app copy of the 250 KB analysis.** It comes back whole, byte-identical to the stored `payload::text`, with the
  digest each segment carried. At least one segment boundary falls inside a multi-byte character. A tombstone is kept.
  Each database row is under 32 KiB, and each response is under V2's 2 MiB.
- **Per-page byte budget.** Six analyses of about 250 KB: no page goes over 1 MiB unless it holds a single record, and
  no record is split across pages.
- **The job reaches `ready`** with the 250 KB analysis. The packaged records are string-identical to the in-app copy,
  and the download is issued.
- **Owner isolation.** Owner B's records never appear in owner A's in-app copy or packaged object. B presenting A's
  export id is refused at the SQL function and through the reader. A wrong purpose is refused.
- **Tampering fails closed.** Each of these makes the page fail as `storage_unavailable`, with nothing partial returned:
  changed bytes, a different digest on one segment, a skipped segment, a short segment, a record cut short, a
  non-progressing cursor, an extra field, a size above the store limit, and line-broken base64.
- **Partial or cancelled jobs share nothing.** A partial job (one part stored) and the same job once cancelled are both
  refused a download. `signDownload` is never called, and cleanup leaves the store empty.
- **Rollback.** A second application is refused. The rollback drops only the new function, keeps its audit rows and
  leaves the deployed reader's body unchanged, and the candidate then reapplies cleanly.

The 5 that passed before, all COVERAGE:
- the reproduction itself (a 250 KB analysis is refused for the whole copy, and a 20 KB one exports);
- the other refusals keep the job `running`: a transient fault, a lapsed snapshot, and a cursor the reader refuses;
- a job whose records all fit still completes, identical to the in-app copy;
- the segmented reader returns exactly what the deployed reader returns, for records the deployed reader can page (this
  passes trivially before, because the option is ignored);
- the rollback refuses a drifted body, and the candidate refuses a drifted parent (SQL only).

### Gates

| Gate | Result |
| --- | --- |
| Typecheck (`NODE_OPTIONS=--max-old-space-size=6144`, under the lock) | exit 0 (`wp1b-typecheck.log`) |
| ESLint on the 3 changed TypeScript files (under the lock) | exit 0 (`wp1b-eslint.log`) |
| `npm run test:migration-sql-bytes` | 3/3, exit 0 (`wp1b-sql-bytes.log`) |

The full unit suite and the Playwright battery were not run.

## 3. The BLOCKED SQL successor

The files are `infra/aws-clinical-core/source-candidates/owned-privacy-export-segments.sql`, with its rollback
`owned-privacy-export-segments-rollback.sql`. It is not a production migration, so no digest the V2 kit binds moves.

| Item | SHA-256 |
| --- | --- |
| `owned-privacy-export-segments.sql` (LF) | `06a99fd76881cd2ed194d12f0761fb5264124d4063797ce84afa89622bda8cfa` |
| `owned-privacy-export-segments-rollback.sql` (LF) | `bff3f1844e272f5a826cf490c992b3ddb11b183752d11749fef56ac27869aecc` |
| prosrc of `clinical_core.read_owned_privacy_export_segments(uuid,integer,jsonb)` | `e8dd247406a6469916e617af2651aa2c68412445d1c08a69e679c6e6657e432a` |
| Parent prosrc: `clinical_core.read_owned_privacy_export(uuid,text,integer,jsonb)` | `8b12c598486a6de88a98a8c8c877e3fd5163260e532a126974fae4bd6a9fa5a1` |
| Parent prosrc: `clinical_private.owned_consumer_actor()` | `d716d99f9ed0e710b4c34ee11af53613a090d63904487a20c2ff8ec24aa02fd9` |

The same values are in `owned-privacy-export.ts`: `PRIVACY_EXPORT_SEGMENTS_SHA256`, `..._ROLLBACK_SHA256` and
`..._PROSRC`. The pin test checks them against the files and against the schema.

**What it adds.** It adds one SECURITY DEFINER function, executable by `clinical_core_api` and not by PUBLIC. It reads
the records section of the caller's own snapshot under the deployed reader's rules: the same owner derivation, the
`consent_management` purpose, the snapshot cut-off and expiry, and the same keyset order.

**Segments.**
- Each record version is returned as segments of at most 15,360 octets of its stored `payload::text`, base64 without
  line breaks (20,480 characters). No segment needs escaping, and every segment fits the deployed 24,576-byte page, so
  **no size condition raises**.
- Every segment carries the version's identity, `deleted`, `consentRevision`, `receivedAt`, `payloadBytes`,
  `payloadSha256` and `segmentCount`.
- `_after` is either the deployed record cursor or that cursor plus `segment`. `next` names the last segment returned.
- Each call writes one `records.read` audit row (its count is the number of segments). It writes no record, consent or
  job state.

**Guards.** The file refuses to apply (`privacy_export_segments_parent_refused`) in any of these cases:
- the function already exists;
- either parent's body, SECURITY DEFINER flag, `search_path` or owner differs;
- the export or record tables are missing;
- the server encoding is not UTF8.

A post-check confirms the grants.

**Rollback (preserving).**
- It drops only that function, and only while its body is the reviewed one (`privacy_export_segments_rollback_refused`
  otherwise).
- It keeps every audit row the function wrote, and touches nothing else.
- Move the switch back to `blocked` **before** running it.

## 4. The reader change and the release switch

`src/server/clinical-core/owned-privacy-export.ts`:

```ts
export const PRIVACY_EXPORT_SEGMENTED_READ_RELEASE: "blocked" | "qualification" = "blocked";
```

**`blocked`, the default.** Records pages come from `read_owned_privacy_export` exactly as before. The page code behaves as
it did; only the cursor decode and encode and the 32,768 constant were factored out, with the same values. Production
wiring passes no override. A test walks `src/` and `scripts/` and finds the option named only in the two modules. The
job module's `segmentedRead` delivery option exists for tests.

**`qualification`.** Records pages are reassembled from the new function. For each record the reader:
- checks every segment's fields and strict base64;
- checks each segment's exact length;
- checks the segments are contiguous and from one version;
- checks the total length and SHA-256, then decodes strict UTF-8 and parses;
- accepts records only in ascending keyset order;
- requires the service's cursor to name exactly the last segment it used.

The page:
- holds at most `limit` whole records and `PRIVACY_EXPORT_PAGE_BYTES` (1 MiB) of item JSON, but always at least one
  record;
- has a cursor that is still the record cursor, `{exportId, section, after:{key, recordId, revision}}`;
- reads consents from the deployed function either way.

Any inconsistency fails the page as `storage_unavailable`; nothing partial is returned. The per-record bound is the
deployed tolerance (32,768) or the collection's store limit (262,144 for `lab_analyses`), whichever is larger.

**`personal-storage-export/1` is unchanged.** This was confirmed against V2's `personalPrivacyExport.ts` and
`personalPrivacyExportJob.ts`, read-only:
- the manifest is unchanged;
- the page keys are exactly `exportId, asOf, section, items, nextCursor`;
- records keep the same seven keys in the same order;
- `items` is at most 25;
- the cursor is base64url of 20 to 600 characters.

The only differences V2 can observe under `qualification`:
- a page may hold fewer than 25 records, which the deployed reader already did at 24 KiB;
- a response may reach about 1 MiB (the page budget; a single record is at most 256 KiB), under V2's
  `MAX_RESPONSE_BYTES` of 2 MiB.

The job document format, its cursor and `personal-storage-export-job/1` are unchanged.

## 5. The terminal-state fix (live, not behind the switch)

**The change.** In `advancePrivacyExportJob`, with the segmented read blocked, a records page refused as
`request_invalid` is checked with `deployedRecordExceedsPage`. When that confirms the cause, the job is failed with
**`record_exceeds_export_page`** (`PRIVACY_EXPORT_RECORD_TOO_LARGE`), and the pass returns the failed job view (HTTP 200).
Every other refusal is rethrown exactly as before.

**How the cause is told apart, with no new SQL.** For a cursor the module accepts (which the SQL also accepts), the
deployed function refuses a records page in only three cases:
- the snapshot is not the caller's;
- the snapshot has lapsed;
- the first row does not fit the page.

Two probes separate the third case from the other two:
- a limit-1 records page at the same cursor is refused again in all three cases;
- a consents page of the same snapshot, whose rows are bounded far below the page, reads only in the third.

Anything else answers "not this cause": a cursor the module refuses, a transient error, or a records page that reads.
Tests pin a transient fault, a lapsed snapshot and a corrupted cursor, and each still leaves the job `running` as before.

**Why it may be live.**
- It changes no personal data: no record version, consent, snapshot or object is written or removed.
- It writes:
  - the job's own terminal transition (`failed`, `failure_code`, `finished_at`, the lease released by the
    leaseholder), which `deadline_passed` would have written anyway after 48 hours with a less truthful code;
  - a `job.failed` audit row;
  - one `consents.read` audit row from the probe.
- The condition is permanent for the snapshot: the page bound is a constant, and the snapshot's rows are fixed.
- Nothing becomes downloadable, and the failed job enters normal cleanup (a test shows nothing was stored).

**Code choice.** The existing failure codes are `deadline_passed`, `export_too_large` (the whole document over 2 GiB),
and `object_missing`, `object_mismatch` and `object_ambiguous`. None of them describes this case:
`export_too_large` would falsely say the copy is too large. The new code is 26 characters, inside V2's
`failureCode: string ≤ 80`.

### Wording for Brandon and counsel to review

Desktop adds no user-facing text. V2 renders every `failed` job as "Packaging failed." followed by its cleanup sentence,
and does not show `failureCode`. That is truthful, but not specific.

**Proposed V2 sentence**, not implemented (V2 is outside this package), for `failureCode === 'record_exceeds_export_page'`:

> Packaging stopped because one saved record is larger than this release can include in a prepared copy. Nothing was
> shared and no record was changed. Trying again will stop at the same record.

**Optional, not done.** The in-app copy still answers HTTP 400 `request_invalid`, and V2 shows its generic "Please try
again later." An interim honest message would need a distinct Desktop error code on the page route, using the same
probe, plus a V2 sentence such as:

> One saved record is larger than this release can include in the in-app copy. Nothing was shared and no record was
> changed.

This is Brandon's call. Releasing the segmented read removes the condition instead.

## 6. Hosted holds

These are not observable locally:
- **The Data API's 64 KiB per-row limit.** Locally, the largest result row's text measured under 32 KiB (a segment row
  is about 21 KB). The Data API's own encoding of the `result` field is not observed.
- **The PostgreSQL version.** Aurora's PostgreSQL version and its `jsonb::text` output come from the server itself. The
  digest and the segments come from the same server, so they agree, but the version is not observed.
- **Latency.** A 1 MiB page of four 256 KiB records takes about 70 Data API calls in one transaction. The consumer
  Lambda's timeout is 15 s and the job's pass budget is 8 s (`PRIVACY_EXPORT_PASS_BUDGET_MS`), and a page read is not
  interrupted mid-page. This needs hosted timing.
- **`server_encoding = 'UTF8'`** on the target. The guard refuses otherwise.
- **The V2 device rendering** of the failed job, and the V2 drive loop against the deployed API.

## 7. Ordered Codex steps: qualification on a fictional Aurora

1. **Pin the source.** Pin the Desktop head of this branch. Confirm that both SQL digests and the three prosrc values
   match §3 and the constants, and that no `production-migrations/` digest moved (`git diff c327e9ae -- infra/aws-clinical-core/production-migrations` is empty).
2. **Prepare the database.** Use the PHI-disabled qualification target with the 106-migration chain, all fictional.
   Read its migration ledger, then confirm the two parents' prosrc and `server_encoding` with read-only queries.
3. **Reproduce D1 on the Data API.** With the build still `blocked`, seed fictional owner A with:
   - a lab analysis of about 250 KB (mixed-width UTF-8, under 262,144 octets);
   - two small records;
   - a tombstone.

   Seed owner B with a marked large analysis. Expect:
   - the in-app copy: HTTP 400 `request_invalid`;
   - the job: `failed` / `record_exceeds_export_page` in one pass, HTTP 200.
4. **Apply the candidate.** Apply `owned-privacy-export-segments.sql` through the reviewed operator path. Record the
   applied file digest and the function's prosrc (`e8dd2474…`). A second application must refuse.
5. **Run a qualification build.** Deploy a build with `PRIVACY_EXPORT_SEGMENTED_READ_RELEASE = "qualification"` to the
   qualification target only. Then:
   - Run the in-app copy for A from V2 or the API. Record every Data API row size, the response size per page
     (under 2 MiB) and the time per page.
   - Verify the analysis's SHA-256 against `encode(sha256(convert_to(payload::text,'UTF8')),'hex')` read in SQL.
6. **Run the job.** Drive A's job from V2 to `ready`, download it, and compare its records with the in-app copy. Record
   the pass times against the 8 s budget and the 15 s Lambda timeout.
7. **Check owner isolation.** Confirm B's marker is absent from both of A's copies, and that B presenting A's export id
   is refused.
8. **Rehearse the rollback.** Redeploy the `blocked` build first, then run the rollback. Confirm the function is gone,
   its `records.read` audit rows remain and the deployed reader's prosrc is unchanged. Reapply, then roll back again.
9. **Hand back.** Return the digests, counts, row sizes and timings. Moving the switch for production is a separate,
   reviewed decision. The V2 sentence in §5 goes to Brandon and counsel.
