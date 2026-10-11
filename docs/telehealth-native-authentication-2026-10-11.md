# Native appointment authentication prerequisite

The new appointment service needs independently verified login identities rather than historical synthetic claim rewriting. A separate source authentication component now verifies the Cognito signature, designated owner and clinic bindings, token times and current account state. The practitioner path also verifies the current required TOTP policy. This component does not install an HTTP route, approve PHI or authorize appointment writes.

## Source contract

`telehealth-qualification-authentication/1` accepts only synthetic account 588966314750, us-east-2, PHI false and blocked production activation. Its server-side target names distinct consumer/workforce pools, app clients and designated subject/person bindings in one organization. It is defensively copied. It carries no provider, database or administrative credential. The target is configuration, not evidence that those resources are deployed.

The native constructor uses the existing AWS verifier and a region-pinned Cognito client. Each invocation verifies the bearer signature against the pinned Cognito pools before reading attributes. Authorizer claims and request bodies cannot supply identity or clinic authority. Invalid tokens and changed identities require a fresh sign-in; unreadable resources, key-fetch outages and read deadlines report unavailable without echoing tokens or raw exceptions.

The live reads bind the actual pool ARN/account, app client and subject-addressed user. The current confirmed/enabled account must carry the same subject, person, clinic and verified email as the signed token, with production-bound rather than historical synthetic-attestation attributes. The authentication time must follow the current user modification time. The token must remain unexpired and the original sign-in no older than 15 minutes at every boundary, including after the final read.

The practitioner path requires an ON-MFA local-password pool, no remembered-device bypass, no federation/custom/passwordless flows, and only the current TOTP factor with TOTP preferred. It reads the MFA configuration directly and refuses SMS, email or WebAuthn alternatives. Sign-in must follow the current pool/client policy changes. These source rules are not a declaration that the actual pool already meets them; actual response shapes and sign-in journeys must be qualified.

One ten-second deadline bounds the full observation. Expiry during signature verification stops later Cognito reads. Expiry or a clock/token boundary during resource reads prevents an identity result. The result carries minimal internal identity metadata and a token digest, never the token or complete claims. Instance-local observation provenance cannot be copied or shared as a process-global current user.

AWS requires signature verification before trusting ID-token claims and recommends its verifier for Node.js. Cognito subjects are not required to conform to an RFC UUID; this component pins designated subject strings without imposing that format. [AWS token verification](https://docs.aws.amazon.com/cognito/latest/developerguide/amazon-cognito-user-pools-using-tokens-verifying-a-jwt.html), [Cognito ID tokens](https://docs.aws.amazon.com/cognito/latest/developerguide/amazon-cognito-user-pools-using-the-id-token.html).

## Verification and remaining integration

The first focused run passed 67 tests with real locally signed RSA tokens and the real verifier against cached fictional JWKS. AWS command responses remain fictional transports. An initial typecheck found three test-only unknown-command accesses; explicit fixture casts repaired them without weakening an assertion. Final typecheck, lint, complete-suite and CI results are separate checkpoints, not borrowed from the atomic-publication parent.

Final focused verification passed 202 tests across five files, including 71 authentication cases, and typecheck, lint and diff checks passed. Concurrent consumer/workforce calls remain isolated; expiry during the final MFA read, a late Cognito response and a backwards clock cannot issue an observation. Whole-suite and exact-head CI verification are still separate from these results.

The atomic-publication parent has green exact-head CI 38169823309. Its local normal full run passed 7,795 tests with 11 unchanged skips but failed one five-second embedded-database diagnostic timeout. The unchanged diagnostic passed 8 of 8 alone in 2.16 seconds; that narrower result does not replace the failed full-run observation or prove its cause.

This is a new source prerequisite, not a reproduced defect in an activated production service. It does not claim an earlier runtime was secure, that Cognito was called, or that a fictional response proves an actual account. No existing historical handler, environment flag, route, IAM grant or schema was changed.

The complete factory still needs exact observed API/integration/numeric Lambda source identity, actual account and resources, restricted database/storage credentials, and exact release/fleet binding. It must consume the authenticated identity without manufacturing event claims, then obtain per-action clinic/consent authority. A point-in-time identity observation and instance provenance are not current consent, retained-record authority, a durable write capability or proof of token revocation/global sign-out. Current session revocation, disabled identities and authority changes require the request-service rechecks and admission/settlement design.

New sharing, recovery/cancellation after withdrawal, payments, provider start/end and retained chart text have different authority requirements. They must not all inherit the appointments-consent gate. Writes and provider actions require durable admission, replay and settlement without network calls inside database locks. The native factory is not complete until those paths, restricted resources and failure recovery are implemented and hosted-qualified together.

Managed qualification remains last independently observed at database 112. Source prerequisites 117/118 are not applied targets or reusable schema approval. No AWS request/write, fixture, provider call, consent/review row, migration, deployment, paid build, merge, PR or PHI activation occurred here. The six original readiness scopes remain open.
