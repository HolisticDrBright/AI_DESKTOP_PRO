# Device-bound lab delivery claims

September 16, 2026. Original phase 2 (durable delivery reconciliation). Source
only; not deployed. Backend must deploy before the matching V2 client.

`POST /clinical-core/consumer/labs/jobs/{jobId}/delivery` with
`{contractVersion:"lab-delivery/1", deviceBindingSha256}` claims a completed
result for exactly one installation. The claim is recorded before the device
commits the result locally, is idempotent for the same binding (retry after a
failed local save increments `count`), and refuses any other binding with
`409 lab_delivery_conflict`, including a concurrent winner detected by the
conditional update. It never alters the result, the job lifecycle, cancellation
or deletion. Status and the recovery descriptor expose only the binding digest
(`delivery.bindingSha256`, plus `deliveredAt` on status), and only after a claim
exists, so older clients keep parsing. Production-owned mode applies the same
consent re-authorization to this route. Both synthetic and owned templates gain
the route (30 synthetic routes, 15 owned routes).

Source follow-up: `lab-delivery-transfer.md` adds an explicit reviewed claim
transfer to a replacement installation. It is not deployed and requires a
matching client. The historical limits below describe the original increment.

Not covered: cross-device release of a claim (a lost phone keeps its claim until
the job expires or is deleted), clinic-sync receipts, and physical two-device
acceptance. A claim is a delivery record, not proof that the device persisted
or displayed the result.
