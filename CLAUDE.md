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
APP_EDITION=clinical NEXT_PUBLIC_USE_LIVE_API=true npm run build

APP_EDITION=clinical E2E_LIVE=1 \
  TRPC_BASE_URL=http://127.0.0.1:3999/api/trpc \
  CLINICAL_SUPABASE_URL=http://127.0.0.1:3999 CLINICAL_SUPABASE_ANON_KEY=stub \
  CLINICAL_DEMO_EMAIL=demo@local CLINICAL_DEMO_PASSWORD=demo \
  CLINICAL_ORG_ID=org-fixture \
  npm run test:e2e:order    # forward + reverse, must match

npm run check:stub-reset    # every mutable stub binding is reset
```

**Run it with that whole environment or not at all.** A bare
`npm run test:e2e:order` reports `0 passed, 216 skipped` and exits non-zero —
every live spec is gated on `E2E_LIVE`. `APP_EDITION` is needed twice: once for
the build, and again for the Playwright web server, which starts its own
`next start` and refuses to guess an edition. Set `PW_CHROMIUM_PATH` where a
Chromium is pre-installed rather than downloaded.

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
