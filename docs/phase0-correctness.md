# Phase 0 — Correctness & merge blockers

Defects found by direct code inspection, fixed, and verified. Every item lists
where it lived and how it is now proven. (Companion backend changes:
`rork-ai-longevity-coach` PR #7.)

## Fixed and verified

| # | Defect | Fix | Proof |
| --- | --- | --- | --- |
| 1 | **Lab status collapsed every abnormal — including `low`/`critical_low` — to "high"; missing status became "normal"** (backend `buildMarkers`) | `mapMarkerStatus` maps each stored status verbatim; missing → `unknown` ("Unclassified", warning tone — never assumed normal); direction never inferred from free-text ranges; text-only rows never fabricate numerics | backend vitest: every status, missing, text-only, critical (252/252); live e2e asserts "Unclassified" label |
| 2 | **Missing extraction confidence fabricated as 50%** | `confidence: number \| null` end-to-end; `unknown` band ("Not provided"), review-gated like low | backend vitest + live e2e ("Not provided", not-recorded note) |
| 3 | **Workspace summary counts used all historical observations** | counts computed from the latest marker set | backend vitest (history does not inflate counts) |
| 4 | **Persisted review state didn't settle the inspector** (session-only gate) + repeated reviews duplicated audits | gate = persisted `reviewState` OR session outcome; `review_biomarker` idempotent on same decision (0018) | live e2e: TSH "Reviewed" disabled in a fresh session; DB suite: exactly one audit per decision (12/12) |
| 5 | **Overdue saved view didn't filter** (memo omitted `overdueOnly` behind an eslint-disable) | dependency fixed properly (`useCallback` + full deps) | mock e2e behavioral test (narrows to exactly the overdue rows) |
| 6 | **Cross-tenant audit reference**: `record_audit_event` never checked the patient belongs to the supplied org | 0018: patient∈organization enforced in the SECURITY DEFINER function; other RPCs already derive org from the record (verified) | DB suite: dual-org attacker blocked 42501; same-org allowed (12/12) |
| 7 | **Browser-supplied audit text/metadata** | server-owned event registry (backend): stored action, resource type, display text, and allowed metadata keys/types/lengths all server-side; unknown events/keys rejected; DB re-enforces caps (0018) | backend vitest: note text, transcripts, lab-value strings, oversized values, wrong patient requirements all rejected before the DB |
| 8 | **Live mode entered through synthetic `p-78435`** (root redirect, sidebar fallback, mock directory) | live root → real RLS-scoped directory (`/clients`); sidebar clinical tabs → directory when no real patient in context; live patient summary renders the real header + honest not-yet-live panel instead of 404 | live e2e: root(200) → directory → real patient → live labs; fails on 404 or any `p-78435` leak |
| 9 | **Auth refresh only on the login screen** | `middleware.ts`: global near-expiry/expired refresh with rotation, single-flight per refresh token, revoked → clear + redirect, transient backend failure tolerated, `?next=` redirect-back (same-origin only) | live e2e: deliberately expired token recovers with rotated cookies; revoked token clears without looping; `next=` honored |
| 10 | **Date-only DOBs parsed as UTC** (off-by-one in Pacific) + `sex` guessing (anything non-male → "Female") + unknown age as 0 | `src/lib/dates.ts` calendar-date parsing/age; sex states Female/Male/Other/Unknown/Not recorded; unknown age stays unknown | desktop vitest runs under `TZ=America/Los_Angeles` incl. year-boundary cases (7/7) |
| 11 | **Rebuilt previews implied source excerpts; no way to open the source** | preview labeled "Structured result preview"; markers carry `documentId`; "Open source PDF (audited)" streams the original bytes through backend + storage RLS and audits `document.viewed`; uploads store the document SHA-256 (0019) | live e2e: link renders; direct fetch returns `%PDF`; backend route tests |
| 12 | **Hygiene**: full-URL request logs (query strings carry tRPC inputs); Railway Dockerfile fell back from frozen to unlocked installs; unpinned Bun; no CI; no origin/size/rate guards; vulnerable postcss (<8.5.10) via Next | pathname-only logs; fallback removed (drift fails the build); Bun pinned 1.3.11; GitHub Actions in both repos (typecheck/lint/unit/build/browser suites + secret-gated deployed-backend and DB-suite jobs); origin validation + body caps + per-IP rate limits on `/api/auth/login`, `/api/trpc/*`, `/api/clinical/*`; postcss forced to 8.5.19 via `overrides` (compatible patch — **not** a downgrade), `npm audit` clean | CI files committed; audit output 0 vulnerabilities; suites green |

## Verification summary (all actually run)

- Desktop: `test:unit` 7/7 (Pacific TZ) · typecheck/lint clean · mock build + **14/14** · live build + **12/12** vs the contract fixture · `npm audit` 0
- Backend: **252/252** vitest · backend-scoped tsc 0 errors
- Database (real project, rolled back via MCP): 0018 suite **12/12**; 0016 19/19, 0017 20/20, 0013–0015 suites still standing; migrations 0013–0019 applied
- Not run (unchanged constraint): the deployed-environment browser run — sandbox egress blocks `*.supabase.co`; the exact commands live in `docs/live-auth-and-seeding.md` and the CI deployed job runs automatically once its secrets exist

## Still open (Phase 0 scope, honestly)

- **Repo default branch**: confirm `main` remains the default after the PRs merge (owner setting).
- The in-memory rate limiters are per-instance; swap for a shared store when running more than one replica (documented in code).
- `list_audit_events`/`resolve`/`create_review_task` already derive tenancy from the record; encounter/note/order/program/payment mutations don't exist yet — their tenant checks land with their Phase 2+ migrations, following the 0018 pattern.
