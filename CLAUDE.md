# Working agreements for this repository

## The current branch

**Phase 9C work belongs to `claude/clinical-runtime-phase9c-curated-import`.**

Phase 9B is finished: PR #25 merged at `9fe5ae8`, and
`claude/clinical-runtime-phase9b-knowledge-catalog` is done. A merged PR cannot
track new work — do not stack follow-up commits on it.

Some harness configurations still name `claude/clinical-knowledge-registry-znhm8j`
as the development branch. That is **stale**: it is a Phase-1 branch, last
touched at `23f9ccd`. If a harness default and this file disagree, this file is
correct — verify with the GitHub tools which branch the open PR actually points
at before pushing.

## The clinical database

One project only: **`urcjiehlxoehievobezf`** (AI Desktop Pro clinical). It is a
synthetic **staging** project and **must never become production** — that is its
permanent role, not a state awaiting cleanup.

Before applying anything, read the migration ledger. `apply_migration` stamps
its **own** version, which will not match the filename you wrote — rename the
local file to the recorded version afterwards, or the repo and the database
disagree about what ran.

### Retained by decision — do not delete

Two "(Demo)" organizations, the patients "Avery Demo" and "Jordan Sample", and
two `@brightlongevity.test` auth users. A test asserts they are **still there**,
so removing them fails loudly rather than quietly reversing a decision.

### The catalog is a separate question, and it is enforced

No demo-marked or seed-derived product may be **returned** by clinical product
search, **selectable** in the picker, or **attachable** to a draft by id — see
`supabase/tests/desktop_no_demo_catalog_content.sql`. Only the third axis is
conclusive: a row can be absent from search and still be attachable, which is
how a "hidden" record keeps reaching patients.

The difference is the point:

> A synthetic **patient** in a staging project is a test fixture.
> A synthetic **product** in the protocol picker is a clinical recommendation
> nobody made.

### Production

A new, empty project: migrations only, no seed import, and no restoring a
staging snapshot into it. See `docs/deployment-verification.md`.

## Standing rules that tests enforce

These are not style preferences. Each has a test that fails if it is broken.

- **Unknown stays Unknown.** A field nobody recorded renders "Unknown" — never
  "None" (a clinical claim nobody made) and never blank (the same claim with
  the evidence hidden).
- **Never invent a dose.** A dose requires an exact product label, a supplied
  practitioner protocol, or a governed reference. Approval is gated on it, for
  patient protocols *and* templates.
- **An empty state and a failure are different claims.** "No products yet"
  describes the registry; with the backend down, nobody is in a position to say
  it. Both surfaces must be distinguishable on screen.
- **Commercial data cannot touch clinical data.** It lives in separate tables
  and is returned under a separate top-level key. No clinical expression may
  read a commercial table; this is asserted on function bodies, because with an
  empty commercial table an output-only check passes while proving nothing.
- **Nothing synthetic in the clinical project.** A demo row is
  indistinguishable from a real one at a glance. See
  `supabase/tests/desktop_no_demo_catalog_content.sql`.
- **An imported product is not yet a product.** A row from a spreadsheet is a
  claim about a bottle nobody here has held. It lands non-`active`, so it is
  neither searchable, selectable, nor attachable, and it carries an append-only
  provenance record. See `supabase/tests/desktop_curated_import_safety.sql`.
- **A declared value carries authority; a text signal does not.** The word
  "peptide" in a product name may raise `suspected_restricted` and nothing else.
  Inferring a regulatory class from free text is forbidden in both directions.
- **Do not weaken a safety test to make new work pass.** If a safety test
  blocks something, the test is usually right; find another route to the goal.

## The E2E battery

It runs in ONE process and must pass in **any spec order**:

```bash
PW_CHROMIUM_PATH=/opt/pw-browsers/chromium npm run test:e2e:order   # forward + reverse
npm run check:stub-reset    # every mutable stub binding is reset
```

The runner provisions everything else and owns its fixture backend and servers.
The battery is **every spec**, in one Playwright process per order, each order
on a **fresh `next dev` server with `CLINICAL_CONTRACT_FIXTURE=1`** and the
loopback fixture backend reset between them — the runtime CI's live-fixture job
uses. **Playwright sorts the files it collects**, so a reversed file list is not
a reversed run: numbered aliases (`scripts/e2e-ordered-specs.mjs`) force each
order and `--list` proves it before any browser starts. It cannot run under `next start`: production
mode is a deployed runtime, and the contract fixture is refused there by design
(`src/server/runtime/contractFixture.ts`). **Do not weaken that refusal to get
browser coverage.** The runner observes the posture before any spec runs (a
signed-out `/today` renders only when the fixture is allowed) and stops with
one line if it was refused. Fixture targets and credentials are pinned to the
fictional local values; anything else is refused, never redirected.

**Playwright must run as an asynchronous child.** The runner owns the dev
server's stdout and stderr pipes, and Next puts its stdio into blocking mode.
A synchronous child (`execFileSync`) stops the runner draining them, so once the
pipe fills the server blocks mid-write and answers nothing — the long-run
`/login` timeout and the lens readback stuck on "Loading evaluation…". A test
in `scripts/e2e-order-config.test.mjs` holds the driver to this.

**The whole app is compiled before any spec and kept compiled.** The runner
requests every `page` and `route` entry under `src/app` 24 at a time
(`precompileApp`; 293 entries, about 13 compilations), and the harness's dev
server keeps them (`next.config.ts`, `onDemandEntries`, only when
`E2E_DEV_SERVER=1`). Next's default disposes idle routes and recompiles them;
across the battery that grew the worker heap until Next restarted its own
worker at 80 % of the limit, mid-test. Kept without the precompile, each first
compile carries every entry and a test waits on it. The harness preload
(`scripts/e2e-dev-preload.mjs`, the only `--import`: `next dev` keeps one value
per Node option for its worker) also leaves React's development async-debug
hook off in that server; it recorded every promise of every render. A worker
restart fails the battery. Do not "fix"
a stall by splitting specs into fresh processes, raising timeouts or raising
the heap: find the mechanism in the evidence directory first.

Outcomes come from Playwright's JSON report by test identity: both orders must
pass the **same** tests; a skip the spec declared is listed with its reason and
never counted as a pass; a test a failed hook never ran is a failure ("did not
run"). Specs that need a posture of their own are listed in
`SEPARATELY_CONFIGURED_SPECS` (`scripts/e2e-order-config.mjs`) with their CI
job; a new spec must be `live-*` or be listed there, or the runner refuses.

Evidence goes to `e2e-order-evidence/<run>/` (or `E2E_ORDER_EVIDENCE`): the
stamped server log with memory samples, a 15 s latency canary, each order's
report and timeline, and `summary.json`. Set `E2E_DEV_HEAP_MB` (2048–12288,
with 4096 MiB to spare) alone — never a heap in `NODE_OPTIONS` as well — or
leave it unset for the 10 GiB default. The same command works with `CI=1`.

Per-spec commands are for debugging only. A battery that passes only when each
suite runs alone has stopped testing what one suite leaves for the next — which
is the failure mode that actually happens.

Every spec calls `resetBackend()` in `beforeAll`. If you add mutable state to
`scripts/live-stub-server.mjs`, the coverage gate will tell you to cover it.

## Documentation index

| Doc | Covers |
| --- | --- |
| `docs/phase9b-protocol-knowledge.md` | Part 9, catalog + template surfaces, the harness |
| `docs/phase9b-authority-map.md` | Authority, provenance, and the defects found |
| `docs/phase9b-knowledge-governance.md` | Governance model |
| `docs/phase9b-operator-import.md` | Loading real practitioner material |
| `docs/phase9c-curated-import.md` | The import safety layer, the inference boundary, the apply paths |
| `docs/telehealth.md` | The Telehealth tab: embedded Zoom visits, the consent gate, AI Companion notes |
| `docs/clinic-record-privacy-2026-10-10.md` | Patient copies and corrections of clinic-held records: contracts, the 114 candidate, fail-closed disclosure, practitioner fulfilment, the V2 Clinic Data Center |
| `docs/telehealth-chart-lifecycle-2026-10-10.md` | Placing a signed telehealth note in the chart, the retained-record read authority, the record inventory, forward candidate 113 |
| `docs/program-media-authoring-2026-10-11.md` | Governed lesson media: the dedicated-media design, the disabled authoring runtime over a fictional store, the blocked ledger candidate, and the ordered real-store qualification Codex owns |
| `docs/program-lead-funnels-2026-10-11.md` | Program lead funnels, phase 1: the public allow-list repair, repository-defined funnel pages with text rules enforced by shape, the production-only indexing posture, the Funnels screen, and what stays draft until Brandon supplies program content and approves the text |
| `docs/claude-program-commerce-closure-2026-10-11.md` | Paid-program purchase, disabled and source-only: the program-offer/1 contract and ledgers, the BLOCKED offer and checkout candidates, the tokenized checkout boundary with durable webhook intake, both funnel choices, and the decisions still Brandon's |
| `docs/claude-program-commerce-reliability-learner-journeys-2026-10-11.md` | Reliable purchases and learner journeys: checkout recovery, claim delivery, database authority separation and reviewed-terms holds, learner progress, the separately configured mounted journey, and the four BLOCKED successors |
| `docs/claude-course-delivery-hardening-2026-10-11.md` | Course delivery hardening: the bounded, version-bound V2 progress client and its mirror, My courses on the Desktop behind a reviewed learner host, the durable SQL acceptance host (fresh-instance and separate-process recovery), and the ordered Codex inputs |
| `docs/claude-core-launch-source-qualification-2026-10-12.md` | Core launch source qualification, Desktop side: the iron-panel veto and trigger-specific claims in the lab worker, the owned worker's reviewed-range requirement, the consumer catalog audience, and what was found but left for Brandon's decision |
| `docs/claude-core-release-overnight-2026-10-13.md` | Core release overnight: the adopted lab plan held under education-only Core, consumer offers bound to the current label and one destination with the offer coverage audit, the lab-derived supplement candidate behind its OFF gate, the disabled bound purchase action and purchase admission, the evidence per package, and the ordered Codex hand-back |
| `docs/claude-core-purchase-clinical-followup-2026-10-13.md` | Core purchase and clinical follow-up: brand-site offers bound per product, OTC licensure, shared-destination refusal, Takesumi accounting and the non-supplement hold, the recorded iron veto and consideration trace (off in results), the lab candidate as the Plan's one composer, the delegate view held, release prerequisites and the ordered Codex hand-back |
| `docs/claude-lab-safety-provenance-2026-10-13.md` | Lab safety and provenance: the server's own lab-aware program review (program-lab-review/1, holds only), the BLOCKED reviewer-attestation and lab-result/2 candidates (no client "verified", no laboratory flag from the app), the legacy backfill removed in V2, the browser runner summary, candidate digests and the ordered Codex hand-back |
| `docs/claude-core-safety-release-preflight-2026-10-13.md` | Core safety and release preflight: program supplement steps held against saved labs for clinician review, unreviewed lab provenance (the patient-app intake card names an app flag, never a laboratory flag), the entitlement and account-switch audit, the Core disclosure drafts for Brandon and counsel, the single-build preflight manifest and unfilled device worksheet, blocked candidates and the ordered Codex hand-back |
| `docs/claude-browser-acceptance-runner-2026-10-13.md` | The order battery's runtime: why `next start` refuses the contract fixture (correctly), the runner that froze its own `next dev` server (a synchronous Playwright child left Next's blocking stdout undrained) and the repair, posture observation, identity-based accounting, the evidence directory, and the LensPanel honest-state fix |
| `docs/claude-clinical-source-closure-2026-10-14.md` | Clinical source closure: the disabled reviewer value attestation (clinic reading beside the recorded report digest, verified only after readback) and its BLOCKED successor, lab-import-receipt/2 for the prepared lab-result/2, the disabled program-step purchase binding re-read against the current program review and its BLOCKED successor, candidate digests, the Windows hang report and the ordered Codex hand-back |
| `docs/claude-program-purchase-safety-2026-10-14.md` | Program-purchase safety path: the BLOCKED consumer boundary that withholds every purchase destination from the API role at the database and decides `complete` against the plan revision the person was shown (program-bound-completion/1), its rollback, the removed V2 generic purchase path, candidate digests and the ordered Codex hand-back |
| `docs/claude-funnels-finish-2026-10-14.md` | Marketing wiring, workstream 1: the "Get updates about this program" link to the practice's `/join` page (shown only with the `marketing` entitlement), `?via=email` choosing the consult link from a fixed list with nothing stored, requests per program and channel on the Funnels screen, the unchanged page policy, and what stays draft for program content and approval |
| `docs/claude-consult-enquirer-emails-2026-10-14.md` | Marketing wiring, workstream 3: "we received your request" from the public consult route and "your consultation is booked" when staff schedule a visit, both through `alp-transactional` and off by default, where they sit in the actual consult and appointment model, and what was not verified |
| `docs/claude-patient-notices-2026-10-14.md` | Marketing wiring, workstream 4: the four notification switches (all off; off builds nothing), each kind's hook point proven through the real handler, the patient's settings routes and the clinic's read-only view, the V2 Notifications screen behind its release flag, the byte-identical contract mirror, the push report, End User Messaging verification and the stops |
| `docs/claude-core-launch-closure-2026-10-15.md` | Core launch and program-delivery closure, Desktop side: the BLOCKED invitation repair (an invitation never changes an existing membership) and the review of the clinic-approved onboarding candidate, the BLOCKED priced successor to the program-step purchase (`program_price_unset` before any checkout), My courses closing a lesson when access is withdrawn, candidate digests and the ordered Codex hand-back |
| `docs/claude-campaign-engine-2026-10-15.md` | Marketing wiring, workstream 2 (revised): the campaign engine built into Desktop on SES for many practices: its own DynamoDB store with structural practice separation, `/join` sign-up with double opt-in, sequences and broadcasts with approval and the refused-phrase check, per-practice domains and SES tenants, the idempotent 5-minute sending job, unsubscribe (link and RFC 8058), bounces and complaints, the editable Campaigns screen, the `marketing` entitlement and allowances as data, the template (not applied) and what stays for Brandon and AWS |
| `docs/claude-leads-board-2026-10-15.md` | Marketing wiring, workstream 5: the leads board as a List \| Board view of the consult Requests queue's own rows (one column per recorded state, where each request came from, the queue's own actions, a failed read distinct from empty columns), and the schema change "contacted" and "scheduled" would need |
| `docs/claude-outreach-status-2026-10-15.md` | Marketing wiring, workstream 6: the read-only Outreach status screen (one row per setting, On / Off / Can't tell with the blocker, nothing configured shown), the campaign engine's flags-only `status` read with SES production access, and why rows held by other services read Can't tell |
| `docs/outreach-go-live.md` | The order Brandon switches every outreach setting on, who does each step, and how to check it; held to the Outreach status screen's rows by a test |
| `docs/claude-outreach-wiring-2026-10-14.md` | Marketing wiring, workstream 7: the integration line for workstreams 1 to 6 (heads, conflicts, the one seam), the marketing and clinical paths end to end with every external service faked at its boundary, the separation tests (import graph, stack permissions, two practices, every switch off), the gate, SES and End User Messaging verification, and every stop |
| `docs/claude-core-boundary-overnight-2026-10-15.md` | Core boundary overnight, Desktop side: the integrated-head 403 regression (fixtures model a current membership; negatives refuse before scheduling or email), the synthetic program adapter's withheld destination, the uniform join-request refusal successor, the reverse outreach separation, and the ordered Codex steps |
| `docs/workforce-current-identity-consent-2026-10-15.md` | One-login practitioner authority, first family: the workforce identity and consent routes under `database_current` (current membership in the operation's transaction, one selected clinic, live token, no claim fallback), the 14 PGlite handler cases and the two-session PostgreSQL lock qualification, the 59-route authority matrix, the setter's rollback, the pre-activation dependencies and the ordered Codex inputs |
| `docs/qualification-program-boundary-2026-10-15.md` | The program family for the production-shaped qualification database: the BLOCKED boundary successor and rollback on the 112 ledger, the designated-subject qualification adapter and route handler, the 20 PGlite cases, and the ordered Codex prerequisites |
| `docs/clinic-authority-fences-2026-10-15.md` | The three selected-clinic findings closed in source: the subject-only first-clinic read and pending memberships, the stale-tab expected-clinic fence, the telehealth writes under the membership fence (`membership-fence/1`) with provider undo and the BLOCKED guard candidate, the audit of the remaining caller families (refused, not converted), the AWS packet and owner decisions |
| `docs/selected-clinic-authority-2026-10-15.md` | The selected clinic under `database_current`: the session-bound `x-alp-selected-organization-id` through the Desktop clinical transport (sources, binding, refusals before HTTP, account and clinic switches, the unconverted route families), the telehealth boundary's identity caller with its 17-route negative matrix, why its writes stay disabled (the authority-read-to-write race) and the fence design they need |
| `docs/program-messaging-membership-2026-10-15.md` | Patient–practitioner messages and assigned programs under clinic-membership sign-in: the messaging API's `database_current` path and the practitioner program adapter and route (current membership in the operation's transaction, no claim fallback, no new SQL), the Desktop families gated off by default with the stale-tab fence and a clinic echo, honest panel refusals, the mounted journey, what stays blocked (the qualification program proxy, the program host) and the ordered Codex work |
