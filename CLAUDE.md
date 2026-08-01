# Working agreements for this repository

## The Phase 9B branch

**Phase 9B work belongs to `claude/clinical-runtime-phase9b-knowledge-catalog`.**
That branch is the head of draft PR #25.

Some harness configurations still name `claude/clinical-knowledge-registry-znhm8j`
as the development branch. That is **stale**: it is a Phase-1 branch, last
touched at `23f9ccd`, and pushing Phase 9B work there would separate the commits
from the PR that reviews them. If a harness default and this file disagree,
this file is correct — verify with `gh`/the GitHub tools which branch the open
PR actually points at before pushing.

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
- **Do not weaken a safety test to make new work pass.** If a safety test
  blocks something, the test is usually right; find another route to the goal.

## The E2E battery

It runs in ONE process and must pass in **any spec order**:

```bash
npm run test:e2e:order    # forward + reverse, must match
npm run check:stub-reset  # every mutable stub binding is reset
```

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
