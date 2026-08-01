# Phase 8B — plans, packages, memberships, entitlements & reconciliation

The financial continuation of Phase 8A:
`plan/package creation → purchase or authorized complimentary assignment →
payment/subscription → entitlement ledger → appointment redemption →
renewal/failure/cancellation → reconciliation → reporting`.

**Status: complete for this phase.** Database, Stripe boundary, adapter,
routes, webhook receiver, UI, and proofs are all built and verified. What
remains genuinely unavailable is listed at the end — chiefly that no real
Stripe API transaction has been executed, because no test credentials exist in
this environment.

---

## What Phase 8A actually exercised with Stripe

Nothing. Phase 8A made **no Stripe API request and verified no signed
webhook**: there is no `stripe` dependency, no call to `api.stripe.com`, and no
signature verification anywhere in that phase. What it shipped is the
persistence and ingest boundary — payment/refund/webhook tables, the settlement
state machine, dedup and agreement rules, and `service_role`-only RPCs — proven
with deterministic fixtures.

That foundation is real and tested. An operational processor is not, and no
screen may imply otherwise. Phase 8B adds the real adapter, disabled by default.

## Ownership map

| Concern | Owner | Notes |
| --- | --- | --- |
| Invoice, payment, refund, credit, webhook event | **Phase 8A** | Reused. A purchase is an 8A invoice; a subscription charge is an 8A payment |
| Package / membership offering | **8B, extending 0011 in place** | The 0011 tables were empty; extended rather than duplicated |
| `public.subscriptions` (0011) | **Untouched** | That is the *organization's own* SaaS seat licence — a different domain from a patient membership |
| Entitlement + redemption | **8B** | New append-only ledger |
| Processor identifiers | **8B** `processor_customers` | Identifiers only, never card data |
| Reconciliation exceptions | **8B**, referencing 8A rows | Does not copy payments or events |

## Package state machine

```
draft ──publish version──▶ active ──archive──▶ archived
                             │
                             └── new draft version → publish → active (new terms)
```

Archiving never alters historical purchases: an entitlement pins the exact
`package_version_id` it was sold under, and published version terms are
immutable at trigger level.

## Membership subscription state machine

```
incomplete ──▶ trialing ──▶ active ⇄ paused
     │                        │  │
     │                        │  └──▶ past_due ──▶ unpaid ──▶ canceled
     ├──▶ incomplete_expired  │
                              ├──▶ cancel_at_period_end (stays active until period end)
                              └──▶ canceled ──reactivate──▶ active
                                       expired ──reactivate──▶ active
```

Cancelling requires a reason. Pause is only legal from `active`/`trialing`,
resume only from `paused`, reactivate only from `canceled`/`expired` — enforced
in the RPC, not the UI.

## Versioning behaviour

- Commercial terms live on `package_versions` / `membership_versions`, never on
  the plan row.
- Publishing freezes price, currency, terms summary, and version number. A
  published version can only be retired, never returned to draft.
- `plan_acceptances` records the patient's acceptance of an **exact version**
  with a method (`in_person`, `portal`, `signed_document`, `verbal_documented`)
  and a terms snapshot.
- **No retroactive mutation of an accepted plan version** is possible: the
  trigger refuses it even for a definer RPC.

## Entitlement accounting policy

| Event | Movement |
| --- | --- |
| Purchase paid / renewal / complimentary | `grant` → `remaining += n` |
| Booking holds a credit | `reserve` → `remaining −n`, `reserved +n` |
| Permitted cancellation | `release` → `reserved −n`, `remaining +n` |
| Arrival or completion (per org policy) | `consume` → `reserved −n`, `consumed +n` |
| Past `expires_at` | `expire` → `remaining −n`, `expired +n` |
| Purchase refunded | `refund_revoke` → `remaining −n`, `refunded +n` |
| Reasoned correction | `manual_restore` → `consumed`/`expired` −n, `remaining +n` |

Every movement writes an `entitlement_ledger` row in the same statement.

**The identity constraint** `granted = remaining + reserved + consumed +
expired + refunded` means an unbalanced movement cannot commit. This is why the
browser can never assert availability or consumption: it calls an RPC and
renders what comes back.

**Exactly-once guarantees are storage-level, not application-level:**

- `entitlements_membership_period_idx` — one entitlement per (membership,
  period), so a duplicate renewal webhook grants nothing extra.
- `entitlements_invoice_package_idx` — one entitlement per (invoice, package
  version), so re-running the grant is a no-op.
- `entitlement_ledger_one_reserve_per_appointment_idx` — one live reservation
  per (entitlement, appointment), so **concurrent booking cannot consume the
  same credit twice**.

**A refund never recreates a consumed benefit.** `refund_revoke` can only take
back credit that is *still unspent*; a visit already received is never clawed
back, and never silently restored either. Restoring spent credit is
`restore_entitlement`, which requires the refund permission and a reason.

## No-show and late-cancellation policy

Configured per organization in `org_billing_policies` — an explicit decision,
not a default buried in code:

| Setting | Values | Default |
| --- | --- | --- |
| `no_show_policy` | `consume` / `release` / `review` | `consume` |
| `late_cancel_policy` | `consume` / `release` / `review` | `release` |
| `late_cancel_window_hours` | integer | 24 |
| `consume_on` | `arrived` / `completed` | `completed` |

`review` creates a real review-queue task instead of silently choosing.

## Complimentary assignment controls

Requires **all** of: the separate `comp.assign` permission (owner/admin only by
default — practitioners and staff cannot), a reason, the authorizer's identity,
an explicit zero-amount invoice so the gift is visible in the financial record,
and an audit event. Optional expiry supported.

A complimentary assignment confers a **commercial** benefit only. It creates no
clinical order, note, protocol, or eligibility, and it cannot bypass clinical
permissions.

## Permission matrix

Resolution order: explicit per-user grant/deny → explicit per-org role row →
built-in default below. Active membership is required in every case.

| Permission | owner | admin | practitioner | staff |
| --- | --- | --- | --- | --- |
| `billing.view_summary` | ✅ | ✅ | ✅ | ✅ |
| `billing.create_invoice` | ✅ | ✅ | ✅ | ✅ |
| `billing.take_payment` | ✅ | ✅ | ✅ | ✅ |
| `billing.issue_refund` | ✅ | ✅ | — | — |
| `billing.adjust_price` | ✅ | ✅ | ✅ | — |
| `catalog.manage_products` | ✅ | ✅ | ✅ | — |
| `inventory.adjust` | ✅ | ✅ | ✅ | — |
| `plans.manage` | ✅ | ✅ | ✅ | — |
| `comp.assign` | ✅ | ✅ | — | — |
| `reconciliation.resolve` | ✅ | ✅ | — | — |
| `reports.view_org` | ✅ | ✅ | — | — |

Taking cash at the front desk is deliberately not the same authority as issuing
a refund, granting complimentary care, or resolving a reconciliation exception.

**Clinical records are unaffected by financial actions.** Cancelling or
refunding changes no signed note, protocol, laboratory record, or history —
those tables are not written by any RPC in this phase.

**No AI system may** change a price, issue a refund, grant complimentary care,
cancel a membership, alter an entitlement, or resolve a reconciliation
exception. Every one of those RPCs requires `auth.uid()` and a human-held
permission; there is no service-role path to any of them.

## Stripe test subscription setup (variable names only)

| Variable | Purpose |
| --- | --- |
| `STRIPE_TEST_MODE_ENABLED` | Master switch. Absent or not `1`/`true` ⇒ the boundary is disabled and every call reports `not_configured` |
| `STRIPE_TEST_SECRET_KEY` | Test-mode secret. A `sk_live_`/`rk_live_` value is refused as a configuration **error** |
| `STRIPE_TEST_WEBHOOK_SECRET` | Signing secret. Must begin `whsec_` |

No value is ever logged, echoed, or surfaced. Refusals name the *variable*, never its contents.

### Webhook runbook

1. The route reads `await req.text()` **before** any JSON parsing — the raw
   bytes are what the signature covers.
2. `verifyWebhookSignature` checks the timestamp tolerance, then compares every
   `v1` signature in constant time.
3. A verified event whose `livemode` is `true` is **refused** even though the
   signature is valid.
4. The event is recorded in the 8A `billing_webhook_events` ledger, whose
   `unique (provider, event_id)` makes replay a recorded `duplicate` rather
   than a second effect.
5. Amount, currency, organization, patient, plan version and environment must
   agree, or the outcome is a recorded `refused`.
6. An event arriving after a terminal state is a recorded `out_of_order`.

A browser redirect back from Checkout is **never** payment proof. Benefits
follow the verified webhook or an authorized complimentary assignment, nothing else.

### Dunning runbook

Failures create real review-queue tasks, one open task per (type, reference):
`subscription_payment_failed`, `subscription_payment_method_required`,
`membership_expiring`, `package_credits_expiring`, `payment_unreconciled`,
`payment_dispute`, `refund_action_required`, `processor_failure_repeated`.

**No automated patient message is sent.** There is no delivery provider
configured and no approved template; a task tells a human, and the human decides.

## Reconciliation workflow

Exceptions **reference** 8A payments and webhook events rather than copying
them. Resolution requires the `reconciliation.resolve` permission, a reason,
and the expected version; every resolution appends to `reconciliation_events`,
which is append-only.

**Settlement fields are honestly unavailable.** `provider_fee_minor`,
`provider_net_minor`, and `provider_settlement_status` are `NULL` because
balance transactions and payouts are not fetched in this phase, and the read
RPC returns `settlementFieldsAvailable: false` so a UI cannot mistake absence
for zero.

## Operational deployment checklist

1. Apply both 8B migrations; confirm the ledger head matches local filenames.
2. Leave `STRIPE_TEST_MODE_ENABLED` unset for a normal clinical deployment. The
   plan, entitlement, complimentary, and reconciliation features work fully
   without any processor.
3. To exercise test subscriptions, set the three variables above **with
   test-mode values only** and register the webhook endpoint.
4. Set each organization's `org_billing_policies` deliberately — do not rely on
   the defaults.
5. Review the permission matrix per organization; add explicit
   `financial_permission_grants` rows where the defaults do not fit.
6. Confirm advisors report 0 ERRORs after applying.

## Deferred (explicitly not in this phase)

- **Live Stripe activation** — production keys, PCI review, a live-mode
  environment value, and a live signature receiver. The build refuses live
  credentials today by design.
- **Insurance and claims** — no clearinghouse, no claim model.
- **Accounting exports** — no ledger export, no GL integration. Nothing in this
  phase is "recognized revenue", "profit", or an accounting-certified result;
  margin and valuation figures are labelled estimates.
- **Patient-app billing delivery** — no billing document reaches the patient app.

## Dependency audit (reported honestly)

`npm audit --omit=dev` reports **2 high-severity** findings, both pre-existing
and neither introduced by this phase:

- `sharp` — inherited libvips advisories CVE-2026-33327, CVE-2026-33328,
  CVE-2026-35590, CVE-2026-35591
- `next` — high, *via* the same `sharp` dependency

The only offered fix is `next@14.2.35`, a **semver-major downgrade** of the
framework. That is a cross-cutting change well outside a billing phase and
would need its own compatibility pass, so it is reported rather than applied.
Neither advisory is reachable from the code this phase adds: the Stripe
boundary and the plan/entitlement RPCs do no image processing.

## Application surfaces

| Surface | Route | What it does |
| --- | --- | --- |
| Plans workspace | `/settings/plans` | Create offerings, draft and publish versions, set the credit policy. Every version's state is visible so freeze-on-publish is legible |
| Patient plans & credits | chart tab `Plans & Credits` | Memberships with lifecycle controls, entitlement balances, the full ledger, selling, and complimentary assignment |
| Reconciliation | `/billing/reconciliation` | Exceptions with reasoned resolution; the processor event ledger showing whether each signature was verified |
| Financial reports | `/billing/reports` | Charges, collections, receivables, aging, sales, period-over-period |
| Stripe webhook | `POST /api/live/stripe/webhook` | The only path by which a subscription may settle |

### Accessibility of reporting

Every chart is a `ShareBar` that carries (1) an `aria-label` naming each
segment and its value, (2) per-segment **text** labels with figures and
percentages, and (3) a table of the same numbers beneath. Colour is never the
only signal, and a monochrome print or a screen reader gets identical
information.

### Honest reporting language

Estimates are labelled `ESTIMATES` in the heading and carry an explicit note
that they are **not** recognized revenue, **not** profit, and **not**
accounting-certified. Membership recurring revenue is deliberately **omitted**
rather than estimated from plan prices, because it needs real subscription
billing history that only exists once a processor has settled a period.

## Verification results

| Gate | Result |
| --- | --- |
| DB acceptance (rolled back, staging) | **28/28**, zero residue |
| Phase 8B browser proofs | **18/18** |
| Full live battery, one pass | **156/156** (138 before this phase) |
| Backend-down honesty | **11/11** |
| Unit (incl. 20 Stripe boundary tests) | **190/190** |
| Advisors | **0 ERRORs**; +17 WARNs, one per caller RPC |
| Edition-lock refusals | both correctly fail |
| Secret / card / PHI scan | clean |
| Performance advisors on 8B tables | **0 unindexed foreign keys** after `desktop_plans_fk_indexes` |

## Still unavailable

- **No real Stripe API transaction has been executed.** No test credentials
  exist in this environment, so scenarios 13-17 (test subscription creation,
  signed webhook verification, tamper/replay refusal, duplicate renewal
  idempotency, out-of-order events) are proven **deterministically** in
  `src/server/stripe-boundary.test.ts` against a real HMAC rather than against
  Stripe's servers. `liveTransactionExecuted` is `false` and every surface says
  so. When credentials are supplied, set the three variables above and the
  boundary activates without further code changes.
- **Live Stripe** remains refused by design; see the deferred list below.
- **Provider settlement figures** (fee, net, payout status) are not fetched, so
  they read `unavailable` rather than zero.
- **Membership recurring-revenue reporting** awaits real subscription billing
  history.
