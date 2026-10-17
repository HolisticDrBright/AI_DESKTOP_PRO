# Current-membership withdrawal in a closed clinic — source review

**BLOCKED and unregistered.** This change does not apply SQL, switch an authority mode, enable a provider, permit PHI, or approve real-patient use. It closes the source mismatch left after Brandon chose to allow authorized practitioners to record **withdrawals only** in a suspended clinic. New consent grants remain blocked.

## Why a separate entry point

`set_current_workforce_context(subject, clinic, 'consent_management')` intentionally refuses a suspended or archived clinic. Merely letting that generic setter through would expose every other consent-management read and write under a closed-clinic context. The new `revoke_current_workforce_consent` function is one exact operation: it resolves and share-locks the current identity, person, clinic and clinical membership; locks the connection in that same selected clinic; invokes only the existing withdrawal function; then clears all seven transaction-local claims before returning. The general setter and the new-grant path are unchanged. The TypeScript current-membership adapter calls this one statement instead of calling the generic setter first.

The wrapper trusts the verified Cognito subject supplied by the authenticated API, as the existing current-membership setter does. It refuses a disabled identity/person, removed membership, staff-only role, wrong clinic or connection, missing/unknown reason, or absent active grant. It does not create a credential recovery route or authorize a suspended member.

## Exact source identities

| Artifact | SHA-256 over LF-normalized bytes |
| --- | --- |
| `infra/aws-clinical-core/source-candidates/workforce-current-withdrawal-only.sql` | `24847d3a7127cf36660f850c5467a6c8b9e45ae833015f23884b7e0dc00873f8` |
| `infra/aws-clinical-core/source-candidates/workforce-current-withdrawal-only-rollback.sql` | `ea558476f2a13f52c4089f09903764b60509dd44bd6bf7db90ee4733872deb52` |

The forward candidate requires the unchanged current-membership setter prosrc SHA-256 `7054db763a6ff38b00a504a09398dcbd60f69b6476b6c85bab36da496d6e0cd6` and the reviewed withdrawal-only consent function prosrc SHA-256 `002dc02bb8e55e9853a3fffa8ecbc1dd1f900893bce7ee2421530b53627da88f`. It checks its own function body (`fa5a963aa356caaf988b6b9f0e5a8894f709a92fcba4adb216ee43392bab67fa`), SECURITY DEFINER, locked search path and grants after creation. The rollback refuses a drifted body, drops only this wrapper and preserves consent/audit rows and both parents.

## Local evidence and limits

The new PGlite suite has 10 cases: suspended and archived withdrawals, no reusable request context or new grant, wrong clinic and subject, removed member and disabled credential, nonclinical role, invalid reason, no live grant, second withdrawal, exact adapter call, API-only grant, parent-drift refusal, and preserving rollback with rollback-drift refusal. The four adjacent identity/current-membership/custody suites passed 85/85 before the two final guard negatives were added; re-run them on the committed head. Typecheck and lint passed. This is local evidence only.

Before registration or activation, run a two-session PostgreSQL/Aurora negative for identity disable, membership removal and clinic closure in both lock orders; verify exact parent and LF-byte hashes on the target; rehearse rollback with fictional rows; inspect the current route, role privileges and caller's token/session validation; then seek separate owner/security review. The current candidate and its parents remain unapplied. No physical device or hosted positive journey is claimed.

The larger clinic-status decisions D1, D3, D4 and D5 in `docs/suspended-clinic-custody-2026-10-16.md` remain open: lawful patient-file continuity, recording cleanup, legal holds and patient copies. This narrow change does not make the clinic-status family releasable.
