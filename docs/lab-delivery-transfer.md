# Explicit replacement-phone lab delivery transfer

September 17, 2026. Original phase 2 source increment, not completion or deployment.

## Contract and invariants

The existing authorized POST `jobs/{jobId}/delivery` route now accepts two more
strict commands. Neither adds a route, permission, provider call or job creation.

- Review: `{contractVersion:"lab-delivery-transfer-review/1",toBindingSha256}`.
  The response binds the job, old/new device digests, exact current claim digest
  and result digest. Review is read-only. The destination must differ from the
  existing claim. An unclaimed job should use ordinary recovery/claim instead.
- Confirm: `{contractVersion:"lab-delivery-transfer/1",claimSha256,
  fromBindingSha256,toBindingSha256,confirmTransfer:true}`. No caller-specified
  owner, result, expiry, consent or approval is accepted. The receipt identifies
  that exact transfer and its server timestamp.
- Both requests independently load the exact owned job, enforce classification,
  and in production invoke the existing current consent/account-closure policy.
  Jobs must be completed, non-deleting, unexpired and have a valid existing claim.
- The claim fingerprint covers result, expiry, current delivery/ACK and transfer
  history. The conditional DynamoDB write binds owner/organization/person,
  classification, state, result, expiry, old delivery, old ACK and old history.
  A concurrent acknowledgment, retry/claim, transfer, content mutation, expiration
  or scope change refuses. A→B→A does not make an old approval valid again.
- Transfer moves only the claim and retains the previous claim and acknowledgment
  in `deliveryTransfers`. It does not copy the old ACK onto the new phone. The new
  device must use the existing claim → durable local save/archive → ACK sequence.
  Prior result bytes, source provenance, lifecycle and expiry remain unchanged.
- Identical lost-response/concurrent retries return the original last receipt
  only while its target still owns this unchanged result. Newer transfers cannot
  be undone by stale replay. At most 16 transfers are retained; reaching the cap
  refuses instead of evicting old history. History follows the job's existing
  retention/deletion lifecycle, not a new permanent audit retention promise.
- Owner privacy export includes the transfer history and prior ACKs. Export is
  still a selected retained job copy, not complete account export.

Device binding is a routing identifier, not authentication. The fingerprint is
not a bearer authorization: the verified owner/session and current production
policy remain required. This is not remote wipe, old-phone session revocation,
active-plan adoption, clinical approval, cloud personal-record publication or
clinic delivery. The old phone can retain previously downloaded data and a save
already in flight; a later claim/ACK from its displaced binding is refused.

## V2 flow

Labs → Find analyses from another device → Review transfer to this phone →
Confirm transfer. The app then asks the user to refresh history and explicitly
Resume this analysis. No result is automatically attached or applied.

The review handle is tied to the original account/session/environment, untouched
history, target installation and five-minute local review window. Forged handles,
account changes, same-owner relogin, changed installation, competing local jobs
and mismatched receipts refuse. Pending local jobs are not erased by transfer.
A lost response remains unconfirmed and retryable; after restart, refreshed
history can discover a server-completed transfer. There is no old-server fallback.

## Evidence and release limits

Tests exercise the real API handler with a conditional-write-aware DynamoDB
double, actual V2 history/pending/review controllers with fictional storage,
and HTTP response/identity validation. They include competing requests, lost
responses, scope/result/ACK changes, bounded history, revoked production policy,
and retained privacy export. These are not hosted DynamoDB/JWT, phone persistence,
or physical two-device evidence. The AWS staging session is expired.

Final local Desktop full suite: **2,893 passed / 11 existing skips / 221 files**.
Eighteen new delivery-transfer cases are included, plus the existing privacy-copy
test now verifies retained transfer history. Typecheck/lint passed (four unchanged
Desktop warnings). The AWS lab-analysis API/worker candidates built successfully.
V2 full suite: **1,698 passed / one existing hosted skip / 143 passing files**;
20 new client cases. Its typecheck/lint and capability/TestFlight-source checks
passed. No isolated/hosted DynamoDB concurrency or phone acceptance is claimed.

Backend must deploy before the matching V2 client. Old claim, ACK, status and
inventory response shapes remain unchanged. Older clients with strict privacy
export schemas need updating before reading jobs with transfer history.
No PHI activation, provider agreement, clinical/source hold, paid build or
deployment is changed here. All SIX ORIGINAL commercial scopes remain incomplete.
