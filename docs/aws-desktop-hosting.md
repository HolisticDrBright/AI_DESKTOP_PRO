# AWS Desktop web hosting

## Current environment

The practitioner web interface is hosted as a locked Next.js container in the
dedicated AWS synthetic-staging account. AWS CodeBuild builds the image, Amazon
ECR stores it, and AWS App Runner provides the managed HTTPS endpoint. The
initial deployment is synthetic-only and must not receive real patient data.

Deployed 2026-08-18:

- URL: `https://penrnyupn3.us-east-2.awsapprunner.com`
- CloudFormation stack: `ai-desktop-pro-synthetic-web`
- App Runner service: `ai-desktop-pro-synthetic-staging`
- Region: `us-east-2`
- Image source commit: `4c23d54f0e189bf06cb428a085dbcef319461f52`
- Deployed image tag: `4c23d54f0e189bf06cb428a085dbcef319461f52`

Runtime posture:

- `APP_EDITION=clinical`
- `APP_RUNTIME_ENV=staging`
- `NEXT_PUBLIC_APP_ENV=staging`
- `NEXT_PUBLIC_USE_LIVE_API=true`
- `CLINICAL_DATA_PLANE=supabase_staging`
- `CLINICAL_AWS_RUNTIME_MODE=synthetic`
- `RealPatientDataAllowed=false` remains authoritative in the AWS clinical
  core; hosting this UI does not change that boundary.

No service-role key, provider API key, password, or patient data is stored in
the image. The modern Supabase publishable key is passed as runtime
configuration and is used only by server-side adapters together with the
signed-in practitioner's JWT. Authorization remains in the practitioner's JWT
and database row-level-security policies, not in the publishable key.

## Deployment boundary

The container builds with `APP_EDITION=clinical`, so the repository's edition
lock continues to refuse demo binaries and mock-data fallback. The runtime
configuration is an explicit allowlist. App Runner receives no AWS instance
role and therefore cannot read unrelated account resources.

The generated App Runner URL is a staging URL. A production custom domain, WAF
policy, production data plane, operational monitoring, and real-PHI approval
remain separate activation gates.

## BAA milestone

The AWS Organizations Business Associate Addendum was confirmed active on
2026-08-18. This clears the AWS contractual prerequisite, but it does not make
this staging deployment suitable for real PHI by itself. The current Desktop
still uses `CLINICAL_DATA_PLANE=supabase_staging` and remains explicitly
synthetic-only. Production activation requires the production AWS clinical
data plane, a documented risk analysis, verified access/audit/backup/recovery
controls, incident procedures, and appropriate agreements for every downstream
provider that will create, receive, maintain, or transmit PHI.

Before an image is pushed, CodeBuild starts that exact image and requires its
same-container `/api/health` endpoint to answer successfully. A container that
only compiles but cannot boot never reaches ECR or App Runner.
