# Native lesson media reference mirror

This source branch starts from Desktop course/media integration head `421b972e`.
It adds an optional `nativeMedia` identity to a published program item while
preserving the existing HTTPS `media` slots. A combined maximum of five slots,
strict origin/artifact/digest/path validation and duplicate rejection prevent a
preview token or an unrelated object from being mistaken for a publication.
The same `programAssignments.ts`, `programLessonMedia.ts` and
`programEducationProgress.ts` contract text is mirrored into V2.

The existing production admission service still refuses this new field. The
authoring validator explicitly labels it pending admission; this branch does
not create a release row, apply SQL or make the field publishable. A successor
must verify the reference against the publication ledger, bind it to the
exact pinned curriculum version, and store immutable caption/transcript text
for that publication. Current artifacts retain digests, not prior text.

The purchased-course page says media is held only for a lesson that actually
contains media; text-only lessons no longer claim a missing video. The course
outline uses the same reviewed media schemas as a published program. It does not
load an author's private preview or the `url` inside a reference. The V2
course page and clinical program card follow the same rule. Learner delivery
still requires independent entitlement or assignment authority and a
separate exact-version read path.

Verification on final source: Desktop full suite passed 527 files, 8,359 tests
with 11 unchanged skips; typecheck, lint, clinical production build (253 pages),
strict bundle scan (327 client chunks), and the eight-case fictional browser
purchase-to-learning journey passed. Earlier test runs started while source
changed are not counted. V2's mirrored source passed 281 files, 3,325 tests
with one unchanged skip, plus typecheck, lint, TestFlight source, capability
and disclosure gates. Exact-head CI is reported only after the push completes.

No AWS, provider, schema, product/price, paid mobile build, PHI or production
change is part of this source increment.
