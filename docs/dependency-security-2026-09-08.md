# Dependency security repair — September 8, 2026

**Source candidate only; deployment of this security patch is still required.**
PHI remains disabled and no clinical/content policy was changed.

Audit found critical Next.js advisories in locked 15.5.22 and high-severity sharp
findings in the 0.35.0 override. Applied the current patched 15.x release:
Next.js/eslint-config-next 15.5.25, sharp 0.35.4. The upgrade skill's version and
official migration checks were used; no major-version codemod was applicable.
Also patched Vitest 4.1.5 to 4.1.11 for its mocker file-read advisory.

After the update, both production-only and full `npm audit` report **zero known
findings**. Type checking, 1,163 unit tests (10 skipped), explicit clinical build,
and the 268-chunk client-boundary scan passed. Four existing lint warnings remain.
This is not an ECR/container scan, penetration test, or proof the existing hosted
service has been patched. Rebuild/scan the exact candidate and deploy through the
existing release controls before treating the running services as repaired.

The paired V2 audit is **not clean**: its candidate remediates compatible locked
dependencies and mitigates the unpatched build-time image parser; three lower-
severity package groups remain for review. See V2
`expo/docs/dependency-security-2026-09-08.md` for the exact residuals.

Primary advisories:
- [Next.js Windows RCE](https://github.com/vercel/next.js/security/advisories/GHSA-p293-qw3h-jr36)
- [Next.js AVIF/image optimization](https://github.com/vercel/next.js/security/advisories/GHSA-2xp9-vwfh-vxw4)
- [sharp/libheif](https://github.com/lovell/sharp/security/advisories/GHSA-rgj7-g3m4-5g8c)
- [Vitest mocker](https://github.com/vitest-dev/vitest/security/advisories/GHSA-82fw-gwwq-j7x9)
