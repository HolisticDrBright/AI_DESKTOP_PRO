# The campaign engine, built into Desktop (marketing wiring, workstream 2) — 2026-10-15

**Branch:** `claude/campaign-engine-20261015`.

**Base.** The branch is cut from workstream 1's revised head (`3f2b8bbe`), not the bare base, on purpose. The
"Get updates" link (WS1) and the `/join` sign-up page (here) are two ends of one link, and the handoff makes each
depend on the other. On this branch, WS1's link directory is replaced by the engine's answer.

**Supersedes** `claude/campaign-service-20261014` (Dittofeed, built before the handoff was revised on 2026-10-14).
That branch stays pushed for the record and is not part of the integration line.

This is the commercial side. Nothing here reads, imports or names anything clinical. Nothing was deployed, applied,
verified at a DNS provider, or sent.

## The design as built

### Where it runs

The engine is its own small service inside Desktop Pro's AWS account:

- one DynamoDB table;
- one HTTP API;
- three Lambdas: `api`, `sender` and `events`;
- two SES configuration sets;
- one SNS topic;
- one schedule.

All of these are in `infra/campaigns/campaign-engine.json`, linted with cfn-lint 1.57.2 and with CI's 1.55.0, and not
applied.

The Desktop web tier only forwards, for two reasons:

- the Desktop host (App Runner) has no AWS role;
- the clinical pattern already reaches its data through an API with a JWT authorizer.

The engine's code is `src/campaigns/`. Its bundles are built by `npm run build:campaign-engine`, and a test proves
they contain nothing clinical.

### The store: its own DynamoDB table (proposed, for the reviewed schema process)

**Why DynamoDB.**

- **Separate from the clinical data plane.** The table is a different AWS service with its own key, its own
  roles and no network path to RDS.
- **No migration ledger.** Item shapes are versioned in code (`campaign-engine/1`).
- **What the engine needs is native:**
  - conditional writes, used for idempotent sends and version checks;
  - transactions, used for the allowance and list counters;
  - TTL, used to delete unconfirmed addresses after 7 days;
  - a sparse index, used to find what is due.

**Keys.**

- `PK = P#<practice id>` for every practice-scoped item, and `G` for three global records:
  - the sign-up slug index;
  - the allowances data;
  - the list of practices holding the marketing entitlement.
- `SK = <kind>#<id>`.
- The `due` GSI is (`duePK = P#<practice>#<kind>`, `dueAt`).

**Practice separation is structural.** Every practice-scoped access goes through `store.practice(id)`, a handle with
no method that takes another practice id. A test captures every DynamoDB command the handle issues and finds only its
own partition.

**Protection.** Point-in-time recovery, a customer-managed KMS key, deletion protection and `Retain`.

### Getting on a list

1. **`/join/<practice>/<program>`.** A plain server-rendered form:
   - no script;
   - email, an optional first name, the program, and an unticked consent line (`campaign-consent/1`, a draft);
   - no health questions or free text.

   The page exists only while the engine is on and the practice holds the entitlement and can send.
2. **The post.** It goes to `POST /api/public/campaigns/join` (same-origin only, fixed fields only), then on to the
   engine. The answer is always "check your email", whether the address is new, waiting, confirmed, suppressed, or a
   bot. Bot protection is a hidden field plus a sealed form time (under 3 s or over 24 h does nothing). The engine
   also has silent ceilings: 300 per practice per hour, and 3 per address per day.
3. **Confirmation.** The confirmation email is the only thing sent before a click.
   - Its link (sealed, purpose-bound, 48 hours) shows a button.
   - Only the button's POST confirms, so a mail scanner that opens links confirms nobody.
   - An unconfirmed address is deleted after 7 days (TTL).
4. **The contact allowance.** A new address counts against the tier's allowance inside the same transaction as the
   confirmation. When the allowance is reached, the click is refused with a clear message, and nobody already on a
   list is dropped. The same address on a second list does not use a second place.

**People who send a consult request are not added to any list.** Nothing in the engine reads the consult side.

### Sending

- **Sequences** are ordered steps (an email, then a wait of N days).
  - A sequence starts at confirmation and stops on unsubscribe, bounce or complaint.
  - **Editing an active sequence changes only what people have not reached yet.** Steps keep their ids, and a person's
    position is their last sent step in the current sequence. A step added before it is never sent to them; an edited
    later step is what they receive.
- **Broadcasts** go to a list now or at a set time.
  - They need an approved email and a test send of that exact version to the staff member first.
  - Each reaches every person confirmed before it was due, once each.
  - A broadcast can be cancelled.
- **The job.** One pass every 5 minutes (EventBridge Scheduler `rate(5 minutes)`, state `DISABLED` by default).
  - **Why not one schedule per person.** That would mean thousands of schedules per practice, each created, moved and
    deleted on every sign-up, edit and unsubscribe, against Scheduler's schedule and API-rate quotas. One pass reads
    the sparse due index; an unsubscribe only clears an item.
  - **Never twice.** A create-only claim is written for exactly that send before SES is called.
    - An SES error answer releases the claim and a later pass retries.
    - No answer (a timeout) keeps the claim and is never retried; it is counted as `unknown`.
    - Concurrency is also held to 1.
  - **Rate.** Paced to the account's SES rate (`GetAccount`), and capped by the tier's monthly email allowance.
  - **Hours.** Only 08:00 to 20:00 in the subscriber's zone. A subscriber's own zone is not collected, so the inferred
    zone is the practice's.
- **Every email carries:**
  - the footer (why the reader gets it, the sender name, the mailing address, the unsubscribe link);
  - `List-Unsubscribe` and `List-Unsubscribe-Post: List-Unsubscribe=One-Click`.

  Its only links are the program page with `?via=email` and the unsubscribe page.

### Unsubscribe, bounces and complaints

- **The footer link** (`/join/unsubscribe?t=…`) takes effect on the click.
- **The one-click route** (`POST /api/public/campaigns/unsubscribe?t=…`, exactly `List-Unsubscribe=One-Click`, from
  any origin, as RFC 8058 requires) takes effect at once.
- **Bounces and complaints.** SES events reach the `events` Lambda by SNS (Lambda protocol: no public endpoint), and
  only from the configured topic. A permanent bounce or a complaint removes the address from every list of that
  practice, records a suppression so a later sign-up sends nothing, and counts per email.
- **Second stop.** Both configuration sets also suppress BOUNCE and COMPLAINT at the account level.

### Templates, approval and the content check

- **The email format.**
  - Block-based: heading, paragraph, button, and an image hosted by Desktop.
  - A button always leads to the program page.
  - The only merge field is `{{first_name|fallback}}`.
- **The check** reuses the funnel's refused phrases (`funnelTextIssue`): addresses, doses, drug and brand names,
  cure, reverse and guarantee, promised amounts, added years. It adds:
  - treat and heal claims;
  - any other merge field;
  - unfilled `[[…]]` slots;
  - no button.
- **Approval** is by a named staff member with the marketing role, for an exact version. It is blocked by the check,
  and by a practice with no sender name or mailing address. For a program the operator marks (Brandon's practice:
  weight loss and diabetes), it also needs an attorney's sign-off recorded for that version. Any edit makes a new
  version in draft.
- **Starter content.** For each program, three welcome emails and one broadcast template, installed as drafts. The
  reviewable file is `docs/campaign-starter-sequences-DRAFT-2026-10-15.md`, pinned to the source by a test
  (`UPDATE_CAMPAIGN_DRAFTS=1` regenerates it). The welcome emails pass the check as written; the broadcast's
  `[[…]]` slot does not.

### Sending domains, per practice, and SES tenants

- **Setting up a domain.** A marketing admin enters a domain or subdomain. The engine then:
  - creates the practice's **SES tenant**;
  - creates a domain identity **tagged `alp-purpose=marketing`** (the IAM send policy requires that tag);
  - sets the custom MAIL FROM `bounce.<domain>`;
  - associates the identity and both marketing configuration sets with the tenant.
- **The DNS records** shown to the practice are three DKIM CNAMEs, the MAIL FROM MX and SPF, and a starting DMARC
  record.
- **Sending waits** until SES reports the identity verified ("Check again" re-reads it).
- **Every send names the practice's tenant.**

### Entitlement, roles and allowances

- **The `marketing` entitlement** (Growth, Complete, or the add-on) is a record per practice, written only by the
  operator functions (`src/campaigns/operator.ts`), never by a route.
  - Without it, the Campaigns screen shows what the package does, and nothing can be edited or sent.
  - The sign-up page does not exist, and no program page links to it.
- **Allowances are data**, loaded by the operator, never written in code: contacts and emails per month per tier.
- **Roles** are the engine's own (`marketing`, `marketing_admin`), granted per person. No clinical role or membership is
  read.
  - Counts are visible to the practice's staff.
  - Addresses, editing and approval need the marketing role, and granting roles needs `marketing_admin`.
  - The first admin is granted with the entitlement.
- **Export is off.**

### The Campaigns screen (Business → Campaigns)

The screen is editable:

- settings (no defaults);
- the domain, with its DNS records and status;
- lists, with counts and addresses for the marketing role;
- emails, with the block editor, check, attorney sign-off and approve;
- sequences, with steps, waits, start and pause, and installing the starter drafts;
- broadcasts, with test send, schedule and cancel;
- results;
- roles.

These states each look different:

- switched off;
- loading;
- a failed read ("not the same as having no subscribers");
- refused;
- not entitled;
- a read of zero ("No subscribers yet").

A practice's opens and clicks are counted only when it turns that on, never per person, and shown as totals.

## Settings and their defaults

| Setting | Where | Default |
| --- | --- | --- |
| `CAMPAIGN_ENGINE_ENABLED` | Desktop server, and every campaign Lambda (template parameter `CampaignEngineEnabled`) | `false` |
| `CAMPAIGN_API_ORIGIN` | Desktop server | unset |
| `FUNNEL_PRACTICE_SLUG` | Desktop server: which practice's `/join` page the program pages link to | unset |
| `SendScheduleState` | template | `DISABLED` |
| `SiteOrigin`, `FromLocalPart` | template | empty (Brandon chooses) |
| Practice sending domain, sender name, mailing address, time zone, sign-up slug | per practice, in the engine | none |
| Open and click counting | per practice | off |
| The `marketing` entitlement and the tier | per practice, operator data | not held |
| Contact and monthly email allowances | operator data | not loaded (nothing confirms or sends) |

**With every setting off, the app behaves exactly as before.** The `/join` pages and the three public routes answer
not-found, the staff route answers not-found, no program page shows the link, and the screen says the engine is off.
The tests for this are `campaign-routes.test.ts` (switched off), the `signup.test.ts` disabled case, and the template
test.

## Tests (fictional practices, people and addresses only)

| Path | Where |
| --- | --- |
| Sign-up, confirmation, expiry, the same answer, bots, rate | `src/campaigns/signup.test.ts` (14) |
| Sequence timing and idempotency, broadcast, quiet hours, pacing, the monthly cap, SES failure | `src/campaigns/sending.test.ts` (12) |
| The content check, approval rules, attorney sign-off, roles, the entitlement gate, rendering, starter drafts | `src/campaigns/content.test.ts` (11) |
| Practice separation (lists, emails, results, tokens, suppression, stored keys, DynamoDB commands), and no clinical imports or names | `src/campaigns/separation.test.ts` (9) |
| Bounces and complaints, opens and clicks only when on, API routes and claims, the SES port at its SDK boundary | `src/campaigns/events-and-routes.test.ts` (10) |
| The Lambda bundles reach nothing clinical | `src/campaigns/bundle.test.ts` (3) |
| The template: off by default, the store, send-only-marketing IAM, no clinical names | `src/campaigns/infrastructure.test.ts` (5) |
| The Desktop routes: off, form post, one-click, staff route, the "Get updates" directory | `src/app/api/public/campaigns/campaign-routes.test.ts` (9) |
| The screen and the public pages as rendered | `src/components/campaigns/CampaignsView.render.test.ts` (7) |
| The public allow-list and route count | `src/middleware.test.ts` (+1), `src/lib/funnel-headers.test.ts` (updated) |

## Gate results (this branch, before commit)

| Check | Result |
| --- | --- |
| Unit suite (`npm run test:unit`) | 561 files passed; 8,801 tests passed, 11 skipped (the existing declared skips) |
| Typecheck (`tsc --noEmit`) | clean |
| ESLint, every changed or new file, `--max-warnings=0` | clean (50 files) |
| Build (`APP_EDITION=clinical NEXT_PUBLIC_USE_LIVE_API=true npm run build`) | compiled; one unused-import warning, since fixed (`dynamo-store.ts`) and re-linted |
| Lambda bundles (`npm run build:campaign-engine`) | three artifacts in `dist/campaigns/` (ignored by git) |
| `cfn-lint` 1.57.2 and 1.55.0 on `infra/campaigns/campaign-engine.json` | clean |

The ordered end-to-end battery runs once, on the integration line (workstream 7). This branch adds no spec.

## What was verified about SES

**Read from the SDK, `@aws-sdk/client-sesv2` 3.1124.0 (pinned).**

- `CreateTenant`, with tenant-level suppression attributes.
- `CreateTenantResourceAssociation` for identities and configuration sets.
- `SendEmail` with `TenantName`, which succeeds only if every referenced resource is associated with the tenant.
- Per-resource reputation entities with an SES-managed and a customer-managed sending status.
- `Content.Simple.Headers` for custom headers, used here for the one-click unsubscribe headers.

**From AWS's pages (2025-08 announcement; the SES developer guide on tenants; the `CreateTenant` reference).**

- Tenants isolate sending reputation per tenant.
- Automatic reputation policies can pause one tenant without affecting others.
- EventBridge reports tenant status changes.
- The quota is 10,000 tenants per account, as AWS's blog states; this was not checked against the live quotas page.

**Not verified.**

- **No AWS call was made.** No tenant, identity, configuration set or schedule exists.
- **The exact IAM resource ARN that `SendEmail` authorizes for a tenant** is assumed to be `tenant/alp-practice-*`
  and was not confirmed. The domain-management policy also relies on `aws:RequestTag` and `aws:ResourceTag` support
  for SES identities. Both need the native AWS owner's check before apply.
- **Deliverability, DKIM verification timing and SES production access.** Production access is still pending.
- **RFC 8058 behaviour at real mailbox providers.**

## Stopped (content, approval or a confirmed capability)

1. **Wording.** The consent line, the confirmation email, the footer sentence and every starter email are drafts for
   Brandon. The weight loss and diabetes emails also need his attorney.
2. **The Complete tier's monthly email allowance** is not stated in "Desktop Pro and V2 Tiers". That document gives
   10,000 contacts and 50,000 emails a month for the add-on (and so Growth), and 25,000 contacts for Complete.
   Allowances are data, and none is loaded; the operator loads them once Brandon gives the Complete figure.
3. **Image upload** for the image block is not built. The block accepts only a Desktop-hosted
   `/campaign-images/<practice>/<sha256>` path, and no upload route or bucket exists yet.
4. **Program pages per practice.** Emails link to `/learn/<program>?via=email` on the Desktop origin. Today those pages
   are Brandon's practice's and all three are `draft`, so every link answers not-found until they are published. Pages
   for other practices are a later piece.
5. **The operator CLI** (granting entitlements and loading allowances with the table's credentials) is source only
   (`src/campaigns/operator.ts`), and no script wraps it. It belongs with the native AWS owner's apply.
6. **AWS:** applying the template, the secret, SES production access, and confirming the tenant ARN as above.
