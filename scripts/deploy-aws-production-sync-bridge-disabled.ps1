param(
  [Parameter(Mandatory = $true)][string]$ArtifactBucket,
  [Parameter(Mandatory = $true)][ValidatePattern('^[0-9a-f]{40}$')][string]$SourceVersion,
  [string]$FoundationStackName = "ai-longevity-production-clinical-foundation",
  [string]$StackName = "ai-longevity-production-patient-sync-disabled",
  [string]$AwsProfile = "ai-production",
  [string]$Region = "us-east-2",
  [switch]$ConfirmPhiDisabledDeployment
)

$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
Set-Location $root
if (-not $ConfirmPhiDisabledDeployment) { throw "Refusing deployment without explicit PHI-disabled confirmation." }
foreach ($command in @("aws","git","npm")) {
  if (-not (Get-Command $command -ErrorAction SilentlyContinue)) { throw "$command is required." }
}
$account = aws sts get-caller-identity --profile $AwsProfile --query Account --output text
if ($LASTEXITCODE -ne 0 -or $account -ne "173535830222") { throw "Reviewed production account required." }
$head = git rev-parse HEAD
if ($LASTEXITCODE -ne 0 -or $head -ne $SourceVersion -or (git status --porcelain)) {
  throw "Exact clean committed source is required."
}
$remote = git ls-remote --heads origin
if ($LASTEXITCODE -ne 0 -or -not ($remote -match "(?m)^$SourceVersion\s")) {
  throw "Exact source must be present on an origin branch."
}
$outputs = aws cloudformation describe-stacks --profile $AwsProfile --region $Region `
  --stack-name $FoundationStackName --query "Stacks[0].Outputs" --output json | ConvertFrom-Json
function Output([string]$key) {
  $entry = $outputs | Where-Object OutputKey -eq $key
  if (-not $entry) { throw "Foundation output $key is missing." }
  return $entry.OutputValue
}
if ((Output "PhiAllowed") -ne "false" -or (Output "Environment") -ne "production-clinical" `
  -or (Output "DataClassification") -ne "clinical_phi_target") {
  throw "Foundation is not PHI-disabled."
}

npm run check:aws-production-sync-bridge
if ($LASTEXITCODE -ne 0) { throw "Production sync bridge gate failed." }
$artifactDir = Join-Path $root "dist\aws-clinical-core\production-sync-bridge"
$zipPath = Join-Path $root "dist\aws-clinical-core\production-sync-bridge.zip"
if (Test-Path -LiteralPath $zipPath) { Remove-Item -LiteralPath $zipPath }
Compress-Archive -LiteralPath (Join-Path $artifactDir "index.cjs") -DestinationPath $zipPath
$digest = (Get-FileHash -Algorithm SHA256 -LiteralPath $zipPath).Hash.ToLowerInvariant()
$artifactKey = "clinical-core/production-sync-bridge/$SourceVersion/$digest.zip"
$keyArn = Output "ClinicalCoreKeyArn"
aws s3 cp $zipPath "s3://$ArtifactBucket/$artifactKey" --profile $AwsProfile --region $Region `
  --only-show-errors --sse aws:kms --sse-kms-key-id $keyArn
if ($LASTEXITCODE -ne 0) { throw "Encrypted sync artifact upload failed." }

$parameters = @(
  "ClinicalApiId=$(Output 'ClinicalApiId')",
  "DatabaseClusterArn=$(Output 'DatabaseClusterArn')",
  "DatabaseSecretArn=$(Output 'DatabaseSecretArn')",
  "DatabaseName=$(Output 'DatabaseName')",
  "ClinicalCoreKeyArn=$keyArn",
  "LambdaCodeBucket=$ArtifactBucket",
  "LambdaCodeKey=$artifactKey",
  "SourceVersion=$SourceVersion",
  "PhiAllowed=false",
  "ActivationState=blocked"
)
aws cloudformation deploy --profile $AwsProfile --region $Region --stack-name $StackName `
  --template-file "infra/aws-clinical-core/production-sync-bridge-candidate.json" `
  --capabilities CAPABILITY_IAM --no-fail-on-empty-changeset --parameter-overrides $parameters
if ($LASTEXITCODE -ne 0) { throw "PHI-disabled sync bridge deployment failed." }

$stack = aws cloudformation describe-stacks --profile $AwsProfile --region $Region --stack-name $StackName `
  --query "Stacks[0]" --output json | ConvertFrom-Json
$deployed = @{}
foreach ($entry in $stack.Outputs) { $deployed[$entry.OutputKey] = $entry.OutputValue }
if ($stack.StackStatus -notmatch "^(CREATE|UPDATE)_COMPLETE$" -or $deployed.PhiAllowed -ne "false" `
  -or $deployed.ActivationState -ne "blocked" -or $deployed.DataPlaneEnabled -ne "false" `
  -or $deployed.SourceVersion -ne $SourceVersion) { throw "Deployed sync bridge is not closed." }
$roleName = aws cloudformation describe-stack-resource --profile $AwsProfile --region $Region --stack-name $StackName `
  --logical-resource-id SyncBridgeRole --query "StackResourceDetail.PhysicalResourceId" --output text
$policies = @(aws iam list-role-policies --profile $AwsProfile --role-name $roleName --query PolicyNames --output json | ConvertFrom-Json)
$attached = @(aws iam list-attached-role-policies --profile $AwsProfile --role-name $roleName --query AttachedPolicies --output json | ConvertFrom-Json)
if ($policies.Count -ne 1 -or $policies[0] -ne "EncryptedSyncLogging" -or $attached.Count -ne 0) {
  throw "Disabled worker unexpectedly has data permissions."
}
$schedule = aws cloudformation describe-stack-resource --profile $AwsProfile --region $Region --stack-name $StackName `
  --logical-resource-id SyncWorkerSchedule --query "StackResourceDetail.PhysicalResourceId" --output text
$scheduleState = aws events describe-rule --profile $AwsProfile --region $Region --name $schedule --query State --output text
if ($scheduleState -ne "DISABLED") { throw "Production worker schedule is not disabled." }

$invokePath = Join-Path ([IO.Path]::GetTempPath()) "production-sync-disabled-$PID.json"
try {
  aws lambda invoke --profile $AwsProfile --region $Region --function-name $deployed.ApiFunctionName `
    --cli-binary-format raw-in-base64-out --payload "{}" $invokePath --output json | Out-Null
  $api = Get-Content -Raw -LiteralPath $invokePath | ConvertFrom-Json
  $apiBody = $api.body | ConvertFrom-Json
  if ([int]$api.statusCode -ne 503 -or $apiBody.error -ne "production_not_activated" -or $apiBody.phiAllowed -ne $false) {
    throw "Disabled callback did not return the bounded refusal."
  }
  aws lambda invoke --profile $AwsProfile --region $Region --function-name $deployed.WorkerFunctionName `
    --cli-binary-format raw-in-base64-out --payload "{}" $invokePath --output json | Out-Null
  $worker = Get-Content -Raw -LiteralPath $invokePath | ConvertFrom-Json
  if ($worker.posture -ne "disabled" -or $worker.phiAllowed -ne $false) {
    throw "Disabled worker did not return the bounded refusal."
  }
} finally { Remove-Item -LiteralPath $invokePath -Force -ErrorAction SilentlyContinue }

Write-Host "Production patient-sync bridge deployed closed: PHI false, schedule disabled, no data permissions."
Write-Host "Source $SourceVersion; artifact SHA-256 $digest."

