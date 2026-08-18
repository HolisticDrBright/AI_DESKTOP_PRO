# AWS Desktop web hosting

## Current environment

The practitioner web interface is hosted through AWS Amplify Hosting's
managed Next.js compute. The initial deployment is a synthetic-only staging
environment and must not receive real patient data.

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
Amplify environment variables. The Supabase publishable key is used only by
server-side adapters together with the signed-in practitioner's JWT.

## Deployment boundary

`amplify.yml` writes an explicit allowlist of reviewed runtime settings to
`.env.production`. It must never be widened to copy all environment variables.
The hosted branch builds with `APP_EDITION=clinical`, so the repository's
edition lock continues to refuse demo binaries and mock-data fallback.

The generated Amplify URL is a staging URL. A production custom domain, WAF
policy, production data plane, operational monitoring, and real-PHI approval
remain separate activation gates.
