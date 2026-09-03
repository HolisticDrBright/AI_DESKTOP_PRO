# Fullscript integration

## Sandbox account boundary

The synthetic Desktop is intentionally configured against Fullscript Integrate's
U.S. sandbox (`api-us-snd.fullscript.io`). A normal production Fullscript
practitioner login is not evidence of a sandbox identity and may be rejected by
that sign-in page. The OAuth account used during synthetic testing must be a
sandbox Practitioner or Staff identity associated with the API client in
[Fullscript Integrate](https://fullscript.dev).

Do not point the synthetic deployment at the production authorization endpoint.
Production requires Fullscript's integration review, production OAuth client
credentials, the correct redirect registration, and the separate PHI/provider
activation gate.

Status: implementation-ready US sandbox boundary. Fullscript production and PHI use remain disabled.

## Architecture

Desktop is the sole OAuth client. A practitioner or staff member selects **Connect Fullscript** and is redirected to Fullscript's canonical OAuth page. The authorization code returns to the Desktop server, which exchanges it using the server-held client secret. Access and refresh tokens are stored only in a KMS-encrypted AWS DynamoDB table; neither token is returned to Desktop JavaScript or V2.

V2 never receives the Fullscript OAuth client secret, practitioner token, clinic token, or patient identifiers from Fullscript. Patient-facing access is represented by a governed AWS action created by Desktop:

- supplement: a practitioner uses a fresh Fullscript treatment-plan redirect; no consumer product deep link is invented;
- lab: `checkout_url` returned only after a lab recommendation/treatment plan is created;
- results: server-side lab-order retrieval followed by the existing duplicate-safe AWS lab-import contract. Raw Fullscript results are not trusted as a one-to-one test/result mapping.

There is no documented generic, stable “buy this exact product” URL contract in the API. Product pages can be rendered from catalog data, but an order action must use a treatment plan or another URL explicitly returned by Fullscript. Dynamic URLs are never hardcoded.

## Configuration

Required server-only values:

- `FULLSCRIPT_ENVIRONMENT=sandbox_us`
- `FULLSCRIPT_CLIENT_ID`
- `FULLSCRIPT_CLIENT_SECRET`
- `FULLSCRIPT_OAUTH_AUTHORIZE_URL=https://api-us-snd.fullscript.io/api/oauth/authorize`
- `FULLSCRIPT_REDIRECT_URI=https://<desktop-host>/api/live/fullscript/oauth/callback`
- `FULLSCRIPT_OAUTH_STATE_SECRET` (at least 32 random characters)
- `FULLSCRIPT_TOKEN_TABLE` (DynamoDB, point-in-time recovery, TTL, KMS encryption)
- `FULLSCRIPT_LAB_ORDERING_ENABLED=false` until the sandbox clinic and synthetic patient are ready

The Fullscript app should request only the scopes needed for the staged workflow: `catalog:read`, `clinic:read`, `patients:read`, `patients:write`, `patients:treatment_plan_history`, `patients:order_history`, `clinic:write`, and `labs:treatment_plans:create`. Scope expansion requires reauthorization.

Production remains fail-closed unless Fullscript approves the production application and restricted catalog/lab endpoints, the vendor/BAA and privacy review is recorded, the production secret is separate from sandbox, `FULLSCRIPT_PRODUCTION_APPROVED=true`, and `PHI_ALLOWED=true`.

`infra/aws-clinical-core/fullscript-connector-extension.json` provisions separate KMS-encrypted Secrets Manager values and a KMS-encrypted, point-in-time-recoverable, deletion-protected token table. Its outputs are mapped into the App Runner server environment; none are mobile build variables. The template deliberately outputs both `LabOrderingEnabled=false` and `PhiAllowed=false`.

## Product and lab behavior

- Product search: `GET /api/catalog/search/products`.
- Product detail: `GET /api/catalog/products/{id}`.
- Practitioner link: `GET /api/clinic/dynamic_links/treatment_plans`; always use its current `redirect_url`.
- Lab catalog/search: `GET /api/labs` and `GET /api/labs/search/tests`.
- Lab detail: `GET /api/labs/{id}`.
- Lab orders/results: `GET /api/clinic/labs/orders/{id}`.
- Lab checkout: use `checkout_url` returned from a lab treatment plan.
- Result readiness: verified `lab_order.updated` webhook plus API retrieval. Other statuses require bounded polling.

Webhook processing must validate `Fullscript-Signature` (`HMAC-SHA256(timestamp + "." + raw_body)`), enforce a five-minute age window, deduplicate by event ID, acknowledge quickly, and queue the result pull. Only the minimum event identifiers should enter the queue; patient name/email from webhook payloads are discarded.

The product dynamic link is a practitioner workflow, not a consumer product deep link. V2 must never open that link. V2 may open only a short-lived patient action produced by the governed AWS consumer-action service. Fullscript's public API does not currently document a stable direct-product purchase URL, so a missing patient-safe URL is treated as unavailable rather than replaced with a generic storefront link.
