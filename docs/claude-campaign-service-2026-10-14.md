# The campaign service (marketing wiring, workstream 2) — 2026-10-14

- **Branch:** `claude/campaign-service-20261014`.
- **Base:** `agent/qualification-range-release-store-20261014` at `22053299`.

This is workstream 2 of the marketing-wiring handoff. It carries forward the 2026-10-13 lead-campaigns work
(`claude/lead-campaigns-20261013` at `7942a757`, never integrated; its return is
`docs/claude-lead-campaigns-2026-10-13.md`), less the funnel-page link, which belongs to workstream 1. It
then adds what the master handoff asks for.

**Scope.** Source only:

- no AWS write, DNS change, vendor sign-up, list import, send, deployment or merge to `main`;
- the infrastructure is written and validated, not applied;
- no Mautic or listmonk code; nothing of Dittofeed's source is copied in.

## What was verified about Dittofeed (2026-10-14, from its source at the pinned release)

The checks below were read from Dittofeed's own repository:

- **Release.** `v0.23.0`, commit `fe2b311643f63cad4c9851a87359d1ed0b152070`, dated 2025-11-29.
- **How it was read.** A shallow clone made with `git` into a scratch directory. Nothing was installed,
  built or run.
- **Newest tags.** The newest stable tag is still `v0.23.0`; the newest tag is `v0.24.0-alpha.21`.
- **Pin.** `v0.23.0`.

| Question | Finding (file) |
| --- | --- |
| Licence | MIT, "Copyright (c) [2023] [Idea Market inc.]" (`LICENSE`). There is no `ee/` directory. Multi-tenancy is documented as "only available in dittofeed-ee, and Dittofeed cloud" (`packages/docs/deployment/self-hosted/auth-modes/multi-tenant.mdx`). |
| Sign-in modes in the free version | See "Sign-in modes" below. |
| Is Temporal required? | **Yes.** See "Temporal and resources" below. |
| Minimum resources | No documented minimum. See "Temporal and resources" below. |
| Can journeys carry the confirmation step? | **Not as a double opt-in.** See "The confirmation step" below. |
| Bounces and complaints | See "Bounces and the SES webhook" below. |
| One-click unsubscribe | Every message gets `List-Unsubscribe`, `List-Unsubscribe-Post: List-Unsubscribe=One-Click` and `List-ID` (`messaging/email.ts`). The URL is the dashboard's public `/dashboard/public/subscription-management` page; a POST to it was **not** shown to unsubscribe (RFC 8058 behaviour is unconfirmed). |

### Sign-in modes

Three modes exist in source (`backend-lib/src/types.ts`: `anonymous`, `single-tenant`, `multi-tenant`).

- **`anonymous`.** The default when unset (`config.ts`), and not for production.
- **`single-tenant`.** One shared password and `SECRET_KEY`. It is "only available with dittofeed-lite".
- **`multi-tenant`.** In the open-source API, the bearer token is decoded with `fast-jwt`'s `createDecoder()`
  and **not verified** (`backend-lib/src/auth.ts`, `requestContext.ts`).

So the free build's only usable mode is the one shared password. The dashboard therefore stays off the
internet, and multi-tenant is never configured.

### Temporal and resources

**Temporal is required.** `lite/scripts/startLite.ts` starts a Temporal worker, journeys are Temporal workflows
(`backend-lib/src/journeys/userWorkflow.ts`), and the lite compose file runs `temporalio/auto-setup:1.22.4`.

**Resources.** No minimum is documented. The defaults are:

- **Lite compose:** lite container 1024 MB with an 824 MB Node heap; ClickHouse 2048 MB
  (`clickhouse-server:24.12.6.70-alpine`); Postgres 15 unbounded.
- **Helm** (`helm-charts/dittofeed/values.yaml`): 1 CPU and 1024–2048 Mi for its parts.

The template sizes Dittofeed at 1 vCPU / 2 GB, ClickHouse at 1 vCPU / 4 GB, Temporal at 0.5 vCPU / 1 GB, and
Postgres on a `db.t4g.medium`. That is an estimate, not a documented figure.

### The confirmation step

- **No built-in double opt-in.** The source has no double opt-in, and the only subscription link tags are
  `unsubscribe_*` and `subscription_management_*` (`backend-lib/src/liquid.ts`).
- **Groups start empty.** Opt-in groups start empty; a user is subscribed by a `DFSubscriptionChange` track event.
- **How it is built here.** The confirmation is sent by this repository's sign-up service before Dittofeed
  knows the person; the confirmation then subscribes them.

### Bounces and the SES webhook

**Bounces and complaints.** SES events become `DFEmailBounced`, `DFEmailMarkedSpam`, `DFEmailDelivered`,
`DFEmailOpened` and `DFEmailClicked` events (`destinations/amazonses.ts`). They cause **no automatic
suppression**, so this build adds its own.

**The webhook.** `/api/public/webhooks/amazon-ses` checks the SNS signature but **not which topic** it came
from, and it confirms **any** subscription request (`api/src/controllers/webhooksController.ts`). A public
webhook would therefore accept genuinely signed events from a stranger's own topic. Here it is never
public (see "The SES events function" below).

## What was built

### The campaign service (beside the Desktop, never in it)

`src/lead-signup/` is unchanged in shape from 2026-10-13: sign-up, scanner-safe confirmation, counts, bounces,
and the content check. It has these changes and additions.

**Program keys.**

- The keys are now `longevity-program`, `weight-loss-program` and `diabetes-program`, equal to the funnel
  pages' `updates.programKey`.
- The 2026-10-13 list used `weight-loss-peptide-program`, which no funnel slug matched, so the weight loss
  page would never have shown its link.

**Sending settings, no defaults** (`send-settings.ts`, `CAMPAIGN_SEND_SETTINGS` in the contract).

| Setting | Meaning |
| --- | --- |
| `CAMPAIGN_SENDING_SUBDOMAIN` | Mail is sent from `updates@<subdomain>`. |
| `CAMPAIGN_FROM_NAME` | The sender name. |
| `CAMPAIGN_MAILING_ADDRESS` | The physical mailing address. |
| `CAMPAIGN_TRACKING` | `on` or `off`, chosen explicitly. |
| `CAMPAIGN_APPROVED_TEXT_VERSION` | Must equal `CAMPAIGN_TEXT_VERSION`, currently `lead-signup-text/1`. Changing the wording means a new version and a new approval. |

While any of these is unset, malformed or unapproved:

- the service starts, so it can report;
- `/signup/<program>` says "not open yet" and shows no form;
- a posted form sends nothing;
- no mailer exists;
- `/internal/counts` reports `sending: { ready: false, missing: [<names>] }`, names only.

The wiring values (keys, Dittofeed, the stats token, the SES region and marketing configuration set) are
still required to start, and the clinical `alp-transactional` set is still refused.

**The confirmation link is encrypted** (AES-256-GCM), not only signed. It travels as a query string, so a
load-balancer access log must learn neither the address nor which program it asks about.

**Content check** (`campaign-content.ts`).

- **The only address.** An email may link only to its program's own page with `?via=email`, built by
  `programPageEmailUrl`. Not even the consult page appears: the page's button is the email consult link.
- **Refused:**
  - another program's page;
  - any value but the first name;
  - an unfilled `[[…]]` slot;
  - a claim to treat or heal;
  - the funnel text rules.

**The SES events function** (`bounces.ts`, `ses-events-lambda.ts`).

- **Delivery.** It is subscribed to the marketing topic with the **Lambda protocol** and accepts the one
  configured topic only.
- **Order.** For each event it removes the address on a hard bounce or complaint, **then** relays the
  notification to Dittofeed's webhook on the private network, rebuilt as SNS would have posted it. That
  keeps Dittofeed's delivered and bounced totals.
- **Failures.** A failure in either step throws, so the invocation is retried, and lands on the dead-letter
  queue after two retries.
- **Secrets.** The function's two secrets are read from Secrets Manager at start, never placed in its
  environment.

**Starter sequences, all draft.**

- **What exists.** `starter-sequences.ts` holds, for each program, a three-email welcome sequence (on
  confirmation, then 3 and 7 days later) and one broadcast template.
- **The reviewable file.** `docs/campaign-starter-sequences-DRAFT-2026-10-14.md` is generated from it, and a
  test fails if they differ.
- **The checks.** Every welcome email passes the content check; each broadcast template is refused for
  exactly one reason, its unfilled update slot.
- **Approvals.** The weight loss and diabetes sequences name the attorney as a required reviewer.

### Written as deployable code, not applied

`infra/lead-campaigns/campaigns-stack.json` is CloudFormation, the repository's existing pattern: 83
resources. `cfn-lint` passes under both 1.57.2 and CI's 1.55.0, and CI now lints it.

**Its own network.**

- One VPC, two public and two private subnets, and one NAT.
- No peering, transit gateway, VPN, endpoint service or resource share.
- Every route is to the internet only. No value in it names anything clinical (asserted).

**Pinned.**

- Dittofeed lite at `v0.23.0`, Temporal at `1.22.4` and ClickHouse at `24.12.6.70-alpine`, each also
  accepted as an ECR mirror pinned by digest.
- The sign-up image is accepted only by digest.

**The parts.**

- **Postgres 15.18 on RDS.** Encrypted, private, deletion-protected, snapshot on delete or replace, with
  automated backups for `BackupRetentionDays`, 35 by default.
- **ClickHouse on Fargate.** Its data is on encrypted EFS, which is retained.
- **Temporal and Dittofeed on Fargate,** found through a private DNS namespace (`campaigns.internal`).

**Backup plan.**

- An AWS Backup vault and a daily plan, kept `BackupRetentionDays`, covering the database and the ClickHouse
  volume.
- EFS's own backup policy is also on.
- Secrets are retained on delete.

**Public surface.**

- **The load balancer.** One HTTPS listener (TLS 1.3 policy) whose default answer is 404.
- **Forwarded.** Only `/signup`, `/signup/*`, `/confirm`, Dittofeed's `/dashboard/public/subscription-management`
  pages with their static assets, and `/api/public/subscription-management/*`.
- **Never public.** The dashboard, its sign-in, Dittofeed's write-key API and its SES webhook.
- **The counts endpoint** (`/internal/counts`) is forwarded only from `CountsReaderCidr`, the Desktop
  server's egress range, and still needs the bearer token. Empty by default, which means unreachable.

**SES.**

- **The configuration set.** A separate marketing set, never `alp-transactional`, with BOUNCE and COMPLAINT
  suppression.
- **The identity.** A marketing identity created only once `SendingSubdomain` is set.
- **Events.** An encrypted SNS topic that only SES in this account may publish to. Open and click events are
  recorded only when `CampaignTracking` is `on`.

**IAM.**

- **Send-only access.** Dittofeed's SES user and the sign-up task role may each only `ses:SendEmail` and
  `SendRawEmail`, on the marketing identity and configuration set, and only from the subdomain.
- **No access key** is created by the template; the native AWS owner makes one and enters it in Dittofeed.
- **No wildcard actions.**

**Off until raised.**

- `DesiredTaskCount` defaults to 0, so applying the template starts nothing.
- Brandon's settings are parameters that default to empty, so the service sends nothing until each is
  decided.

**Builds.**

- `npm run build:lead-campaigns` (`scripts/build-lead-campaigns.mjs`) bundles the sign-up service and the
  events function.
- It **refuses** any input outside `src/lead-signup/`, the lead-campaigns contract and the funnel text rules.
- `infra/lead-campaigns/lead-signup.Dockerfile` packages the service.
- `compose.override.yaml` is kept for local use, updated to match.

### The Campaigns screen

Unchanged in place (`/campaigns`, under Business) and now:

- shows whether sending is on, naming each missing setting (never a value);
- says "No one has confirmed a subscription yet" when every list is empty;
- keeps "can't reach the campaign service" and "not configured" as separate screens.

## Settings added (campaign service; none in the Desktop)

| Setting | Default | Meaning |
| --- | --- | --- |
| `CAMPAIGN_SENDING_SUBDOMAIN` | unset | Marketing sending subdomain (Brandon) |
| `CAMPAIGN_FROM_NAME` | unset | Sender name (Brandon) |
| `CAMPAIGN_MAILING_ADDRESS` | unset | Mailing address in every email (Brandon) |
| `CAMPAIGN_TRACKING` | unset | `on` or `off` (Brandon) |
| `CAMPAIGN_APPROVED_TEXT_VERSION` | unset | Must equal `lead-signup-text/1` once Brandon approves the sign-up text |
| `LEAD_SES_EVENTS_TOPIC_ARN`, `LEAD_SIGNUP_ID_KEY_SECRET_ARN`, `DITTOFEED_API_KEYS_SECRET_ARN` | unset | The events function's wiring |

The Desktop-side settings from 2026-10-13 are unchanged: `CAMPAIGN_STATS_URL`, `CAMPAIGN_STATS_TOKEN` and
`CAMPAIGN_DASHBOARD_URL`. The funnel link's `CAMPAIGN_SIGNUP_ORIGIN` is workstream 1's.

## Tests (fictional addresses only)

**`src/lead-signup/lead-signup.test.ts`** (21). The 2026-10-13 cases, updated, plus:

- sending settings with no defaults, each named when missing or malformed;
- the "not open" page and a form that sends nothing;
- counts that name missing settings without values;
- the From address on the subdomain;
- the encrypted token refusing altered and truncated links;
- the content check:
  - the program page with `?via=email` only;
  - the consult page and another program's page refused;
  - treat or heal claims refused;
  - unfilled slots refused;
- the relay: after the removal, the SNS shape, a failure throws, unsigned records refused;
- the internal-only relay address;
- the events function's secret reads.

**Other files.**

- `src/lead-signup/starter-sequences.test.ts` (5): drafts, the content check per email, broadcast slots, the
  forbidden words, and the file matching its source.
- `src/lead-signup/campaigns-infrastructure.test.ts` (13): the properties listed above, asserted on the
  template.
- `src/lead-signup/lead-signup-bundle.test.ts` (1): both bundles build from the campaign code alone, and the
  server bundle names nothing clinical.
- `src/components/campaigns/CampaignsScreen.render.test.ts` (+2) and
  `src/server/campaigns/campaign-status.test.ts`, updated for the contract.

## Verification

- **Unit suite.** `npm run test:unit`, full run on this branch: 553 files, 8,750 tests; 8,739 passed,
  11 skipped (the existing declared skips), 0 failed.
- **Typecheck and lint.** `tsc --noEmit` clean, and `eslint` clean on every changed file.
- **Clinical build.** `APP_EDITION=clinical NEXT_PUBLIC_USE_LIVE_API=true npm run build` passes.
- **Template lint.** `cfn-lint infra/lead-campaigns/campaigns-stack.json` is clean under 1.57.2 and under CI's
  pinned 1.55.0.
- **Builds.** `npm run build:lead-campaigns` builds both bundles.
- **Browser battery.** Run once on the integration branch (workstream 7).

## Not verified

- **Nothing was run.** No Dittofeed, Temporal, ClickHouse or Postgres instance was run, so none of the following
  has been exercised:
  - the endpoint shapes: `identify`, `track` with `DFSubscriptionChange`, `users/count`, `broadcasts`,
    `analysis/summary`, and the webhook relay;
  - whether Dittofeed accepts SNS notifications relayed from a Lambda record (the signature should still
    verify, since the signed fields are unchanged; not shown);
  - Temporal's `auto-setup` image without the dynamic-config mount the compose file uses;
  - the dashboard's public pages behind a path-routed load balancer.
- **No AWS was touched.** No SES, SNS, IAM, ECS, RDS, DNS or ACM was touched, the template was never
  deployed, and SES production access is still pending.
- **Images are not built.** The sign-up image and events bundle are not built into anything deployable. The
  `node:22-alpine` base is pinned by tag, not digest, until it is mirrored.
- **Text and consent wording are drafts.** That covers the consent line, the sign-up and confirmation pages,
  the confirmation email and all twelve starter emails.

## Stopped for approval or capability

1. **Every word sent is unapproved.**
   - Brandon must approve `lead-signup-text/1` (consent line, pages, confirmation email) and the starter
     sequences.
   - His attorney must also approve the weight loss and diabetes sequences.
2. **Brandon's sending decisions** are not made: the subdomain, from name, mailing address and tracking.
3. **SES production access** is pending.
4. **RFC 8058 one-click POST** behaviour of Dittofeed's unsubscribe link is unconfirmed (see above).

## For the native AWS owner, in order

1. **Review the template.** Mirror the images into ECR by digest. Build the sign-up image and the events zip.
2. **Apply in a non-production account** with `DesiredTaskCount=0`.
   - Start Dittofeed once with `DittofeedBootstrap=true`, then set it to `false`.
   - Create three **opt-in** subscription groups, the write and admin keys, and the SES provider with the
     send-only user's key.
   - Fill `DittofeedApiKeysSecret`, the workspace and group parameters, and `CountsReaderCidr`.
3. **Desktop wiring.**
   - Set `CAMPAIGN_STATS_URL=https://<host>/internal/counts`, `CAMPAIGN_STATS_TOKEN` and `CAMPAIGN_DASHBOARD_URL`
     on the Desktop.
   - Set `CAMPAIGN_SIGNUP_ORIGIN` on the Desktop only after sending is ready.
4. **Hosted tests with fictional addresses:**
   - sign-up, confirm, the first welcome email, then unsubscribe;
   - SES simulator bounce and complaint;
   - a forged SNS post to the public host answers 404.
