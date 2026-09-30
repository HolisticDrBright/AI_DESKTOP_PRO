# Desktop launch-scope surfaces — September 30, 2026

Source verification of the enabled launch edition's surfaces. **Not hosted, not a browser
run, not a completion percentage.**

## Operation inventory

`npm run check:aws-desktop-operation-inventory` reports **226 live operations, all 226
implemented but activation-blocked, 0 enabled; 140 require provider-specific rewrites.**

Read that carefully, because the shape matters more than the number. "Implemented but
activation-blocked" is not "ready" — it means the code path exists and refuses because its
provider or its target is not configured. And the historical figure of 138 operations was
never a completion percentage; neither is 226. The only number here that means anything
about readiness is **0 enabled**, which is the correct state.

The 140 requiring provider-specific rewrites are the honest cost of the provider work in
`expo/docs/provider-test-mode-scripts-2026-09-30.md`. They are not defects.

## Empty, failed and loading are three different things

Checked on all five launch surfaces: Inbox (`InboxWorkspace`), Programs
(`ProgramsWorkspace`), Review queue (`TasksQueue`), Billing (`BillingWorkspace`) and
Calendar (`CalendarView`). Every one has an explicit empty branch, a distinct failure
presentation, and a distinct loading presentation, and every one keeps an action available
when empty.

That distinction is the point rather than a nicety. An empty review queue shown as a
failure sends a practitioner looking for a problem that does not exist. A failed load shown
as empty tells them no work is waiting when there may be plenty. Neither may be the other,
and neither may be a blank page.

`src/components/launch-surface-empty-states.test.ts` holds this: it requires all three
branches per surface, fails if a `catch` reassures with "no results" or similar, and fails
if a surface offers no action at all when empty. It is a source assertion — it checks the
branches exist and are distinct, not what they look like on screen. A render harness does
not exist in this repository, which is a real limitation and is why the visual half stays
with the physical acceptance scripts.

## Same-origin validation

Recorded in `docs/patient-care-messaging.md`: the App Runner reverse-proxy origin fix now
has one implementation, used by all eight live routes that check an origin, with
`src/app/api/live/same-origin-coverage.test.ts` failing if a ninth is written by hand or if
any route compares the browser's `Origin` against its own internal URL again. Cross-site
mutation for the remaining ~183 routes is refused by the session cookie's
`httpOnly, sameSite: lax` policy, which that test pins rather than assumes.

## Preserved deliberately

The mock education programs and their assets are untouched. Mock previews remain clearly
separate from persisted clinical workflows, and the older authoring tree was not merged —
any curriculum transfer from it stays a scoped copy with compatibility tests, which is not
part of this work.

## Not done

Organization bootstrap and selection, session expiry, sign-out, unauthorized-record and
error-recovery paths were **not** exercised through real route handlers in a browser, and
family-access approval, claim and scope filtering was not re-inspected. Those need the
hosted Desktop and a browser, which is Codex's and the owner's part.
