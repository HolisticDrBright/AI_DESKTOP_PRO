# AWS Desktop web hosting

## Current environment

The practitioner web interface is hosted as a locked Next.js container in the
dedicated AWS synthetic-staging account. AWS CodeBuild builds the image, Amazon
ECR stores it, and AWS App Runner provides the managed HTTPS endpoint. The
initial deployment is synthetic-only and must not receive real patient data.

Current synthetic endpoint:

- URL: `https://penrnyupn3.us-east-2.awsapprunner.com`
- CloudFormation stack: `ai-desktop-pro-synthetic-web`
- App Runner service: `ai-desktop-pro-synthetic-staging`
- Region: `us-east-2`
- The exact source commit, image tag, digest, and scan result are recorded again
  after every deployment.

Runtime posture:

- `APP_EDITION=clinical`
- `APP_RUNTIME_ENV=staging`
- `NEXT_PUBLIC_APP_ENV=staging`
- `NEXT_PUBLIC_USE_LIVE_API=true`
- `CLINICAL_DATA_PLANE=aws`
- AWS Cognito workforce sign-in
- AWS API Gateway clinical API origin
- `AWS_CLINICAL_ADAPTER_READY=true`
- `PHI_ALLOWED=false`
- `CLINICAL_AWS_RUNTIME_MODE=synthetic`
- `RealPatientDataAllowed=false` remains authoritative in the AWS clinical
  core; hosting this UI does not change that boundary.

No service-role key, provider API key, password, patient data, Supabase URL, or
Supabase key is stored in or passed to the hosted image. Practitioner sign-in
uses the synthetic AWS Cognito workforce pool. The server forwards the
practitioner's Cognito access token only to the allowlisted synthetic AWS API
Gateway origin, where tenant and role authorization are enforced.

The owner-operated synthetic practitioner identity uses
`info@AILongevityPro.app`. Password reset is delivered to that address so the
owner chooses the password; no agent-generated password is shared. Because
workforce MFA is mandatory, a first sign-in can enroll a software authenticator
inside the Desktop and subsequent sign-ins require its six-digit code.

## Deployment boundary

The container builds with `APP_EDITION=clinical`, so the repository's edition
lock continues to refuse demo binaries and mock-data fallback. The runtime
configuration is an explicit allowlist. App Runner receives no AWS instance
role and therefore cannot read unrelated account resources.

The generated App Runner URL is a staging URL. App Runner is used only for the
synthetic environment and is forbidden from the production PHI architecture.
A production custom domain, private production workload, WAF policy,
operational monitoring, and real-PHI approval remain separate activation
gates.

## BAA milestone

The AWS Organizations Business Associate Addendum was confirmed active on
2026-08-18. This clears the AWS contractual prerequisite, but it does not make
this staging deployment suitable for real PHI by itself. Removing Supabase
from the hosted synthetic Desktop closes a runtime-migration gap; it does not
activate the production PHI environment. Production activation requires the
private production AWS clinical workload, completion of the operation port,
a documented risk analysis, verified access/audit/backup/recovery controls,
incident procedures, and appropriate agreements for every downstream provider
that will create, receive, maintain, or transmit PHI.

Before an image is pushed, CodeBuild starts that exact image and requires its
same-container `/api/health` endpoint to answer successfully. A container that
only compiles but cannot boot never reaches ECR or App Runner.

## Distroless production-candidate evidence

On 2026-08-18, AWS CodeBuild built commit
`023839705beedfa93b376f28c5926d114f99054c` from
`agent/aws-hipaa-production-phase1`. The runtime stage uses
`gcr.io/distroless/nodejs22-debian12:nonroot`, contains no shell or package
manager, and passed the same-container health check. The image was pushed to
ECR for evidence only and was not deployed to App Runner.

- ECR digest: `sha256:1ea79c351c0da95bb92abfd8e9d3ccb4fc554fec7e14d0c5032a7acc5e1b6aa5`
- Basic ECR scan status: `COMPLETE`
- Critical findings: `0`
- High findings: `0`
- Total image findings: `0`

This closes the prior Debian/Perl image findings for this candidate. It does
not replace source-dependency review, penetration testing, or the final scan
of the exact production release image.
