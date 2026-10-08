# Retained Lambda permission lineage repair

The synthetic routing rehearsal refused its final retained-version comparison after removing its own temporary permission. The retained ZIP and all raw configuration fields matched except `RevisionId` and `LastModified`. CloudTrail recorded the operator's exact `RemovePermission20150331v2` request at the new modification timestamp. This supports attributing that metadata change to the permission operation; it does not justify ignoring metadata on unrelated reads.

## Preserved failure and restoration

Standalone run `850858accfa7e666d044792be1270490` verified 105 consumer observations, then failed with `routing_retained_changed`. Its result remains failed. The separate stopped-test restoration completed with exit 0, archived its lock, and retained the original failure. Fresh service reads found the API integration pointing to the unqualified current function and no version 2 resource policy. This is restoration evidence, not a successful rehearsal or acceptance of erasure.

## Repair and scope

The operator compares the entire retained snapshot before permission admission and again before cleanup. Only an admitted add or removal may change the revision and modification timestamp together, within that operation's measured time window. Code bytes, ZIP digest, runtime, environment, unknown configuration fields, and the exact permission policy remain fully compared. Unrelated drift is refused. Cleanup removes only the known statement under its observed policy revision; it does not overwrite function configuration to make a comparison pass.

A successful rehearsal carries the full before and after snapshots for both permission operations. The standalone verifier revalidates their policy, byte identity, ordering, timestamps, and chain, binds the statement to its own run, and compares their endpoints to its independent before and repeated final observations. The journal's existing durable admission grammar is unchanged. Lost replies remain failures or unsettled custody, never inferred successful runs.

## Verification

- Before the repair, 11 of the 22 focused tests failed: the realistic permission metadata change was refused, and unrelated drift was detected only after routing had already switched. All nine existing focused tests passed.
- After the repair, 26 routing tests pass, including add-only and remove-only metadata changes, unchanged metadata, malformed or out-of-window timestamps, code/runtime/environment drift, pre-admission and post-cleanup drift, and lost replies.
- The routing, preflight, deployment, standalone, restoration, live-runner and custody suites pass 116 tests. These use fictional transports; they are not hosted qualification.
- All 188 registered-release tests pass, including real local source rebuilds, custody reconciliation, and the original strict journal grammar.
- Typecheck and focused lint pass.

## Required next work

Run a newly admitted rehearsal with a clean operator checkout and the immutable deployed application and mobile source identities. Retain the earlier failed journals and receipts unchanged. A new successful 105-case run would qualify routing recovery only: the positive erasure journeys, same-target program catalog, matched releases, provider/store acceptance, and physical iOS and Android acceptance remain separate requirements. PHI stays disabled and no paid mobile build is authorized by this repair.
