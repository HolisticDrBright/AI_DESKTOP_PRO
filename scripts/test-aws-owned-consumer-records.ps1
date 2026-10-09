param([switch]$ConfirmRollbackOnly)
$ErrorActionPreference = 'Stop'
if (-not $ConfirmRollbackOnly) { throw 'Explicit rollback-only confirmation required.' }
$account = aws sts get-caller-identity --profile ai-production --query Account --output text
if ($LASTEXITCODE -ne 0 -or $account.Trim() -ne '173535830222') { throw 'Wrong AWS account.' }
$stack = aws cloudformation describe-stacks --stack-name ai-longevity-production-clinical-foundation --profile ai-production --region us-east-2 --output json | ConvertFrom-Json
if ($LASTEXITCODE -ne 0) { throw 'Foundation unavailable.' }
$outputs = @{}
foreach ($output in $stack.Stacks[0].Outputs) { $outputs[$output.OutputKey] = $output.OutputValue }
if ($outputs.PhiAllowed -ne 'false') { throw 'PHI boundary refused.' }
$previous = @{}
$values = @{ AWS_PROFILE='ai-production'; AWS_REGION='us-east-2'; PHI_ALLOWED='false'; CONFIRM_ROLLBACK_ONLY='true'; EXPECTED_AWS_ACCOUNT_ID='173535830222'; CLINICAL_DATABASE_CLUSTER_ARN=$outputs.DatabaseClusterArn; CLINICAL_DATABASE_SECRET_ARN=$outputs.DatabaseSecretArn; CLINICAL_DATABASE_NAME=$outputs.DatabaseName }
try {
  foreach ($key in $values.Keys) { $previous[$key] = [Environment]::GetEnvironmentVariable($key,'Process'); [Environment]::SetEnvironmentVariable($key,$values[$key],'Process') }
  & node_modules/.bin/esbuild.cmd src/server/clinical-core/owned-consumer-records-acceptance.ts --bundle --platform=node --target=node22 --format=cjs --outfile=dist/aws-clinical-core/owned-consumer-acceptance/index.cjs --log-level=warning
  if ($LASTEXITCODE -ne 0) { throw 'Acceptance build failed.' }
  node dist/aws-clinical-core/owned-consumer-acceptance/index.cjs
  if ($LASTEXITCODE -ne 0) { throw 'Rollback acceptance failed.' }
} finally {
  foreach ($key in $previous.Keys) { [Environment]::SetEnvironmentVariable($key,$previous[$key],'Process') }
}
