# Clinic qualification transport verification

The current clinic-record candidate remains revision 4 at migration 116. The older Claude return handoff for d236b766, revision 3 at migration 114, describes repairs already retained in this source chain. Its deployment instructions must not replace the selected successor or bypass separate schema and release reviews.

## Transport repairs

The actual hosted port factory now pins the credential provider's STS endpoint as well as the RDS endpoint to Ohio. It refuses an unknown route, an invalid bearer header or an oversized request before HTTP dispatch. JSON responses are read as a bounded stream, with a one MiB decoded limit, strict UTF-8 and declared-length checks where the body is not compressed. The limit accommodates the SQL reader's 256 KiB payload budget plus JSON escaping and envelope metadata. An invalid response cannot supply passing case evidence.

Database readbacks run in a read-only transaction and return only after the rollback response confirms HTTP 200 and `Rollback complete`. A malformed transaction identifier, failed rollback or unrecognized rollback receipt refuses the readback. These controls do not create an upgrade, fixture, provider or activation authority.

`npm run test:clinic-records-hosted-ports` exercises the real factory with intercepted SDK and HTTP transports. Its cases cover route and header refusals, byte bounds, compressed responses, split and invalid UTF-8, valid large pages, pinned configuration, read-only SQL and confirmed rollback. No credential is resolved and no AWS request is made by these tests. The separate embedded runner suite executes the thirty mandatory journeys against the selected artifact; neither suite is hosted acceptance.

## AWS observation and source evidence

The October 10 read-only observation ran on clean source `0d6dcb1ecbc1180bfd95ec68783870f40b3eb2e6`, before this transport increment. It found the qualification database at the exact 107-migration history, read all 209 historical application tables including 72 protected tables, and confirmed rollback. It observed 56 historical rows and 1,058 metadata objects. It establishes neither canonical managed-schema admission nor an approved 112-to-116 upgrade, protected-row access at that successor, commit custody or hosted candidate acceptance.

The source preceding this increment completed the full local suite with 6,973 passing tests and 11 skips. Its two exact-head CI runs, 38104714060 and 38104716161, succeeded. The deployed-backend acceptance step was skipped, so green CI is not evidence that those hosted journeys ran. Those results do not qualify changes made after that commit; the new increment needs its own tests and CI.

## Remaining readiness work

Complete the independently compiled managed-runtime profile and preserving forward operator, including canonical admission and durable uncertain-commit recovery. Obtain exact predecessor and successor reviews before applying either chain. Then deploy matched fictional candidates and run all hosted positives and negatives. Matched mobile and Desktop releases, physical iOS and Android testing, provider and store acceptance, and policy and agreement reviews remain separate gates. PHI and production activation remain disabled; paid mobile builds remain on hold.
