# Retained voice cleanup watches

September 16 source increment: original commercial phases 2/3/6, still partial.
No cloud deployment, real recording, PHI activation or paid mobile build.

## Defect and repaired lifecycle

Previously the first successful provider/object removal marked a voice job cleaned,
removed it from PendingWork and assigned a one-day metadata TTL. Upload or provider
work can outlive a worker lease. A late write after removal then had no scheduled
cleanup owner.

Cleaned rows now remain unreadable and scheduled. Their first-hour watch runs
every five minutes; older watches run daily. The same scoped removal is attempted
again, only after the transcription provider is terminal or absent. No transcript
is read and no transcription/upload is restarted. A failure retains pending work
and leaves the previous verification time unchanged. Old cleaned state does not
authorize a new consumer request with the same request ID.

The DynamoDB release condition still requires the lease token. Successful removal
records cleanupWatchVersion and lastCleanupAt, keeps pending=work and removes any
expiresAt rather than creating a TTL. This retains sensitive operational metadata;
it is not full account erasure or an approved retention decision. Do not remove a
watch while old writers, provider callbacks or restored backups can revive files.

The read-only drain inventory projects lifecycle fields only. It distinguishes
current absence of artifacts from shutdown eligibility. Any retained job metadata
keeps candidateClear false; active watches are explicitly identified. It never
certifies deletion. Legacy cleaned rows without a watch are reported as unwatched,
not silently considered safe for shutdown.

## Acceptance and remaining work

Lifecycle tests reproduce lease loss during upload, late objects/provider work,
failed repeated cleanup and first-hour/daily scheduling. Mock AWS transport tests
check actual lease/index/TTL command construction. Production removal continues
to use version-aware exact-key erasure; the synthetic provider's existing removal
contract and permissions were not expanded.

Live late-write testing, deployed artifact/index verification, retention/legal-hold
policy, alarm routing and load/capacity testing remain required. Previously cleaned
rows whose pending flag was already removed are not automatically discovered by the
due index. Review an inventory and an authorized backfill before describing fleet
coverage as complete; already TTL-deleted metadata may require object/provider
inventory reconciliation. Neither backfill nor any real deletion ran here.

Account-wide erasure, voice-specific hold-aware retention, archive/PITR reconciliation
and approved watch retirement remain open. Production activation is still blocked
by the existing evidence/consent gates. Do not roll back to the one-pass TTL behavior
without a replacement reconciliation mechanism.

## Reviewed synthetic legacy backfill operator

The synthetic backfill source is now available through `build:aws-chat-transcription`,
which produces `dist/aws-clinical-core/voice-watch-backfill/backfill.cjs` separately
from the Lambda deployment directories.
Building this artifact does not run it. It is not imported by an API or granted to
the runtime role. There is no production mode. Scope is fixed to account
588966314750, us-east-2, stack
ai-clinical-core-synthetic-staging-chat-transcription and profile ai-synthetic-staging.

After a separately reviewed deployment of the retained-watch worker, calculate the
base64 SHA-256 of that exact reviewed Lambda zip (not an arbitrary currently deployed
zip). The operator compares it to Lambda CodeSha256, plus the function revision,
stable stack identity, mapped resources, synthetic/PHI-disabled environment, and
enabled one-minute cleanup schedule. These checks are repeated after planning and
before each write. They do not make the cloud snapshot atomic; freeze deployment
changes during the operation and independently inspect afterward.

1. Run `node dist/aws-clinical-core/voice-watch-backfill/backfill.cjs --plan PRIVATE_PLAN_PATH REVIEWED_ZIP_SHA256_BASE64`.
   This stage makes no AWS writes. It refuses partial/malformed/duplicate scan output.
   The projected metadata plan contains job IDs, format and lifecycle fields, not
   owners, consent payloads, recordings or transcripts. Store it in a restricted
   local directory outside git/OneDrive. File mode is 0600 on supporting systems;
   on Windows verify the containing directory ACL. The output file must not exist.
2. Review the plan and SHA-256. Eligible rows are only already-cleaned records with
   no pending flag, no active/leftover lease fields and no existing watch evidence.
   Malformed rows stop the plan; other states are counted as skipped, not certified.
3. Explicitly run `node dist/aws-clinical-core/voice-watch-backfill/backfill.cjs --apply PRIVATE_PLAN_PATH APPROVED_PLAN_SHA256`.
   Plans expire after one hour. Every projected field is compared in the DynamoDB
   update condition, including absent fields. Missing/TTL-deleted/changed rows are
   not recreated or overwritten. Existing rows receive pending=work and nextWork=now;
   expiresAt is removed. State stays cleaned/unreadable. No cleanup timestamp or
   watch-verification marker is invented. Only an actual later worker cleanup writes
   those fields. A replay conflicts safely rather than repeating the transition.
4. Check schedule/worker success, inspect retained watches and reconcile object and
   provider inventories, including orphans whose metadata was previously TTL-deleted.
   A scheduled count is not a deletion count. Uncertain writes or mid-run drift can
   leave partial progress: re-inventory and create a new reviewed plan, never claim
   rollback or cleanup completion from the operator output.

No AWS backfill was run in this source increment. Production backfill, orphan recovery,
retention/holds, fleet capacity and hosted failure-injection acceptance remain open.
