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
