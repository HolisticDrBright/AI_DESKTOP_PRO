# Lesson media settlement repair

The four independent reproductions against Desktop `e3f39a6` are repaired in source on
`agent/program-media-settlement-20261011`. The runtime remains disabled and the dedicated
native store, full restricted ledger and workforce routes are still prerequisites. This is
not hosted qualification or production approval.

## Repaired behavior

| Finding | Repair and evidence |
| --- | --- |
| A substituted publication still read current | Reference reads require the entire recorded publication and current artifact snapshot. URL, clinic/program, kind/type/bytes, timestamp and supplied-text provenance must match. Historical recorded references remain immutable after metadata changes or retirement. |
| Delete acknowledgement was treated as absence | Cleanup requires a complete exact-key version inventory after version deletion. The wire receipt requires one bound absence proof per successful action; denial, no-op removal or incomplete inventory remains pending. |
| Reconciliation could commit an object while cleanup deleted it | Writers are durably admitted before I/O. Cleanup can permanently seal the artifact only without open or uncertain writers. Commit checks its admission in its mutation transaction. The database and authoring tests exercise both admission orders. No SQL lock spans storage calls. |
| An expired retry hid an existing orphan | Expiry stops new upload admission, but abandoned reservations remain in discovery until a cleanup proof exists. An admitted recovery can finish after expiry. Expiry cannot abandon another active or uncertain writer. |

The four original reproduction assertions are unchanged. The older positive cleanup case
treated a lost upload reply as settled and required deleting it, contradicting its own
uncertain-write rule. That case now requires `kept_pending` with the bytes preserved and
also includes a separate known-settled orphan whose deletion must succeed with absence proof.
No deadline, retry or skip was added to make the tests pass.

## Durable database component

`infra/aws-clinical-core/source-candidates/program-media-settlement.sql` is a distinct BLOCKED
source successor to the preserved `program-media-ledger.sql` identity
`6dae2f237c13540b13cc3b7ecde877be104c35e59c7fddd9206130a62356a34d`. Neither candidate is
registered or applied. The new candidate is tested after the exact parent and full synthetic
manifest in embedded PostgreSQL. It creates private work admissions and cleanup seals, fences
commit and expiry mutations, stores complete immutable publication snapshots and checksum-bound
absence proofs, and grants the API role nothing. Activation is still false with no bucket or
delivery origin.

The repaired successor's exact SQL SHA-256 is
`74f54bbb72539218dc6d12098a1773da572f4eb9230faae10010f69d5c95ff04`.
This is a source identity, not a registered migration, reviewed upgrade or activation receipt.

`program-media-settlement.ts` is the SQL-backed settlement component over the existing
transaction interface. It is not a complete ledger adapter or authentication factory. Never
use an administrative credential to make it run live. A reviewed workforce function family
must bind identity, program authority, exact function/release hashes and the same artifact
ledger before exposing it.

Open and uncertain writers have no automatic expiry. A timeout or abort does not prove that
remote mutation stopped. Only an adapter proving rejection before mutation may classify a
write as settled. Unknown exceptions retain uncertain admission, including a lost response
followed by successful object recovery. A ready object is preserved; unresolved work requires
an independently reviewed recovery protocol. There is no deletion guarantee or SLA here.

## Verification

The initial repair ran 40 of 41 cases successfully; the remaining case was the old uncertain
upload cleanup expectation described above. The first database run passed 69 of 71 cases;
two positive commits hit the parent's unique committed-byte constraint because unrelated
test reservations reused identical fictional bytes. The fixtures now have distinct digests;
the constraint is unchanged. The subsequent focused run passed 72 cases across four files:
45 authoring, 5 wire-contract, 8 preserved-parent and 14 settlement database cases. Typecheck
and lint passed on the preceding source.

The normal whole Desktop suite subsequently completed with exit 0: 464 files,
7,413 tests passed, 11 unchanged skips, 842.17 seconds. The original full-suite
process was observed through termination, not restarted after a truncated tool
response. Evidence: `handoffs/evidence/desktop-media-settlement-full-20261011.log`
in the root Codex workspace. No test, worker limit, assertion or deadline was
changed for this run. Production-build and exact-head CI status are recorded
separately rather than inferred from the suite.

Final typecheck and lint also passed. The operation-inventory,
compatibility-contract and mock-import gates passed on this repair source.
Their success proves the existing branch's declared boundaries, not
provider-specific production implementation or any real media-store observation.

Clinical production compilation, type validation and generation of 250 pages
completed with exit 0. The strict client-bundle scan passed across 309 chunks.
Next reported an `EPERM` while copying the dependency-junction symlink into
the Windows standalone directory. This local output is therefore not a
qualified deployable package; a clean exact-source release build must verify
packaging independently. No packaged artifact was uploaded or deployed.

AST-only Graphify refresh completed without a model call: 18,000 nodes,
41,348 edges and 1,091 communities. It reported 88 inputs with zero extracted
nodes and skipped the oversized HTML view. This is navigation support, not
complete semantic or security coverage; the shared vault update is recorded
in the root handoff.

The fictional in-memory ledger demonstrates the source contract, not native persistence.
The embedded database tests execute actual candidate functions and guards, but not a real
Aurora lock wait, S3 listing, KMS permission, API route, public delivery or device.

## Remaining implementation and qualification

1. Bind a complete restricted workforce ledger family to independent identity and current
   program rights; compose every mutation with the settlement component. Do not expose the
   private functions or treat an HTTP boolean as admission.
2. The successor documented in `program-media-native-store-2026-10-11.md` adds the
   actual AWS SDK storage source and bounded exact-key version inventory, locally
   tested over fictional network replies. Integrate it only through the complete
   independently admitted native factory. Qualify real late/lost calls and storage
   settlement rather than assuming an AWS timeout is final.
3. Review the separate preserving schema identity, educational-media resources and read-only
   delivery origin. Do not reuse clinical recording storage or register this candidate under
   prior schema authority.
4. Finish workforce routes, upload-size/multipart admission and the mirrored consumer media
   reference successor. The existing consumer URL slot is unchanged.
5. Execute the real-store matrix: both race orders, multiple writers, late writes, lost
   admission/commit/cleanup receipts, no-op and denied deletes, complete version absence,
   unknown writers, cross-clinic and consumer refusals, full publication substitution,
   supplied captions/transcripts, retirement and repeated cleanup.
6. Record the exact matched release, hosted/device results and the separate retention,
   caching, accessibility and activation decisions. Source success cannot approve them.

No AWS write, migration application, secret retrieval, provider activation, paid build,
TestFlight upload, main merge, PR, force-push, production launch or PHI enablement occurred.
