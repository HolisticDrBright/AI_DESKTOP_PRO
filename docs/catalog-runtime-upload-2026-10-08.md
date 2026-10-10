# Synthetic catalog runtime artifact upload

The upload stores a new immutable code artifact in the existing synthetic account. It does not change the running API, replay migrations, activate features, certify recovery or permit PHI. Deployment, same-target catalog acceptance and owner-adopted plan continuity remain separate work.

## Upload admission

Run from a clean Desktop source checkout paired with the clean V2 checkout. The public command independently rebuilds the current artifact and the frozen deployed predecessor, observes the actual canonical database and complete AWS control inventory twice, and distinguishes the latest API from retained recovery version 2. It refuses endpoint overrides, supplied reports, target overrides and activation flags.

Custody uses the preserved sibling checkout `DESKTOP_COMMERCIAL_20261005` and its existing `dist/synthetic-care-routing/operator.lock`. A separate lock namespace cannot admit this operation. The source snapshot of that preserved checkout must still match its fixed identity. Every storage boundary verifies the shared lock, clean paired source and STS principal. A complete control observation is repeated before admission, after the journal admission has finished, and after exact-version readback. Admission expires after 120 seconds; journal I/O cannot extend it.

S3 writes are create-only with `IfNoneMatch: *`, one transport attempt, the fixed owner, encryption key, checksum and source metadata. Only an exact precondition-failed response may reuse an existing matching artifact. A timeout or lost response is an unknown write, not permission to retry. Completion requires bounded reads of the exact encrypted version and byte-for-byte agreement with the local rebuilt ZIP.

```powershell
node scripts/catalog-runtime-upload.mjs --v2-root <current-v2-checkout> --artifact <current-artifact-directory> --custody-root <preserved-desktop-checkout> --deployed-desktop-root <frozen-9597fcb-checkout> --deployed-v2-root <frozen-38ea48c-checkout> --upload-fictional-catalog-runtime-code-only
```

An admitted unsuccessful write retains the original shared lock and append-only journal. Operation records are separate from immutable candidate files under `dist/synthetic-catalog-runtime-operations/<desktop-commit>/<v2-commit>/<zip-sha256>` in the preserved checkout.

## Interrupted upload recovery

The reconciliation command has no remote write or deletion port. It requires the original writer process to be demonstrably stopped, the exact original lock and journal, and at least 60 seconds after the last recorded event. A crash after admission may have no final error entry; only the exact admitted journal prefix is accepted in that case. An active or unobservable process, unrelated source, duplicate or reordered journal stage, changed custody, incomplete listing or unstable readback refuses settlement.

Reconciliation repeats the complete live predecessor control and S3 observations. A stored artifact needs one unambiguous version, matching metadata, checksum, encryption and actual bounded bytes. Absence needs a complete listing and an exact not-found response, never an access denial. Both outcomes leave the original PUT outcome unknown and certify no deletion. Only after immutable local archive and receipt readback may reconciliation retire the exact original local lock. It preserves the original journal and every remote object.

```powershell
node scripts/catalog-runtime-upload-reconciliation.mjs --v2-root <current-v2-checkout> --artifact <original-artifact-directory> --custody-root <preserved-desktop-checkout> --deployed-desktop-root <frozen-9597fcb-checkout> --deployed-v2-root <frozen-38ea48c-checkout> --reconcile-fictional-catalog-runtime-upload-only
```

## Verification scope

The new credential-free suite covers upload admission, expiration during bucket reads and journal admission, source/principal/control/custody drift, one-write unknown outcomes, exact collision reuse, metadata and byte mismatch, captured asynchronous witnesses, abrupt writer termination, journal integrity, repeated reconciliation observations, shared-lock exclusivity, local archival and junction refusal. The combined new and unchanged registered-release regression run passed 71 tests without skips. The broader care and catalog Node run passed 462 tests without skips in 65.377 seconds. Type checking and focused lint passed. These are local source results; they do not prove a live upload, deployment, recovery rehearsal or commercial readiness.

The actual read-only predecessor result at source `14867ea` remains recorded separately in `catalog-runtime-release-2026-10-08.md`. Its candidate has not been uploaded. This increment requires a new clean-source candidate rather than renaming that historical artifact.

Hosted CI completed successfully for parent source `14867eaad3938a398a1ae25d94593714f3961128` in runs `37885067052` and `37885070572`, and documentation head `4f87e539b2becdc19228330abda7fa7d3669cae6` in runs `37885488182` and `37885493014`. Those results do not qualify this later upload increment or replace hosted feature acceptance.

## Actual AWS upload

At clean source `65e248f6ecd84a442b1511c52087cd708d7f792b`, paired with unchanged V2 `e92116b154dd1a206262926388cffe90ac5c06ce`, the actual operator completed successfully at `2026-10-09T05:14:02.819Z`. Its own fresh preflight completed at `05:12:06.931Z`. Admission, source/principal/custody checks, repeated complete control verification and encrypted exact-version byte readback all passed within the unchanged freshness limit.

Run `25219310e8aa2126b58cb42a99591ff5` uploaded ZIP SHA-256 `ef9f9d38b755e0aa62da13a848181cc586988ba5bed4c328ab7948114abc27e3`, 1,874,730 bytes, to S3 version `d8uA5e4HL6vnpWXr9UiWYITVp2VeiU42`. The preserved original receipt and committed `docs/evidence/2026-10-08-catalog-runtime-upload.json` have identical SHA-256 `c59155bd377fdaeb53972c0f3f02c09a041351c3cd30c32913ce28b51b6ae08c`. The original journal remains in the preserved checkout's operation directory. Custody settled and a separate filesystem check found no shared lock files.

The latest identity API remains the prior `9597fcb` artifact. No change set was created, no API was deployed, no schema changed and no recovery, feature, erasure or physical-device acceptance occurred. PHI and paid mobile builds remain off. Later documentation commits do not rename this tested and uploaded source; `DESKTOP_CATALOG_RUNTIME_FROZEN_65e248f` preserves it for independent reconstruction.

An independent build from that clean frozen checkout reproduced the same ZIP digest and byte count after the upload. Full lint finished with zero errors and zero warnings. Hosted CI runs `37887166901` and `37887163408` at `65e248f` remain in progress at the last observation; no terminal success is claimed.

## Remaining engineering

After a successful live artifact upload, implement and verify the distinct catalog-runtime code-only proposal, execution, reconciliation and recovery path. Do not use the older fixed predecessor profile or alter observations to make it accept the new predecessor. Then qualify the deployed identity and catalog runtimes, implement authoritative owner-adopted plan inventory, and prove complete ingredients come from the same actual target. Program supplement steps remain held until that inventory is available.

All six original phases remain open, including positive processing, nine erasure journeys, export/retention/voice recovery, provider and commerce acceptance, exact matched releases, physical devices and reviewed activation evidence. Clinical holds, exclusions and source-verification requirements are unchanged. PHI remains off and paid mobile builds remain held.
