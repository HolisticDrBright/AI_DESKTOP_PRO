# Claude lesson media source recheck

For Brandon Bright to give to Claude Code. The returned Desktop head `e3f39a6801cb96b174e107ee292bd990e83da68b` is remote-matched and exact CI 38171826402 succeeded. Green CI does not cover the new negative reproductions below. The source is still disabled, so these are pre-activation engineering defects, not reports of hosted data loss.

## Reproduced findings

1. **Publication reference substitution.** `describeReference` checks only ready state, version, digest and non-null object version. After an actual publication, substituting the delivery URL and origin program still returns `current: true`. Bind the entire recorded publication, including clinic/program, URL/origin, kind/type/bytes, supplied text provenance, version, digest and publication identity. Never accept a caller's plausible reference as a recorded publication. Preserve truthful historical references after metadata revisions or retirement.
2. **Deletion without absence proof.** A fictional store acknowledging a no-op `remove` produces `abandoned_object_removed` while the exact object version remains. A successful delete call is not absence proof. Verify the exact version and any applicable listing after removal; denied, uncertain or still-present outcomes remain pending or held, never certified. Distinguish absence from errors and delete markers. Record actual proof in the receipt.
3. **Cleanup/reconciliation race.** Cleanup reads the artifact before it reads the object. Reconciliation can commit the object between those reads. Cleanup then deletes the ready object's version; the later ledger settlement rejects the state change, but cannot recover the deleted bytes. Rechecking once is insufficient. Design durable writer/cleanup admission and settlement so reconciliation, upload admission, late writes, commit, publication and cleanup participate in the same fence. Do not hold SQL locks across provider calls. Uncertain or active writers must prevent a deletion receipt. Prove both race orders and lost/late replies.

4. **Expired retries hide written orphans.** An object written before expiry followed by an expired `admit` retry immediately marks the reservation abandoned without inspecting the object. The cleanup listing excludes abandoned reservations, so that object's reservation disappears from recovery. Keep unresolved storage discoverable until absence or recovery is proven; an expired acceptance window must stop new writes, not hide existing bytes.

## Local reproduction and evidence

The isolated audit checkout is:

`C:\Users\Brand\Documents\Codex\2026-08-18\referenced-chatgpt-conversation-this-is-an\work\DESKTOP_PROGRAM_MEDIA_AUDIT_20261011`

Its branch is `agent/program-media-audit-20261011`, based exactly on `e3f39a6`. Only `src/server/programs/program-media-authoring.test.ts` has an uncommitted diagnostic addition. Original branches and Codex's backend checkout are untouched. Do not reset or merge the audit tree blindly.

Run from that checkout:

```
npx vitest run src/server/programs/program-media-authoring.test.ts -t "Codex independent negative audit"
```

The first diagnostic produced three failures, with 33 cases excluded by its name filter. The subsequent complete authoring-file run had all 33 original tests passing and the three new tests failing. After adding the expiry-recovery reproduction, the final complete authoring-file run passed all 33 original tests and failed all four new tests (37 total). These are not a whole-repository suite. The cases use the actual authoring service and supplied fictional store/ledger; no AWS, provider or secret call occurs.

Evidence log:

`C:\Users\Brand\Documents\Codex\2026-08-18\referenced-chatgpt-conversation-this-is-an\handoffs\evidence\claude-program-media-negative-audit-e3f39a6-20261011.log`

Final unfiltered four-case log:

`C:\Users\Brand\Documents\Codex\2026-08-18\referenced-chatgpt-conversation-this-is-an\handoffs\evidence\claude-program-media-four-case-audit-e3f39a6-20261011.log`

## Repair boundaries and return

Start a separate source branch from the returned head. Preserve the existing blocked candidate identity and manifest hashes. If a ledger change is needed, create a distinct reviewed successor; do not rewrite a prior identity or register/apply it. Keep runtime disabled, educational-only, no patient input, and no reuse of clinical recording storage.

Return the repaired implementation, unweakened reproductions, both-order race/failure tests, required native ledger/store contracts, normal full suite and terminal exact CI. Do not mark the cleanup issue fixed only by making the fictional store always delete, adding a non-durable local mutex, changing the tests to accept deletion, or assuming a HEAD recheck is atomic.

Codex still owns native resources, preserving schema integration and AWS qualification. Native S3/ledger adapters, workforce routes, a dedicated reviewed delivery origin and the mirrored consumer reference successor do not yet exist. These are source/runtime prerequisites, not only human paperwork. Hosted, device and production evidence remain separate. No main merge, force-push, PR, AWS write, activation, paid build or PHI enablement is authorized by this handoff.
