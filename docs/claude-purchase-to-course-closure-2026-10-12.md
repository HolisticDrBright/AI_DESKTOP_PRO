# Purchase to course: the reviewed, closed-by-default runtime (2026-10-12)

Source engineering only. Nothing here was deployed, applied, activated or run against AWS, Stripe,
SES, Cognito or any provider. Every test described is a **source test** over fictional stand-ins; none
is hosted, device or store evidence, and none establishes commercial or PHI readiness.

## Where it starts

| Repository | Base (verified head) | Branch |
| --- | --- | --- |
| Desktop | `c0007657d6bbe466747988730bfdc92d4caba468` (`agent/course-media-reference-20261012`, CI 38292240725 success) | `claude/purchase-to-course-closure-20261012` |
| V2 | `24a06884ac6b95a64ecafaf7efefd38c1d88178a` (`agent/privacy-copy-source-truth-20261012`, CI 38294583577 success) | `claude/purchase-to-course-closure-20261012` |

The course-delivery hardening heads `d94f1de` / `4d0cb25` are ancestors of both bases. Both Codex
branches moved after the stated heads (Desktop to `dcccfa84`, five care-messaging qualification
commits; V2 to `35d65f0`, an evidence document). Those commits were not taken; no file this work
changes is changed by them.

## What was missing (failing before)

Run on the base head with the full qualification configuration a host would supply (flags on,
Stripe test credentials, account and API version pinned), using a probe test kept out of the tree:

| Probe | Base `c0007657` result |
| --- | --- |
| A correctly signed test-mode webhook is admitted | **503** `not_configured` — no checkout runtime exists outside the fixture |
| A learner reaches My courses | **503** `learner_host_unavailable` — nothing installs a host |
| The worker's reconciliation list reaches the database over the RDS Data API | **`store_unavailable`, never sent** — `ordersInStates` passed a JS array, which the Data API factory cannot encode, so reconciliation could never run hosted |
| A module serves `POST /clinical-core/consumer/education` | **none** — V2's client posts to a route nobody serves (404 at the gateway) |

V2 at `24a0688`: the education access and progress clients sent only the ID token. Four new tests
(access token header sent; a session without an access token sends nothing) failed before the change.

## What exists now

### 1. One pinned target opens everything (`program-commerce-host-target/1`)

`src/server/commerce/reviewed/commerce-host-target.ts`. A strict schema that can name only the
qualification account `588966314750`, `us-east-2`, database `clinical_core_qualification`, PHI false
and production activation blocked. It names:

- four database sessions (API, worker, delivery, operator), each its own Secrets Manager secret and
  its own runtime login — a shared secret or a swapped login is refused;
- the consumer user pool, app client, hosted sign-in domain and Desktop origin;
- activation evidence naming the offer candidate, and the pinned SHA-256 of all eight candidates;
- the Stripe test-mode account, pinned API version and the **price ids it holds** (no price is
  created or chosen; an empty list holds purchasing);
- the SES sender, optional configuration set and Message-ID domain; the sealing key's reference
  (never the key);
- Brandon's decisions as records — `purchaserContactAuthority`, `claimCodeLifetimeDays`,
  `staffProgressVisibility`, `storefrontClassification` — each `held` or `decided` with who, when and
  an evidence digest. Nothing defaults.

Where it comes from (`commerce-host-target-source.ts`): on the Desktop, the read-only mount
`/run/alp/program-commerce-host-target.json`, opened `O_NOFOLLOW`, bounded, stat-checked before and
after the read, its SHA-256 equal to `PROGRAM_COMMERCE_HOST_TARGET_SHA256` and its `sourceCommit`
equal to `PROGRAM_COMMERCE_SOURCE_COMMIT` — **re-read on every request**. In Lambda, the same bytes in
`PROGRAM_COMMERCE_HOST_TARGET_JSON` under the same two pins.

Readiness (`commerceReadiness`) is explicit and per capability:

| Capability | Needs | Holds named when missing |
| --- | --- | --- |
| learner (read, claim, curriculum, progress) | flags, target, activation evidence | `flags_off`, `target_unavailable`, `activation_evidence_missing` |
| purchasing and worker | the above, plus Stripe test key + webhook secret, account and API version equal to the target's, ≥1 price id, both decisions decided, a 32-byte sealing key | `stripe_credentials_missing`, `stripe_account_mismatch`, `stripe_api_version_mismatch`, `price_ids_missing`, `purchaser_contact_authority_held`, `claim_code_lifetime_held`, `sealing_key_missing` |

Flags: `PROGRAM_COMMERCE_QUALIFICATION_ENABLED=true`, `PHI_ALLOWED=false`,
`PRODUCTION_ACTIVATION=blocked`, not `PRODUCTION_WORKLOAD_MODE=readiness_only`, not the local
contract fixture. The offer itself must still be published under reviewed access terms in the
database (`record_reviewed_access_terms`), and an offer whose price id the target does not list is
held as `provider_mapping_unapproved`; the processor wrapper refuses to create a session for it.

### 2. Identity: a verified consumer session, every request

`src/server/learner/consumer-session.ts`. The only source of a learner identity in the reviewed
runtime:

1. ID token signature, issuer, audience (the consumer app client), `token_use=id` and expiry, against
   the pool's published keys (`aws-jwt-verify`);
2. `custom:person_id`, `custom:organization_id` (UUIDs), `custom:synthetic_attested=true`, not
   `custom:production_bound`; sign-in no older than 12 hours;
3. **revocation on every request**: Cognito `GetUser` with the access token (sign-out everywhere,
   revoked tokens, disabled/deleted users are refused);
4. **owner**: GetUser's `sub`, person and clinic attributes must equal the ID token's.

No positive answer is cached. A request body, a staff login, a fixture cookie or an earlier result is
never an identity. An unreachable identity service is `unavailable` (503), never "signed out".

Desktop sign-in (`src/server/learner/consumer-signin.ts`, routes under `/api/my-courses/session`):
the pool's hosted sign-in, authorization code with PKCE S256, a public client (no secret on the
server), state bound by a single-use HttpOnly cookie and compared in constant time; tokens are
verified **before** any cookie is set; ID and access tokens in `__Host-` HttpOnly, Secure,
SameSite=Strict cookies; no refresh token kept. Sign-out calls `GlobalSignOut` and clears the cookies
even if Cognito cannot confirm.

### 3. Installed only by the reviewed bootstrap

`src/server/commerce/reviewed/reviewed-bootstrap.ts`, called once from `src/instrumentation.ts` only
when `PROGRAM_COMMERCE_QUALIFICATION_ENABLED=true`. It is the only caller of `installLearnerHost`
(kind `reviewed`) and `installReviewedPurchasing`, and does nothing unless the edition is clinical,
the flags hold and the target verifies at boot. Everything it installs re-resolves per request: flags
re-read, target re-read and re-verified; a target removed or replaced after boot closes My courses,
sign-in, checkout and the webhook at the next request. `assertAwsProductionRuntime`, the
readiness-only middleware and the production pilot policy are untouched, and the target cannot name
production, PHI or an unblocked activation.

The purchase routes and pages now resolve through `resolvePurchaseRuntime()` (fixture/acceptance
first, only under the contract fixture; then the reviewed runtime; else disabled). The Studio status
route still uses the fixture-only selection: the reviewed runtime has no verified workforce identity
(see *Gaps*).

### 4. Four least-privilege interfaces

| Interface | Entry | Database session | Does |
| --- | --- | --- | --- |
| API (Desktop Next server) | checkout start, webhook, My courses | `program_commerce_api_runtime` → `clinical_core_api` | admit orders and intake, consumer access/claim/curriculum/progress |
| Education API (Lambda) | `src/server/commerce/reviewed/education-api-lambda.ts` | API session only | V2's `POST /clinical-core/consumer/education` and `/progress` |
| Worker (Lambda, scheduled) | `src/server/commerce/reviewed/commerce-worker-lambda.ts` | worker + delivery sessions only | intake processing, reconciliation, settlement, delivery, expiry |
| Operator | no request path | `program_commerce_operator_runtime` | policy decisions, code replacement (operator tooling, not built here) |

`createRdsDataCommerceSessionDatabase` (additive, `src/server/clinical-core/rds-data-database.ts`)
accepts only the qualification account, region and database and assumes exactly its authority's role
with `set local role`. BLOCKED successor
`infra/aws-clinical-core/source-candidates/program-commerce-runtime-sessions.sql`
(SHA-256 `d2142ad80fead07f83fa23636434274037c87ebad91fa1ce59988ab973b2c037`, parent
`program-education-progress.sql` `7d4b3ee7…`) creates four NOLOGIN, NOINHERIT runtime roles, each a
member of exactly one authority role. It creates no login or password and is not in the manifest.

The source test observed, on the fake Data API, that the worker reached only the worker and delivery
secrets and the education API only the API secret. That is the code's behaviour; whether each IAM
role can read only its own secret is a hosted fact.

The education API is a separate function so the identity API's route table is unchanged; the
existing assertion that `aws-identity-api.ts`, `check-aws-authenticated-api.mjs` and
`identity-api-extension.json` never name `consumer/education` still holds and is repeated.

### 5. Connectors (`src/server/commerce/reviewed/commerce-connectors.ts`)

- **Checkout**: the existing Stripe test-mode transport, constructed only by the reviewed runtime,
  wrapped so it creates a session only for a listed price.
- **Purchaser contact**: the email Stripe's hosted page collected for **this order's own** test-mode
  session (`client_reference_id` and `metadata.order_id` must name the order), read at send time and
  never stored. Constructed only while `purchaserContactAuthority` is decided.
- **Email**: SES v2 raw message with a deterministic `Message-ID` from the delivery's idempotency key.
  A definite refusal is recorded as failed; anything else is an unknown outcome and is retried with
  the same code and Message-ID. **SES has no idempotency key: a retry after a lost reply can deliver
  twice.** The same code arrives twice, and nothing else changes.
- **Sealing**: AES-256-GCM under the host-injected key (`PROGRAM_COMMERCE_CLAIM_SEALING_KEY`), bound
  to the claim id, under the target's versioned key reference.
- **Settlement**: the code lifetime is the decided `claimCodeLifetimeDays` (1–30).
- **Scheduled settlement/recovery**: `createReviewedCommerceWorkerHandler` runs one worker pass per
  invocation and returns counts only (no code, address or provider text).

### 6. Media

The selected native-store work (`agent/program-media-native-store-20261011`, tip `8f06c841`,
descended from `66fa018`) is already in the base through `a587fdc8`. The overlapping Claude
media-repair branch `23d65e9` is not in either ancestry and was not merged. The Desktop mirrors
`programAssignments`, `programLessonMedia`, `programEducationAccess` and `programEducationProgress`
are byte-identical to V2's (LF-normalised). Learner video stays unavailable: V2's lesson media
reader answers `held`, the Desktop learner page shows the held notice, and the reviewed runtime
constructs no media delivery path.

## Tests (source only)

`src/server/commerce/reviewed/purchase-to-course.database.test.ts` (25) runs purchase → signed
webhook → worker settlement → SES delivery → claim (V2 path) → exact curriculum (both surfaces) →
progress through the reviewed runtime as the bootstrap composes it, over:

- the BLOCKED chain plus the runtime-sessions successor on an embedded engine on disk, reached only
  through the RDS Data factory and a fake Data API that maps each secret to its login
  (`pglite-rds-data.test-support.ts`). One connection, one superuser, no network: grants are
  exercised, but this is **not hosted isolation and not lock contention**;
- real ID-token signature verification against a key set the test generated, and a fake GetUser;
- a fake Stripe API and signed webhook events; a fake SES send.

Covered: a lost checkout creation reply; duplicate and second distinct events; a settlement commit
whose reply was lost, then a restart (one entitlement, one code); an SES accept-then-lost reply
retried with the same code and Message-ID; a restart between admission and processing; no
processor-held email; an SES refusal; two owners (claim, curriculum, progress); a later version
published (the purchased pin is still served, writes naming the new version are `stale_version`, new
purchases hold `curriculum_changed`); a supplement step held `not_completable`; forged, foreign,
access-token, production-bound, unattested and expired tokens; a mismatched access token; gateway
claims for another subject; revocation mid-request (reply discarded) and before the next request on
both surfaces; an identity outage (503); and each missing configuration item.

`src/server/commerce/reviewed/reviewed-commerce.test.ts` (31): target refusals, readiness, the target
reader (digest, commit, pin, symlink, missing file, abort), SES, purchaser contact, sealer, closed-by-
default education API and worker, PKCE sign-in, callback refusals, sign-out, and the reviewed host.

Repaired while testing: `ordersInStates` (above), and an unhandled rejection when the target read was
aborted while the file open was still pending.

## What Codex supplies in AWS (qualification account only)

Database (after review of the successor and Codex applying it in qualification):
1. Apply `program-commerce-runtime-sessions.sql` after the seven commerce candidates.
2. Four logins, one per runtime role, each `LOGIN` with its own password in its own secret; verify
   each login is a member of exactly its one authority role and nothing else.

Configuration:
- Desktop container: the target file mounted read-only at `/run/alp/program-commerce-host-target.json`;
  `PROGRAM_COMMERCE_HOST_TARGET_SHA256`, `PROGRAM_COMMERCE_SOURCE_COMMIT`,
  `PROGRAM_COMMERCE_QUALIFICATION_ENABLED=true`, `PHI_ALLOWED=false`, `PRODUCTION_ACTIVATION=blocked`,
  `APP_EDITION=clinical`; for purchasing also `STRIPE_TEST_MODE_ENABLED=1`, `STRIPE_TEST_SECRET_KEY`,
  `STRIPE_TEST_WEBHOOK_SECRET`, `STRIPE_TEST_ACCOUNT_ID`, `STRIPE_API_VERSION_PINNED`,
  `PROGRAM_COMMERCE_CLAIM_SEALING_KEY` (base64, 32 bytes).
- Education API Lambda (`npm run build:aws-program-commerce` → `dist/aws-clinical-core/program-commerce/education-api`):
  the flags, `PROGRAM_COMMERCE_HOST_TARGET_JSON` + the two pins. No Stripe or sealing secret.
- Worker Lambda (`…/commerce-worker`): the flags, target JSON + pins, all Stripe values and the
  sealing key; an EventBridge schedule; concurrency and alarms.

IAM: Desktop task role — `rds-data:*Statement/Transaction` on the cluster and
`secretsmanager:GetSecretValue` on the **API** secret; `cognito-idp:GetUser`/`GlobalSignOut` need no
IAM (token-authorised). Education API role — the same, API secret only. Worker role — worker and
delivery secrets, `ses:SendRawEmail`/`ses:SendEmail` on the sender identity (and configuration set).
Operator — no runtime role is created here.

Network: the Desktop container and both functions need outbound HTTPS to
`cognito-idp.us-east-2.amazonaws.com` (published keys and GetUser); the Desktop also to the pool's
hosted sign-in domain (token exchange); the Desktop and the worker to `api.stripe.com`. The Desktop
composes the worker objects but no request path calls them, so it needs no worker or delivery secret.

Routes: API Gateway `POST /clinical-core/consumer/education` and
`POST /clinical-core/consumer/education/progress` → the education API function, with the consumer
JWT authorizer; allow the `x-alp-consumer-access-token` header. Desktop: `/api/my-courses`,
`/api/my-courses/session`, `/api/my-courses/session/callback` (registered as the app client's callback
URL), `/api/my-courses/session/signout`, `/api/live/commerce/webhook` (Stripe test endpoint),
`/api/live/commerce/checkout`.

Cognito consumer app client: authorization-code grant with PKCE, no secret, scopes `openid email
profile aws.cognito.signin.user.admin` (GetUser needs the last), read access to `custom:person_id`,
`custom:organization_id`, `custom:synthetic_attested`, `custom:production_bound`.

## Ordered hosted tests (Codex)

1. Target negative: mount a target with a wrong digest, then a wrong commit — bootstrap logs
   `target_unavailable`; My courses answers `learner_host_unavailable`; webhook 503.
2. Role readback: for each secret, `select session_user, current_user` after `set local role` of its
   own authority succeeds and of every other authority fails.
3. Learner only (purchasing held): sign in through `/api/my-courses/session`; My courses 200 with an
   empty view; V2 access 200; sign out everywhere, then both answer 401.
4. Revocation: sign in on two devices; `GlobalSignOut` from one; the other gets 401 at its next call.
5. Purchasing held: with each Stripe value missing in turn, the bootstrap log names the hold and the
   buy page says checkout is not configured; the consult path is present throughout.
6. Purchase (Stripe test mode, a test price Brandon chose for the fictional offer): checkout → test
   card → webhook 200 → worker pass → SES message to the test inbox → claim from V2 → the exact pinned
   curriculum on both surfaces → a completion on one, read on the other.
7. Faults: re-deliver the same webhook (duplicate); stop the worker between admission and processing
   and restart it; force an SES timeout and observe the retry carry the same Message-ID.
8. Two owners: a second synthetic consumer cannot claim the first one's code or read its course.
9. Stale curriculum: publish a new version; the first purchaser still reads the purchased version;
   new purchases hold `curriculum_changed`.

## Decisions still Brandon's (held, not defaulted)

Each program's price; billing and duration; refunds; renewals; taxes; whether the processor-collected
email may receive the access code (purchaser-contact authority); code lifetime; storefront
classification; staff visibility of learner progress. Purchasing stays disabled until the two
decisions it depends on are recorded as decided with evidence, a price id is listed, and an offer is
published under reviewed terms. Every repository funnel is still a draft with no program binding, so
buy stays held and **both paths remain**: book a consultation, or buy directly once enabled.

## Gaps and findings

- **API role breadth**: `program_commerce_api_runtime` inherits all of `clinical_core_api`, shared by
  every API service. Narrowing it is a separate review.
- **Staff surfaces**: Studio commerce status and offer commands use a fictional workforce identity;
  the reviewed runtime refuses staff offer commands and the status route never selects it.
- **SES duplicates**: possible after a lost reply (above).
- **PGlite**: role isolation and recovery are shown under an embedded single-connection engine; real
  role isolation, concurrency and lock behaviour are hosted questions.
- **Overlap**: `rds-data-database.ts` (additive factory and role union); `sql-acceptance-host.ts`
  (exports its chain builder for tests); `program-checkout-ledger-sql.ts` (the array repair). No file
  overlaps Codex's newer commits.
