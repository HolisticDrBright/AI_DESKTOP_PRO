# Email campaigns for program leads: design and source (2026-10-13)

Branch `claude/lead-campaigns-20261013`, from the integration head `07a5a9ca`. Design and source only:
nothing deployed, no AWS resource, DNS change, vendor sign-up, list import or send. The lesson-media
and patient-notification branches are untouched. No Mautic or listmonk code; nothing of Dittofeed's
source is copied in (one compose overlay names its pinned image).

Patients are not the audience: this is for people who asked to hear about a program. Patient
reminders and notices go out from the clinical side (`docs/claude-patient-notifications-2026-10-13.md`)
and share nothing with this service.

## What was verified about Dittofeed (2026-10-13)

The checks below come from the repository and from its documentation source files
(`packages/docs/*.mdx`, which docs.dittofeed.com renders). They were read as raw files, because
docs.dittofeed.com itself was blocked from this environment. Nothing was installed or run.

| Question | Finding |
| --- | --- |
| Licence | `LICENSE` is MIT, "Copyright (c) [2023] [Idea Market inc.]". The public repo has no `ee/` directory. Multi-tenancy, embedding and white-labelling are a separate closed-source image (`dittofeed/dittofeed-ee`), obtained from support. Not planned on. |
| Dashboard sign-in | There are three modes. **Anonymous** is the default and not for production. **Single-tenant** is one shared password (`AUTH_MODE=single-tenant`, `PASSWORD`, `SECRET_KEY`), and the docs say it is "only available with dittofeed-lite". **Multi-tenant (OIDC/SSO)** is EE or cloud only. So the open-source build has no per-person sign-in: keep the dashboard off the internet. The lite compose defaults `PASSWORD: password`, and the overlay makes it a required value. |
| Minimum resources | No documented minimum. The defaults are: lite container 1024 MB (Node heap 824 MB), ClickHouse 2048 MB, Postgres and Temporal unbounded; Helm sets the app at 1 CPU / 512 Mi and ClickHouse at 1024 Mi. Plan for at least 4 GB of RAM in total; that is an estimate, not a documented figure. |
| Temporal | Required in every documented deployment: lite compose, Helm and Render. The Docker Compose doc page omits it, but its compose file runs it. "Lite" is one app container that still needs Postgres 15, ClickHouse and Temporal beside it. |
| Confirm step | There is no built-in double opt-in. It can be built: **opt-in** subscription groups start empty, and a user is subscribed by the `DFSubscriptionChange` track event (public write key) or the admin assignments API. As built here, the confirmation is sent by our own sign-up service before Dittofeed knows the person. |
| Unsubscribe | Templates have `{% unsubscribe_link %}` / `{% unsubscribe_url %}`. The source sets `List-Unsubscribe`, `List-Unsubscribe-Post: List-Unsubscribe=One-Click` and `List-ID`. Unconfirmed: full RFC 8058 POST behaviour. |
| SES | Configured with an IAM access key, secret and region. Bounces and complaints go configuration set → SNS → `https://<dittofeed>/api/public/webhooks/amazon-ses`, and are recorded as `DFEmailBounced` / `DFEmailMarkedSpam`. **No automatic suppression was found in the source**, so this build adds its own (below). |
| Counts | Admin API (`Bearer` key; **no read-only scope documented**): `POST /api/admin/users/count` with `subscriptionGroupFilter`, `GET /api/admin/broadcasts`, `GET /api/admin/analysis/summary` (deliveries, sent, opens, clicks, bounces — **no unsubscribe count**). |
| Release | Latest stable `v0.23.0` (1 Dec, year not shown on the page, probably 2025); newest tag `v0.24.0-alpha.21` (pre-release). Pin `v0.23.0`. Text messages are Twilio-only (phase 2). |

## The design as built

### The campaign service (beside the Desktop, not in it)

`src/lead-signup/` is a small node:http service deployed with Dittofeed (`server.ts`). It imports nothing clinical and nothing in the Desktop imports it; a test asserts both directions.

- **Sign-up** (`GET /signup/<program>`, `POST /signup`):
  - The form asks for an address, an optional first name, and has an unticked consent line naming the program and that they can stop at any time.
  - No health questions and no free text. No script, image or third-party request; a strict CSP.
  - A valid sign-up emails one confirmation link and **stores nothing**. The page is identical for every address, so it never reveals who is on a list.
  - A send failure says so, and that nothing was saved.
- **Confirmation** (`GET` then `POST /confirm`):
  - The link carries a signed, 72-hour statement of what was asked for: address, name, program and consent version.
  - Opening it shows a button. Only the button confirms, so a mail scanner that follows links cannot confirm for the reader.
  - Confirming identifies the person in Dittofeed under a keyed hash of the address, with a consent trait (version and time). It then subscribes them to that program's **opt-in** group, using the public write key only.
  - Forged, altered and expired links confirm nothing. A Dittofeed outage is shown as one.
- **Unsubscribe:** Dittofeed's own link and one-click headers in every email. `campaign-content.ts` is a check every campaign email must pass before it is scheduled:
  - an unsubscribe tag, the sender name and the mailing address;
  - the funnel text rules;
  - no other address than the consult page;
  - no personal value but the first name.
- **Bounces** (`bounces.ts`):
  - An SNS-subscribed function accepts one configured topic. Permanent bounces and complaints unsubscribe the person from every list; soft bounces do not.
  - A Dittofeed failure throws, so SNS retries rather than losing the removal.
  - The SES configuration set's own suppression (BOUNCE, COMPLAINT) is the second, independent stop.
- **Counts** (`GET /internal/counts`):
  - Bearer token, private network. Returns confirmed counts per list and recent send totals; never a person.
  - The Dittofeed admin key stays inside this service.
- **Configuration:** the service refuses to start without every value. It also refuses:
  - the same key for links and ids;
  - an `http` origin;
  - the clinical `alp-transactional` SES configuration set.

### Inside the Desktop

- **Funnel link:**
  - With `LEAD_SIGNUP_ORIGIN` set, each funnel's closing section gains "Get updates about this program", pointing to that program's sign-up page.
  - The new test pins the outbound addresses to exactly the consult page and the sign-up page, or those plus the buy page when a purchase is available (the buy link arrived after the handoff was written).
  - The page still has no form and makes no cross-site request.
  - Without the setting, the existing test (consult address only) still holds.
- **Campaigns screen** (`/campaigns`, under Business in the Sidebar):
  - Read-only, behind sign-in. The server route reads the counts endpoint with a token the browser never sees.
  - Shows each program list's confirmed count, recent sends with delivered and bounced totals, unsubscribes as **Unknown** (Dittofeed does not report them), and a link to the dashboard.
  - "Not configured", "unreachable" and "empty" are three different screens.
- **Consult requesters are not added**, and the service never learns who became a patient.

### Deployment overlay

`infra/lead-campaigns/compose.override.yaml` overlays Dittofeed's own `docker-compose.lite.yaml` at `v0.23.0`:

- The dashboard is bound to localhost and its password is required.
- It adds the lead-signup service.
- The only public paths should be `/signup`, `/confirm` and Dittofeed's SES webhook.

## Tests (fictional addresses only)

- `src/lead-signup/lead-signup.test.ts`:
  - sign-up (form, refusals, nothing stored, same page, mail failure);
  - confirmation (scanner-safe, program-only, consent version, forged/altered/expired, outage);
  - counts token;
  - bounces (hard, complaint, soft, wrong topic, retry);
  - the exact Dittofeed calls (write key only);
  - campaign email checks;
  - configuration refusals;
  - the import boundary.
- `src/components/funnels/FunnelPage.render.test.ts` (new case) and `src/lib/leadSignupUrl.test.ts`.
- `src/server/campaigns/campaign-status.test.ts` and `src/components/campaigns/CampaignsScreen.render.test.ts`.

## What was not verified

- **No Dittofeed instance was run.** The endpoint shapes are from its documentation source and have not been exercised:
  - `identify`, `track` with `DFSubscriptionChange`;
  - `users/count` with `subscriptionGroupFilter`;
  - `broadcasts`, `analysis/summary`.

  The same goes for the compose service names, one-click unsubscribe, and how an opt-in group appears in its UI.
- **No SES, SNS, DNS or IAM was touched.** The sending subdomain, the marketing configuration set and its suppression, the SNS subscriptions, and SES production access (still pending) do not exist.
- **The sign-up service has not been built into an image or served behind TLS.** Rate limiting is not built and belongs at the proxy.
- **Text and consent wording are drafts.** Nothing is sent until Brandon approves the exact text; the weight loss and diabetes sequences also wait for his attorney.

## Codex inputs (native AWS owner), in order

1. **SES:** a dedicated sending subdomain identity, and a marketing configuration set with BOUNCE and COMPLAINT suppression. Its event destination is one SNS topic with two subscribers: Dittofeed's webhook, and the bounce function.
2. **IAM:**
   - a send-only key for Dittofeed, scoped to the marketing identity;
   - a send-only role for the sign-up service.
   - Never a clinical role.
3. **Host:** Dittofeed `v0.23.0` lite plus Postgres, ClickHouse and Temporal, with backups; the lead-signup image; a TLS proxy exposing only the public paths.
4. **Dittofeed setup:** three opt-in subscription groups; write and admin keys into the service's secret store; the Desktop's `CAMPAIGN_STATS_URL`, `CAMPAIGN_STATS_TOKEN` and `CAMPAIGN_DASHBOARD_URL`, and the funnels' `LEAD_SIGNUP_ORIGIN`.
5. **Hosted tests** with fictional addresses: sign-up → confirm → one broadcast → unsubscribe; SES simulator bounce and complaint.

## Decisions for Brandon

1. The public web address, shared with the funnels.
2. The sending subdomain and the "from" name.
3. The mailing address printed in every email.
4. Whether open and click tracking are on (a Dittofeed setting applied at send time; the content check governs only the template text).
5. Whether texts are wanted enough to add Twilio later.
6. The consent line and confirmation email wording (drafts in `src/contracts/leadCampaigns.ts` and `src/lead-signup/pages.ts`).
