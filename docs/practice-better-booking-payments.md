# Patient booking and telehealth commerce

## Implemented in contract v2

- Workforce publishes explicit future openings with visit types, price, time zone, and cancellation policy.
- The consumer API returns only future, unbooked openings for the requested visit type.
- A consumer receives a ten-minute ownership-bound hold before creating a request.
- The request and slot consumption are one DynamoDB transaction with optimistic conditions.
- Workforce scheduling creates or updates a canonical AWS appointment record in the same transaction as the request status.
- Zoom remains fail-closed until its BAA gate and exact secret are registered.

## Provider activation still required

- Stripe test secret and signed webhook secret are not registered. No card is collected or charged.
- Zoom Server-to-Server OAuth credentials and the Zoom BAA gate are not registered. No meeting is created.
- SES production access is pending. Cognito remains on its default sender until the production identity and sending account are ready.

No PHI or live payment flag is enabled by this release.
