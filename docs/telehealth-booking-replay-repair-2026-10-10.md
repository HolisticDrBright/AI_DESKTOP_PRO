# Telehealth booking replay repair

Consumer booking creation now uses the held slot's UUID as the stable request identity. The request row and slot transition remain one conditional DynamoDB transaction. Repeating the same input returns the current saved request, including cancellation or rescheduling, without reserving again. A different input under the same hold, or a different owner, is refused.

The private SHA-256 input binding is not returned to either user role and does not establish consent or provider authority. Initial booking still checks the current held slot and any supplied consent artifact. Recovery uses a strongly consistent exact-key read; a transaction failure with no matching saved row remains an unavailable, uncertain outcome and never causes an automatic second transaction. Existing date-prefixed request rows remain readable through the complete bounded request lookup. Consumer index entries keep their date-prefixed ordering.

The eleven fictional-store regression cases cover lost committed and uncommitted responses, competing requests, changed input, ownership isolation, property ordering, restarted handlers, cancellation and rescheduling. These tests do not establish real DynamoDB, provider or device acceptance. V2 still needs a sealed pending-booking journal and recovery controls; refreshing an eventually consistent list is not proof that an admitted booking did not commit. This repair is limited to replaying the same original hold, not a cross-device recovery workflow or cancellation settlement.

No AWS deployment, migration, provider call, paid mobile build, PHI activation or production consent approval accompanies this source change. All six original commercial phases retain their outstanding hosted, device, provider and human gates.
