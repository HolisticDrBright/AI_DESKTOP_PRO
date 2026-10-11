# Program funnels audit and local preview

Visitors should have two choices: request a consultation or buy the program directly. Brandon will select separate program prices later. An unset price is not free, and the V2 Core subscription price does not price these programs.

The audited source is `ecc21ca0e8ee8415335787a3e25f028f3881c403` from `claude/program-lead-funnels-20261011`. Its exact hosted CI run 38181203437 succeeded. The repairs below are a separate successor on `agent/program-funnels-audit-20261011`; predecessor CI does not verify this successor. Claude's live worktree and browser jobs were not changed. No main merge, PR or deployment occurred.

## Actual connection status

| Boundary | Observed status |
| --- | --- |
| Longevity, Weight Loss and Diabetes public sales pages | All three definitions are draft, with unreleased marketing content and no approval. Public `/learn/<slug>` returns 404. |
| Practitioner draft review | New private `/funnels/<slug>/preview` shows the draft and disabled purchase control. Anonymous visitors must sign in; the preview does not publish the page. |
| Consultation request | Existing `/consult/<slug>` and sealed-contact service exist. The local launcher has no reviewed public consult API origin or contact key. Browser description now reaches the local route and returns 503; no consultation submission or booking was tested. |
| Paid purchase | Not connected. No funnel checkout, verified payment receipt, immutable program offer claim or automatic paid enrollment was observed. The existing Stripe offer mode still refuses enrollment as not configured. |
| Mock experience | Separate demo repository only: three redesigned landing pages, both choices, fictional declined-payment and access previews, and links to the exact matching curriculum and plan drafts. No live transport, card fields, contact information or enrollment. |

An active consult link is not proof of a working purchase. Consultation requests are not booked appointments. Opening a success URL must never mint an entitlement.

## Repairs and evidence

1. **Publication review:** published Weight Loss and Diabetes definitions previously admitted `attorneyReview:false`, contrary to their recorded review requirement. Both negative tests failed before the schema repair and pass after it. Current drafts and approvals were not changed.
2. **Indexing:** six negative tests exposed omitted synthetic, qualification, development and loopback signals. Indexing now refuses those signals even alongside the production runtime string. No public origin or published content was installed.
3. **Local same-origin requests:** a real browser using 127.0.0.1 received `origin_refused` (403) because Next represented the listener as localhost. Loopback aliases now work only on the same port, with browser Origin still exactly matching Host. Cross-site, mismatched Host, other ports, non-loopback HTTP listeners and forwarding-header substitutions remain refused. The loopback-positive test failed before the repair. Actual local browser response moved from 403 to the truthful unconfigured-service 503.
4. **Consultation failures:** service errors used to look like withdrawn/expired links, while a rejected fetch could remain loading. Network errors/timeouts, malformed or wrong-action responses and retryable server failures now produce a safe retryable service message; indistinguishable link refusals remain generic. A failing render test established the missing state. New transport cases cover the additional fault handling; they are added coverage, not all claimed as failing-before reproductions. The same wire schema validates replies. A real browser observed the failure screen and its retry, both with 503 and no submission.
5. **Visibility:** staff now see draft-review links and an explicit missing-purchase status. No permission, activation, price or clinical hold changed.

## Verification limits

- Clinical focused funnel/origin/view/transport checks: 82 passed in nine files. Consultation service, database and retention neighbours: 68 passed in seven files, overlapping some focused cases; do not sum these as unique tests.
- Typecheck, focused lint, diff check and mock-import boundary passed; 289 entry files and 624 reachable modules had no mock import path.
- Final clinical local build generated 251 static pages and strict scan passed over 313 client chunks. Windows dependency-junction copying emitted an EPERM standalone warning. This is a working `next start` preview, **not** a qualified standalone deployment package.
- Demo model: six tests passed; typecheck, focused lint and 219-file demo source boundary passed. Final frozen-source demo build passed with 34 routes and 73 client chunks. Large curricula are projected on the server into small preview properties, not shipped wholesale to the browser.
- Demo mounted browser run: 12 passed, including all three dual-choice journeys, matching course/plan links, zero external calls or write requests, mobile overflow, cancellation/reload and existing education/program-plan regressions. Initial run had nine passes and three failures because an unscoped alert selector also matched Next's route announcer; the selector was scoped to the exact declined-payment alert and the complete 12-test run passed. No retry, timeout or assertion was relaxed.
- Anonymous clinical browser checks observed draft 404s, private redirects and retryable unconfigured-service refusal without intercepted responses. They are **negative posture verification**, not positive booking/payment acceptance or an authenticated practitioner journey.
- No full successor unit/browser battery or exact-successor hosted CI result is claimed here. No AWS write, secret retrieval, provider call, paid mobile build, TestFlight upload, PHI or public launch occurred.

## Remaining live engineering and configuration

1. Define a reviewed program-offer identity binding clinic, program/version, duration, scope, currency, price and billing frequency. Draft/missing prices refuse checkout. Brandon's price and purchase-term choices remain pending.
2. Implement/configure the governed payment-provider boundary, hosted tokenized checkout and signed webhook verification. Browser success URLs, query strings and UI state are never payment authority. Include idempotent duplicate/reordered webhooks, pending/declined/cancelled sessions, refunds and subscription changes where applicable.
3. Bind the verified receipt to the intended account and immutable program version; claim invitations securely; grant only admitted education access. Complete Desktop enrollment and V2 read/adopt journeys without bypassing consent, phases, clinical reviews, catalog holds or entitlement checks. Never include prescriptions or held products simply because a program was purchased.
4. Review and configure public consult links, sealed contact storage and request-to-inbox/scheduling handling on one reviewed target. Prove delivery, replay, refused/paused links and appointment confirmation end to end. Decide whether each consultation is free or paid before any charge is enabled.
5. Approve accurate program copy, pricing, refund/cancellation terms and required legal reviews before publication. Connect only approved released curricula and reviewed media; mock source drafts are not patient releases. Add accessible legal/receipt/support screens without advertising trackers on clinical or intake surfaces.
6. Run provider test-mode purchase through verified receipt, account claim, Desktop enrollment and matching V2 program access; repeat isolation/refund/replay/hold negatives. Rebuild matched exact-source candidates and complete hosted/device/provider acceptance before launch. The native media ledger/routes/mirrored-reference work remains separate unfinished engineering, not covered by this funnel preview.

All six original commercial/PHI scopes remain incomplete. Existing synthetic-only posture, Core launch scope, clinical holds/exclusions, source-verification requirements and guardian deferral remain unchanged.
