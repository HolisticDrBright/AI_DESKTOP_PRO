# Phase 9B — protocol knowledge, the product catalog, and template lifecycle

This covers the second half of Phase 9B: what a protocol knows about where it
came from, the governed product catalog that feeds it, and what happens to a
template after it is in use. It also documents the E2E harness rebuild, because
the harness is what makes every claim below checkable.

---

## 1. The protocol knowledge extension

A protocol version recorded WHAT to do. It now also records **where that came
from** and **when it stopped being true**.

### Dependency edges

`protocol_version_sources` records every governed source a version depends on:
an exact catalog product version, a governed intervention class, a governed
reference, or "practitioner-supplied" for a dose that points at no governed row
at all. The last one matters: recording it keeps *"where did this come from?"*
answerable for **every** dose rather than only the governed ones.

The edges are **derived from the items by a trigger**, not written by each RPC
that touches items. Four call sites is four places to forget, and forgetting is
silent — the protocol saves fine and simply never reports that its source
moved. Deriving them means a future RPC that writes items gets correct edges
without knowing this feature exists.

### Staleness marks; it never edits

When a governed source reaches a terminal state — a reference withdrawn or
superseded, a product version leaving `verified` — every dependent version is
**marked stale**. The protocol itself is not edited, not withdrawn, and not
deleted.

That is deliberate and it is the whole design:

> A practitioner keeps reading exactly the words they approved, and
> additionally learns the source underneath them changed.

Editing it for them would mean the record no longer says what was actually
prescribed. The acceptance suite proves this by capturing the protocol's text
before the cascade and diffing it afterwards — a test that only asserted the
flag was set would pass even if the cascade had rewritten the protocol.

Acknowledging a re-review records **who looked and when**; it deliberately does
**not** clear `source_stale_at`. That the ground moved is permanent history.
What changes is that a named person has since looked at it.

### Snapshots, not joins

Monitoring requirements, stopping rules, contraindications, follow-up interval,
jurisdiction sensitivity and the class code are **copied onto the item at save
time** from the governed intervention class. Exact product identity — SKU, UPC,
label capture time, label hash — is copied from the catalog row, **never from
the payload**: a client-supplied SKU would let a caller relabel one product as
another while keeping the verified badge.

If items joined to the class instead, editing a class would silently rewrite
protocols that were already approved against it. Acceptance check 35 proves the
snapshot holds by editing a draft class after the fact and confirming the
protocol is unchanged.

An item with **no** governed class keeps empty arrays and NULL intervals, which
render as **"Unknown"**. Not "no monitoring required" — that is a fabricated
clinical claim.

### A dose must name its source

`private.protocol_dose_provenance_gate` refuses approval when any product item
carries a dose with no `dose_source_kind`, and **names the offending items**.

Draft stays permissive on purpose: a practitioner types the dose before they
attach the label, and refusing the keystroke only teaches them to record it
somewhere the system cannot see.

**Both** approval paths are gated — patient protocols *and* templates. Gating
only the copies would catch the mistake one step too late, every time: a
template is what every future protocol is started from, so an unsourced dose
there propagates.

---

## 2. The product catalog

`get_product_catalog` and `get_product_label_detail` return everything clinical
under a `clinical` key and everything commercial under `commercial`, built from
separate tables.

### The commercial firewall is a shape, not a convention

No clinical expression reads a commercial table. That is asserted **on the
function body**, counting occurrences — with an empty commercial table an
output-only check passes while proving nothing.

The list view is sent a **count** of commercial links and never a URL, so it
physically cannot sort, rank or filter by one. The UI renders commercial data
in its own region, below everything clinical.

An affiliate link with no completed disclosure is **surfaced as incomplete**,
not quietly tolerated, and the notice says it must not be shown to a patient.

### Unknown stays Unknown

`exact_label` holds only what was captured from a label. Absent keys come back
NULL and render as **"Unknown"** — never "None", and never blank:

- **"None"** is a clinical claim ("this product contains no allergens") that
  nobody made.
- **Blank** is the same claim with the evidence hidden.

Nothing is inferred from a product name — not an ingredient, not a warning, not
a regulatory status.

### Verification is attributable

`verification_state` is **derived** from whether a named person recorded a
check. The RPC requires owner/admin; a practitioner alone is refused. The UI
will not submit without a note saying what was checked, because a verification
with no such statement is not evidence.

### Honest empty state

An empty registry renders empty and carries the database's own explanation of
why. No sample products: a placeholder is indistinguishable from a real product
at a glance.

---

## 3. Template lifecycle

| Operation | Behaviour |
| --- | --- |
| Create | Draft. Nothing is supplied — a template nobody wrote is a clinical recommendation nobody made. |
| Duplicate | A detached copy carrying dose provenance and the governance snapshot forward. Editing it never reaches the original. |
| Publish | **Gated** on dose provenance. Refused if the template is superseded. |
| Safety review | An **append-only** log storing the unsourced-dose count actually observed. |
| Supersede | Points forward; never deletes. Refuses cycles by walking the chain. |
| Compare | Structured diff, dose changes called out separately. |
| Patient preview | **Derived on read, never stored.** |

Some of these deserve their reasons stated.

**Supersede, not delete.** Protocols already started from a template must keep
resolving, so the row stays readable and simply stops being offered as a
starting point. Cycle detection walks the chain rather than checking one hop:
A→B→A is still a cycle, and a cycle means *"what should I use instead?"* never
terminates.

**Safety review as a log, not a flag.** A boolean that can be flipped back
records nothing. A changed conclusion is a new review, and the earlier one
stays readable. The table refuses UPDATE and DELETE.

**Compare matches items by label**, which is what a reviewer reads. Matching by
row id would report every item as removed-and-added after any save, because a
save replaces items wholesale — a diff that always says "everything changed" is
a diff nobody reads. The response says so, so a renamed item is not mistaken
for a replacement.

Comparison works **across** templates: comparing a duplicate against the
template it came from is the commonest review there is, and the first
implementation refused exactly that. Patient protocol versions are refused on
either side, because they are reachable only through `can_access_patient` and
this path would sidestep it.

**The patient preview is derived, never stored.** A saved copy drifts from the
protocol it claims to describe, and the drift is invisible. An item with no
recorded dose shows **no dose** — never a plausible default, because a patient
cannot tell a real instruction from a tidy-looking guess.

---

## 4. Why database refusal text is not shown to the operator

The governed RPCs raise carefully worded refusals that name the offending item.
Surfacing them verbatim was tried and **reverted**.

The transport cannot tell an authored refusal from a Postgres internal that
happens to share a SQLSTATE and carries constraint names or conflicting
**values** with it. An existing safety test asserts that database text for
`55000` must not reach the client, and it is right.

The actionable detail reaches the operator through a **structured read**
instead: `get_protocol_template_detail` returns `unsourcedDoseCount` and each
item marked with whether its dose names a source, and the template surface
renders that. The refusal stays opaque; the explanation comes from data
designed to be shown.

This is the honest resolution rather than the convenient one: the requirement
is that the operator learns which item, not that the exception carries it.

---

## 5. The E2E harness

### What was wrong

Each suite reset only its own domain. Running the whole battery in one process
left every later suite reading rows an earlier one had created. The symptom was
always a later suite's first **honest-empty-state assertion** failing — a
harness defect wearing the costume of a product defect.

The tempting fixes were all wrong:

- Weakening the empty-state assertions would delete the point of those suites.
- Pinning a spec order means the battery has stopped testing order.
- Running each spec in its own process is not a fix; it is a way of not looking.

### What replaced it

`e2e/support/backend.ts` exposes `resetBackend()`, called in every spec's
`beforeAll`. It restores the whole fixture backend from a load-time deep
snapshot, so a suite always runs against exactly the state it was written for.
It **throws loudly** if the reset does not land — a silent failure here would
surface later as an unrelated suite failing, which is the diagnosis problem the
helper exists to remove.

`scripts/check-stub-reset-coverage.mjs` is a gate: every mutable top-level
binding in the stub must be snapshotted, reassigned by a reset function, or
declared immutable **with a reason**. "It looked constant" is how a mutable one
gets waved through. The gate also flags **double coverage**, where a snapshot
restores a binding and a domain reset then reassigns it — the restored contents
are discarded and whichever runs last silently wins.

The gate immediately found `labReports`, which looked like read-only reference
data but gains a row when a lab report is uploaded, so an uploaded report was
leaking into every later suite.

### The order-independence proof

`npm run test:e2e:order` runs the canonical battery **twice** — default order
and reversed — and requires equal passing totals, zero failures, and a non-zero
count (zero-passed-zero-failed is what a misconfigured run looks like, and it
would otherwise report success).

Reversal rather than shuffling: a shuffled run that passes once proves nothing
repeatable and a failure is hard to reproduce. Reversal is deterministic, is
the maximally different ordering, and puts every suite both before and after
every other suite across the two runs.

The script **owns the fixture backend's lifecycle** and refuses to run against
one it did not start. That is not fussiness: an earlier run adopted a stray
stub left over from an aborted session, the stub died mid-run, and the result
was a dozen unrelated suites failing in `beforeAll` with no visible cause. The
script now captures the stub's output and names a mid-run death explicitly
instead of letting it masquerade as suite failures.

### Running it

```bash
node scripts/live-stub-server.mjs &          # or let the proof start its own
APP_EDITION=clinical npm run build
E2E_LIVE=1 \
  TRPC_BASE_URL=http://127.0.0.1:3999/api/trpc \
  CLINICAL_SUPABASE_URL=http://127.0.0.1:3999 \
  CLINICAL_SUPABASE_ANON_KEY=stub \
  CLINICAL_DEMO_EMAIL=demo@local CLINICAL_DEMO_PASSWORD=demo \
  CLINICAL_ORG_ID=org-fixture \
  npm run test:e2e:order
```

`npm run check:stub-reset` runs the coverage gate on its own.

---

## 6. Test-only fixtures vs. real governed content

The stub exposes two **test-only** control endpoints,
`/__control/seed-catalog-label` and `/__control/seed-template-items`. They exist
because item editing lives in the protocol draft editor rather than the template
surface, so driving it through the UI would be testing a different screen.

They are fixture-only and reach nothing real. **No governed content was created
by this phase.** Product labels, intervention classes, protocol templates and
knowledge references all remain at zero in the clinical project; the catalog
holds one pre-existing row explicitly labelled `(Demo)` from Phase 2.

Everything the browser proofs assert about a populated catalog or template is
asserted against synthetic fixtures, and the empty-state proofs assert the real,
empty state.
