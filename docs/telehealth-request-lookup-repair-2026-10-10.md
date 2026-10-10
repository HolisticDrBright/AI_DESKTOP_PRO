# Telehealth request lookup repair

The appointment authority previously searched only one filtered DynamoDB page. An existing request beyond the first 200 evaluated items could appear missing, blocking cancellation, rescheduling, consent validation, visit actions and payment reconciliation.

The lookup now follows same-clinic request cursors with strongly consistent base-table reads, up to 20 pages. It reports not-found only after the query reaches its final page. Repeated or foreign cursors, duplicate matches, a mismatched record and an exhausted page budget refuse before a mutation or provider call. Consistency is per read, not an atomic multi-page snapshot.

Eight regression cases exercise the actual handler with fictional DynamoDB replies. They cover an empty filtered page followed by an existing request, final absence and six fail-closed cases. This does not implement durable booking-operation settlement, paginated consumer-list presentation or a direct request-key index. A reviewed indexed lookup remains advisable as appointment volume grows; the bounded failure is not commercial scale acceptance.

No table, route, IAM grant, provider setting, migration or PHI flag changes. Hosted large-partition lookup and negative cases remain required on the exact deployed candidate. See [AWS DynamoDB pagination](https://docs.aws.amazon.com/amazondynamodb/latest/developerguide/Query.Pagination.html) for filtered-page semantics.
