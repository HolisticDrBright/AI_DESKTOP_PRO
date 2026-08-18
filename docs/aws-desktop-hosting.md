# AWS Desktop web hosting

## Current environment

The practitioner web interface is hosted as a locked Next.js container in the
dedicated AWS synthetic-staging account. AWS CodeBuild builds the image, Amazon
ECR stores it, and AWS App Runner provides the managed HTTPS endpoint. The
initial deployment is synthetic-only and must not receive real patient data.

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
the image or source archive. The Supabase publishable key is injected at
runtime from AWS Secrets Manager and is used only by server-side adapters
together with the signed-in practitioner's JWT.

## Deployment boundary

The container builds with `APP_EDITION=clinical`, so the repository's edition
lock continues to refuse demo binaries and mock-data fallback. The runtime
configuration is an explicit allowlist. App Runner receives no AWS service
role beyond read access to the one publishable-key secret.

The generated App Runner URL is a staging URL. A production custom domain, WAF
policy, production data plane, operational monitoring, and real-PHI approval
remain separate activation gates.
