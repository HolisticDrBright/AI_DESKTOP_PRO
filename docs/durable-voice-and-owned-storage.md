# Durable voice and independent consumer storage — September 8, 2026

Status: **partial commercial engineering, not commercial activation**. Core remains
$19.99/month; peptide and longevity add-ons remain outside initial launch. PHI is
disabled. No paid mobile build was started. No clinical approval was created.

Follow-up: [Personal consumer API and V2 integration](personal-consumer-api-readiness.md)
supersedes the next-step list below: source now includes separate HTTP routes,
V2 personal storage/consent and partial AI context. Its 35-check rollback pass
does not imply those routes or the 48-migration candidate have been deployed.

## Durable voice: implemented and hosted in synthetic AWS

Desktop runtime source `56cad47e6e2ccd66f5d47b89a65671c1db9a4cc3` adds a durable
owner-bound job ledger, start/status/cancel routes and a scheduled reconciliation
worker. V2 source `5636b70` creates a job once, polls short requests, supports
cancellation and puts the resulting transcript in the editable draft. It does
not automatically send the transcript to Ask ALP.

- Job identity combines the verified owner and request UUID. A reused UUID with
  different audio is refused. Cross-owner status/cancellation is refused.
- Cancellation immediately hides the transcript. Physical cleanup waits for
  provider completion, then deletes the provider job and exact audio/output
  objects. An unsuccessful cleanup stays scheduled; it is not reported complete.
- Recordings are readable for at most 15 minutes. Application expiry does not
  depend on asynchronous DynamoDB TTL. Cleanup metadata gets a one-day TTL only
  after physical cleanup succeeds. This is not a complete privacy-retention policy.
- The old synchronous endpoint remains for installed-client compatibility.

Deployment: stack `ai-clinical-core-synthetic-staging-chat-transcription`, account
`588966314750`, region `us-east-2`, `UPDATE_COMPLETE`. Lambda code SHA-256:
`e1770bc1c5552c749d837190b23c60dea1da2b48a305ae93473ddecc32bc476a`.
Independently retrieved Lambda CodeSha256 matches, state Active, update Successful,
classification synthetic_only, PHI false.

`scripts/test-aws-voice-jobs.ps1` physically exercised authenticated hosted AWS
with locally generated fictional speech. Transcript matching, same-job retry,
immediate cancellation hiding, terminal cleanup and zero remaining recording/
transcript objects all passed. The first test run had an incorrect AWS CLI
pagination assertion; inspecting the ledger/objects identified that test defect.
The corrected full run passed. Both test recordings were removed. A shared
Transcribe write-access sentinel is not a recording/transcript and is not claimed
as per-job health data. Nine lifecycle unit tests pass.

**Not released to phones:** V2's polling/review changes are on PR 20, not an EAS
build. Its backend routes also need the matched patient API release. Physical
microphone/keyboard/background/unmount testing is outstanding. Production voice
identity/consent policy, approved retention, load limits and owned alert delivery
remain separate work. Do not point production users at this synthetic deployment.

## Independent consumer ownership: database and adapter qualification

The existing general record API requires a clinic connection. The new additive
production migration `20260908090000` and internal `owned-consumer-records.ts`
adapter provide personal ownership without fabricating a clinic or consent to
practitioner sharing. This migration is assembled but **not applied** to the
persistent production schema, and no public HTTP routes were added.

- Verified active consumer identity is required; missing claims, workforce
  identity and a mismatched subject fail closed. Owner is never a request field.
- All new tables have forced row-level security. API callers cannot directly
  insert/update/delete records or approve consent releases. Owner read policies
  are enforced in the database, including when querying tables directly.
- Storage consent is distinct from clinic-sharing consent. Wearables and
  reproductive health have separate scopes. No reviewed consent releases are
  seeded. Granting consent requires a registered human-reviewed release.
- Appends retain versions, source receipt times and metadata-only audit events.
  Updates require the current revision; duplicate request IDs are content-bound.
  Writes and consent changes serialize per owner. Revocation invalidates pending
  commands; later reconsent cannot silently replay the old consent revision.
- Listing selects the latest version before filtering tombstones, preventing
  deleted records from reappearing through historical versions. A tombstone is
  **not** physical erasure or completed account deletion.
- The adapter reuses collection validation, rejects identity/credential injection,
  bounds payloads and cursors, and exposes bounded consent/conflict/error codes.

`scripts/test-aws-owned-consumer-records.ps1 -ConfirmRollbackOnly` built and applied
the proposed schema inside an Aurora transaction in account `173535830222`.
**26 assertions passed**, covering unsigned-release refusal, owner isolation,
direct-query RLS, no required clinic connection, duplicate/content conflicts,
stale updates, separate wearable consent, withdrawal/reconsent, latest versions,
tombstones, direct-delete refusal and workforce refusal. The transaction included
fictional approval metadata solely for exercising controls. Independent checks
confirmed rollback: no retained schema or test identities. No real approval or
patient data was created. Eight adapter unit tests cover request/response guards.

## Next engineering, in dependency order

1. Wire owned storage into a separately gated consumer HTTP API and V2 providers;
   implement consent release/history retrieval and offline revision reconciliation.
   Preserve the distinct clinic-sharing route and explicit transfer action.
2. Join owned labs/jobs, profile, intake, cycle and wearable records into a bounded,
   attributable Ask ALP context; verify standalone and clinic-linked personas.
   This store currently covers existing general collections, not a new lab API.
3. Complete independent production lab/voice/provider qualification, reviewed
   range releases, Core feature policy and functional production hosting. Merely
   changing a banner or enabling the old clinic pilot does not complete this.
4. Complete export/correction/physical deletion across records, objects, jobs and
   identity, with the reviewed retention/backups policy and an auditable result.
5. Complete provider/store integration acceptance, rate/abuse/load and recovery
   exercises, exact-release security checks and physical iOS/Android testing.

Human agreements, clinical/consent approvals, provider production authorization,
store configuration and device tests remain in `commercial-launch-handoff.md`.
Engineering work above is still required in addition to those human gates.
