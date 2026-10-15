# The Outreach status screen (marketing wiring, workstream 6) — 2026-10-15

**Branch:** `claude/outreach-status-20261015`, cut from the campaign engine's head (`f08b277a`, which carries workstream
1). The screen's campaign rows read the engine, so it cannot be cut from the base alone. Workstreams 3 and 4 are read
by setting name, with no code from their branches; the integration line (workstream 7) swaps in their own readers
where they exist.

**The go-live list:** [`docs/outreach-go-live.md`](outreach-go-live.md).

## What was built

**The screen.** Business → **Outreach status** (`/outreach`), read-only. It shows one row per setting, in the order
Brandon switches them on, which is also the order of `docs/outreach-go-live.md`. A test fails if the two disagree. Each
row shows:

- the setting and where it is set;
- what it turns on;
- **On**, **Off** or **Can't tell**, with a line saying why;
- what it is blocked until, and who does that step.

"Can't tell" is its own answer and never a polite "off". It means one of two things:

- **The setting lives where this server cannot read it.** That covers the telehealth and identity services and the
  patient-app build. The row says so, and does not guess from a copy.
- **The campaign engine did not answer, or refused the session.** Every row that depends on the engine says so.

The screen has no control, link or form. It shows no configured value, so no secret, sender, address, origin, slug or
list appears, and it reads no patient.

**Where it is:**

- `src/server/outreach-status.ts`: the steps (`OUTREACH_STEPS`), the two reads (`readEngineStatus` and
  `readSignupPages`), and the pure row builder (`outreachRows`).
- `src/components/outreach/OutreachStatusView.tsx`.
- `src/app/outreach/page.tsx` (a server page, read once per visit; signed-in staff only, by the existing middleware).
- `src/components/shell/Sidebar.tsx`: the Business item, plus the active-item highlight for `/campaigns` and
  `/outreach`.

**What each row reads.**

| Rows | Read from |
| --- | --- |
| Public address | This server: `NEXT_PUBLIC_SITE_ORIGIN`, `APP_RUNTIME_ENV` and the staging signals, through the same `indexingAllowed` the pages use |
| One per program page | The repository's funnel definitions (`status`, the draft note, and the attorney rule for weight loss and diabetes) |
| "Received" email, Desktop notification-choices view | This server's switches, with the companions the "received" email needs (sender, `alp-transactional`, contact line) |
| Email reminders, "booked" email, the identity service's notification choices and notices, both text switches, the patient app's constant | Nothing: **Can't tell**, saying which service holds it |
| Campaign engine, the practice's `marketing` entitlement, sending domain, sending settings | The engine's new `status` read, for the signed-in practice |
| "Get updates" link | The engine's existing public "sign-up open" read, for `FUNNEL_PRACTICE_SLUG`'s practice |
| Purchase offers | The offer ledger this server may use (`selectProgramOfferLedger`), and whether any page is bound to a program |

**The engine's `status` read** (an addition to workstream 2's engine on this branch).

- `POST /campaigns/workforce {"action":"status"}`, open to any staff member of the practice, with no marketing role
  or entitlement needed.
- It answers flags and counts only (`engineStatus` in `src/campaigns/contract.ts`): the entitlement and tier, the
  domain's verification and its DKIM and MAIL FROM states, readiness and what is missing, the number of active
  sequences, scheduled broadcasts and approved emails, and **SES production access**.
- Production access comes from `GetAccount` `ProductionAccessEnabled`, through a new SES port method
  (`productionAccess`). If SES does not answer it is `unknown`, never a guess. The API role already allows
  `ses:GetAccount`, so there is no IAM change.

**Setting.** None. The screen changes nothing, and its job is to show that everything else is off, so it is not
behind a switch of its own. With every setting off, every row reads Off or Can't tell, and a test holds that.

## Tests (fictional values only)

- `src/server/outreach-status.test.ts` (14):
  - every setting off, nothing on, and the go-live order;
  - the reasons for each off;
  - the public address posture;
  - the "received" email's completeness;
  - the two notification-choices copies;
  - purchase under the fixture;
  - an unanswering or refusing engine is Can't tell;
  - a ready practice;
  - each missing piece named;
  - no configured value in any row;
  - the two reads at the `fetch` boundary (nothing asked when off; failure distinct from refusal; a reply that
    carries anything beyond flags is refused);
  - the go-live document matching the steps.
- `src/components/outreach/OutreachStatusView.render.test.ts` (3): the rows and states as rendered; states in words;
  no control of any kind.
- `src/campaigns/status.test.ts` (6):
  - staff with no role, at a practice without the package;
  - flags and counts with nothing personal;
  - production access unknown when SES is silent;
  - one practice's answer only;
  - refused when the engine is off;
  - `GetAccount` at the SDK boundary.

## Gate results (this branch)

| Check | Result |
| --- | --- |
| Unit suite (`npm run test:unit`) | 564 files passed; 8,824 tests passed, 11 skipped (the existing declared skips) |
| Typecheck (`tsc --noEmit`) | clean, after replacing a `const` assertion on a ternary that TS refuses |
| ESLint, every changed or new file, `--max-warnings=0` | clean |
| Build (`APP_EDITION=clinical NEXT_PUBLIC_USE_LIVE_API=true npm run build`) | compiled (adds `/outreach`) |

The ordered end-to-end battery runs once, on the integration line (workstream 7). This branch adds no spec.

## What was verified about SES and End User Messaging

- **SES `GetAccount`** returns `ProductionAccessEnabled`. This was read from `@aws-sdk/client-sesv2` 3.1124.0's types
  and exercised against a fake client. No AWS call was made, so whether this account has production access is
  unknown.
- **End User Messaging:** nothing new. The text rows read Can't tell, because their switches live in the telehealth
  and identity functions.

## Stopped

1. **The services' own switches.** For the telehealth and identity services' settings and the patient-app build, the
   screen reads Can't tell. A read-only status route on each service would let it tell, but that needs routes in the
   services' API templates, which the release scripts pin. It is left for the AWS operator's reviewed change.
2. **The sending schedule's state** (`SendScheduleState`) is not visible to the engine's API, so the "Campaign sending
   settings" row says so even when it reads On.
3. **Per-practice view.** The entitlement, domain and sending rows describe the signed-in practice only. An operator
   view across practices would be a separate, operator-only screen.
