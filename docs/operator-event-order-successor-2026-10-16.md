# Blocked operator event-order successor — 2026-10-16

The operator clinic list could display a suspension before the bootstrap event when both events had the same `occurred_at` and the suspension UUID sorted first. That is an ordering defect in the operator view, not a change to clinic authority or stored events. The parent candidate remains unmodified.

## Candidate identity and scope

- Parent: `workforce-bootstrap-operator-listing.sql`, normalized LF SHA-256 `5a7af23d78387eab099e2c749b87edc52234b61eca8893cc54bf37d38639351b`.
- Blocked, unregistered successor: `workforce-bootstrap-operator-event-order.sql`, normalized LF SHA-256 `a03d96ed3dd676ec105807c9da92ebde55b5f801f39ad94fe4bba993a5cd2559`.
- Guarded preserving rollback: `workforce-bootstrap-operator-event-order-rollback.sql`, normalized LF SHA-256 `c7b4ba0735d8b743a5614bdaa8b98a29c3331e2c800dd1892659802c8a654dfb`.

The successor changes only the event aggregation order: `bootstrapped` precedes later status events even when timestamps tie. Both files guard the exact function body they expect. They do not write clinic rows, change memberships, alter grants, activate a release, or authorize any real patient data.

## Evidence and limits

The database regression first failed on the parent with `[suspended, bootstrapped]` after a forced timestamp collision and inverse UUID ordering; it passes with the successor. The disposable test database temporarily disables and then restores the append-only trigger to construct that otherwise forbidden clock-collision fixture. The rollback test verifies the exact parent function-body digest, retained operator execute privilege, and unchanged clinic/event row counts. The full target suite passes 24/24.

This is source and local database evidence only. No production or qualification database has received the successor. Before any future registration or application, verify the exact parent artifact and live function-body digest, rehearse the forward and rollback transaction on a disposable copy, review the current release mapping, and obtain separate authorization for any AWS write. PHI and production activation remain off.
