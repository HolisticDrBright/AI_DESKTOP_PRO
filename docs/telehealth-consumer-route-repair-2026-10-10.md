# Consumer booking consent route repair

The telehealth boundary now retains the authenticated pool on its actor and uses that pool's consent-artifact route. Previously a consumer booking carrying consent forwarded the patient's token to the workforce-only route and could not complete against the real identity authority.

The regression test supplies a fictional consumer JWT, asserts only the consumer artifact route receives it, creates a held-slot request with the exact artifact receipt, and checks no provider secret is read. Existing workforce-consent tests continue to require the workforce route. This is source verification, not deployed acceptance.

An appointment receipt is not a current identity-authority grant: the booking receipt still has no grant ID. Starting a connected visit requires the current verified connection and governed consent grant. The V2 approved-copy display, self-acknowledgment, grant/withdrawal and supersession journey remains engineering; unrelated intake approval cannot authorize recording.

Deploy neither this change nor consent releases as PHI-capable based on unit tests. Qualification database upgrade, exact candidate/resource reviews, hosted booking/authority tests, clinic host mapping, visit-record lifecycle and physical media acceptance remain separate. PHI stays disabled, production activation blocked and paid mobile builds held.
