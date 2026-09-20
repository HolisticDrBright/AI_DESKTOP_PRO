# Lab range activation readiness (reporting tool, never activation)

September 16, 2026. Offline tooling; no key is created or read, nothing is pinned, signed or deployed.

## Purpose

`preparePreciseLabRangeRelease` produces an unsigned `lab-ranges/2` candidate with status `unsigned_not_deployed`. Activating a candidate requires evidence the six-phase ledger lists as holds that must not be invented: an authorized signature, released clinical holds, safety-regression approval and synthetic acceptance. `assessLabRangeActivation` (`src/server/clinical-core/lab-range-activation-readiness.ts`) checks that each item exists **and is bound to the exact prepared bytes**. Its best outcome is `ready_for_authorized_operator`; it never reports "activated" and `activationPerformed` is always `false`.

## Gates

| Gate | Evidence field | Blocker when |
| --- | --- | --- |
| Signature | `signedEnvelope {payload, signature}`, `trustedSha256`, `publicKeyPem` | missing; trusted hash differs from the prepared bytes; signed payload differs from the prepared bytes; Ed25519 verification fails (`verifyLabRangeRelease`) |
| Holds | `holds[] {id, sourceId|null, status, placedBy, placedAt, releasedBy?, releasedAt?}` | any `open` hold whose `sourceId` is null (release freeze) or matches a shipped `source.id`; a `released` hold without reviewer and time is invalid evidence |
| Safety regression | `safetyRegression {status, approvedBy, approvedAt, payloadSha256, evidenceSha256}` | missing; not `approved`; approved for a different payload hash; future-dated. The evidence hash comes from the offline regression report (`docs/clinical-safety-regression.md`) |
| Synthetic acceptance | `syntheticAcceptance {evidenceSha256, runAt, payloadSha256, phiAllowed:false}` | missing; for a different payload hash; future-dated; `phiAllowed` other than `false` is invalid evidence |
| Release itself | prepared JSON | invalid `lab-ranges/2`; empty; expired; any review or verification date in the future (schema already requires source verification `V`) |

An open hold on an unrelated source does not block; the report names each blocker so an operator can see exactly what is missing.

## Usage

```
npm run build:lab-range-tools
node dist/lab-range-tools/activation-readiness.cjs <prepared-release.json> <evidence.json> <new-report.json>
```

`evidence.json` may name `publicKeyPemFile` instead of inlining `publicKeyPem`. The report is created exclusively (an existing file is not overwritten). Exit code 2 means blocked, 1 means the inputs could not be assessed; failure output never echoes paths, keys or candidate contents.

## Status

No real release has been prepared, signed or assessed. The 70 hormone bands remain source verification R and the reviewed release map has zero runtime-eligible records, so any assessment today reports `activation_blocked`. This tool changes no runtime behaviour and does not alter how a pinned release is loaded.
