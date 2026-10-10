# Fullscript observed installation binding

The source adapter now compares a reviewed provider release with the saved
OAuth installation and the clinic returned by Fullscript using that credential.
This closes a credential comparison gap; it does not install the governed cart
service or approve its use. Cart delivery remains `not_implemented`.

## Installation identity and review

Every new OAuth authorization saves a random installation UUID. Reauthorization
at the same timestamp still creates a different installation. Refresh must
preserve that UUID, actor, organization, owner, permissions and connection date.
Legacy records remain readable for existing lookup, but draft delivery requires
reauthorization. Neither the observer nor a refresh invents a legacy UUID.
The callback also saves the OAuth client ID and redirect URI used in that exact
authorization. The observer rejects configuration that differs from these saved
values before any provider request; current configuration alone is not evidence
that an existing token was issued to that client.
These checks precede refresh as well as clinic lookup. A refused legacy, staff,
wrong-client or insufficient-permission installation cannot renew its credential
as a side effect of an unavailable draft operation. Status also validates actor
custody and environment rather than displaying an unrelated connection as active.

The observer reads the actual saved credential, requires sandbox draft scopes,
and calls the canonical sandbox `GET /api/clinic` endpoint. Fullscript documents
the response's `clinic.id` and the `clinic:read` requirement in its [clinic
reference](https://fullscript.dev/technical-reference/clinic). Only the ID is
retained. Clinic names, discounts, counts and provider URLs are not authority.
Provider URLs are never followed.

The fingerprint hashes the versioned installation identity, actor and organization,
connection date, actual clinic, practitioner owner, sorted complete permissions,
OAuth client ID, redirect URI, environment and API origin. Access tokens, refresh
tokens, expiry and secrets are excluded so ordinary rotation does not invalidate
the installation review. Reconnecting, changing the OAuth client or redirect,
changing clinic, owner or permissions requires a new review. The observation
returns no secret, token, patient record or provider purchase URL.

Credential custody is read again after the clinic request. Disconnection,
replacement or rotation during that request refuses the observation. Each draft
POST and recovery lookup obtains a fresh observation and compares its clinic and
fingerprint with the reviewed release. POST additionally requires the intent's
practitioner to be the actual OAuth practitioner owner. Staff delegation remains
unavailable until its separate design and review exist.

## Required runtime integration

The new [canonical delivery service](fullscript-canonical-runtime-2026-10-09.md)
now loads the provider release from current same-target SQL authority and joins
that authority to the durable ledger and native credential adapter. It rechecks
authority after credential observation, then rereads credential custody before
transport. It remains unreleased; the HTTP identity/MFA/observed-target binding,
privacy lifecycle and hosted qualification described below are still required.

The provider release argument is an internal service input, not proof of approval.
No route accepts it from a browser. The eventual handler must load it from current
same-target canonical authority, verify the authenticated identity and MFA, observe
the AWS account and target, verify the migration ledger and artifact, and recheck
authority before each admission. The new provider adapter supplies credential and
clinic checks only; it cannot substitute for those checks or recall a request
already admitted to Fullscript.

Still required: the scoped runtime and API, reviewed releases and consent,
hold-aware privacy lifecycle, forward application and rollback operators, exact
artifact deployment, and positive sandbox acceptance through real DynamoDB,
Aurora and Fullscript. No production, patient send, order or charge is enabled.
PHI remains disabled. No AWS credentials or provider credentials were read or
changed during these fictional-transport tests.

## Local verification

The final focused group passed 106 tests in five files, including 40 observed
installation cases, three installation-preservation regressions, four additional
refresh/status regressions and three real
callback cases. The callback cases include two authorizations at one fixed
timestamp and nonce-replay refusal. The first focused run failed a test assertion
that mistook the public permission name `patients:treatment_plan_history` for
patient data; the corrected assertion checks the fictional patient identifier.
That failed run is not a pass. These are local transports, not hosted acceptance.
The preceding extended run passed 287 tests in 12 files before the final client
binding and callback additions; it is not an exact-final extended-suite result.
Another extended run passed301tests/13files, but overlapped the last refresh/status
edits and is not an exact-final result either. The final unchanged-source extended
run passed all305tests in13files, no skips,134.83seconds, starting18:44:22PDT
October9. Typecheck and targeted lint also passed. Fifty new cases are included.
