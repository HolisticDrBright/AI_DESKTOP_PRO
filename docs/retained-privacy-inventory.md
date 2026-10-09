# Request-bound retained lab and voice inventory

September 17, 2026. Source candidate only; default disabled. No deployment,
PHI activation, deletion, new assignment or retention approval was performed.

## Operator workflow and authority

Settings → Privacy operations → assigned deletion request → Read-only retained-job
inventory → start labs/voice → explicitly scan the next page or resume saved work.
The existing same-origin Desktop proxy forwards a strict command to the separate
workforce API. The request ID resolves the owner and current production-bound
consumer identity inside AWS PostgreSQL; clients cannot choose an owner, source
table, identity subject, cursor or returned metadata. An active reviewed privacy
assignment and fresh workforce login are required. Legal holds allow this read
but still prohibit destructive fulfillment. Disabled consumer identities remain
discoverable; changed identity bindings conflict rather than silently switch.

Migration 63 adds private, forced-RLS inventory and item tables, with no direct
API table access. Each page's items, checkpoint, evidence hash and audit event
commit atomically. Revision-bound retries return the already committed page;
stale revisions, changed source/request/store/identity, repeated cursors,
duplicate jobs and invalid metadata refuse. Failed audit insertion rolls back
the checkpoint and its items. The latest 20 saved summaries are visible only
through the existing assigned-request authority. Summaries contain counts and
hashes, not source ARNs, job IDs, cursors, tokens or health content.

The UI preserves uncertain commands for exact retry and clears private state
when hidden or unmounted. Each page requires an explicit action; no background
scan loop or clinical data persistence is added to the browser. Safe activation
and legal-hold error codes survive the proxy; arbitrary provider text does not.

## Coverage, bounds and unresolved work

The reader uses a deployment-pinned DynamoDB Scan, limited to 25 evaluated rows
per request, a four-second SDK deadline and an explicit metadata projection.
It includes old/unindexed retained lab jobs, cleanup outboxes and bound voice
jobs without TTL/recent-history filters. Unexpected foreign-owner rows refuse;
unresolved metadata on otherwise owner-matching rows increases the issue count.
Voice authorization metadata is validated server-side and is not persisted in
the inventory item or returned to the browser. IAM grants only exact-table Scan
with projection conditions and table-scoped KMS decryption, never mutation.

Inventories stop at 100,000 evaluated rows, 10,000 items or 10,000 pages (a final
25-row page may cross an item threshold). Bounded scans retain their evidence
and report incomplete coverage. Even an exhausted scan always reports
completeAccountInventory=false and requiresReconciliation=true: DynamoDB's
consistent reads are not a point-in-time snapshot. The hash chains the scanned
pages; it is not a verified whole-account deletion manifest.

Still outside coverage: source S3 objects/versions, provider artifacts, orphaned
objects or rows without attributable ownership, historical identity aliases,
other account stores, backups and devices. The new inventory/checkpoint rows
themselves are retained metadata and require an approved retention/disposition
policy before activation. No expiry or retention policy is invented here.
Reviewed cross-store commands, independent reconciliation, durable outcomes and
whole-account fulfillment remain engineering requirements. The old unwired
owned-privacy-fulfillment helper must not be activated as a shortcut.

## Deployment and qualification

ExternalInventoryEnabled defaults false. Activation requires separate
ExternalInventoryEvidenceSha256 plus the existing reviewed workforce/API
activation, exact lab/voice table ARNs and their KMS keys. Generated IAM is
conditional. Neither the template nor migration seeds any authority or approval.
Physical AWS qualification must verify nested-attribute Scan IAM, actual owner
bindings, transaction/runtime deadlines, concurrency, recovery and scan costs.

Verification this increment:

- SQL gate passes all 63 migrations with zero seeded rows. All migrations execute
  in isolated PGlite tests using fictional records. 44 privacy SQL/API cases and
  three contract cases pass, including assignment/source/identity isolation,
  page bounds, retries, saved-detail resume, audit rollback and holds.
- SDK tests exercise the real Scan-command adapter with mocked transport; this
  is not a live DynamoDB scan. Infrastructure tests enforce separate activation,
  exact metadata-only permissions and absence of destructive IAM.
- Six Playwright browser tests pass using fictional intercepted HTTP responses.
  The retained-inventory screenshot was inspected. UI and API/SQL are separate
  evidence layers, not a single hosted end-to-end acceptance run. The preferred
  browser helper is unavailable locally, so repository Playwright was used.
- Typecheck, changed-file lint, candidate Lambda build and CloudFormation lint
  pass. Full local suite: 2,011 passed / 11 existing skips across 180 files.
  A subsequent safe-error forwarding regression and its related API/route tests
  pass (26 tests); final source CI must cover that last change too. The first
  full-suite invocation omitted required TZ=America/Los_Angeles, causing the
  timezone assertion to fail; rerunning with the configured timezone passed.
- Pre-increment exact-source Desktop CI35250140022 at87d5e5f and V2 CI35250149579
  atab7bae8 both succeeded. Earlier Desktop CI35248491371 failed at scribe Start
  Recording: its trace shows a pending POST with no response at the 10-second
  assertion, not a proved authorization/UI-state cause. That intermittent stall
  remains a reliability investigation; a later green run is not a root-cause fix.

All six original commercial-readiness phases remain incomplete. This increment
advances privacy fulfillment preparation, not complete deletion or release.
