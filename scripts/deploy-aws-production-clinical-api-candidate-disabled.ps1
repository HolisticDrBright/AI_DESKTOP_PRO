param(
  [Parameter(Mandatory = $true)][string]$ArtifactBucket,
  [Parameter(Mandatory = $true)][ValidatePattern('^[0-9a-f]{40}$')][string]$SourceVersion,
  [string]$FoundationStackName = "ai-longevity-production-clinical-foundation",
  [string]$ExtensionStackName = "ai-longevity-production-clinical-api-disabled",
  [string]$AwsProfile = "ai-production",
  [string]$Region = "us-east-2",
  [switch]$ConfirmPhiDisabledCandidateDeployment,
  [switch]$ConfirmReplaceLogOnlyBoundary
)

$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
Set-Location $root

if (-not $ConfirmPhiDisabledCandidateDeployment -or -not $ConfirmReplaceLogOnlyBoundary) {
  throw "Refusing deployment: both explicit PHI-disabled replacement confirmations are required."
}
foreach ($command in @("aws", "git", "npm")) {
  if (-not (Get-Command $command -ErrorAction SilentlyContinue)) {
    throw "$command is required. No deployment was attempted."
  }
}

$account = aws sts get-caller-identity --profile $AwsProfile --query Account --output text
if ($LASTEXITCODE -ne 0 -or $account -ne "173535830222") {
  throw "Refusing deployment outside the reviewed production member account."
}
$head = git rev-parse HEAD
if ($LASTEXITCODE -ne 0 -or $head -ne $SourceVersion) {
  throw "SourceVersion must equal the exact checked-out commit."
}
if (git status --porcelain) {
  throw "Refusing deployment from a dirty worktree. Commit and verify the exact source first."
}
$remoteHeads = git ls-remote --heads origin
if ($LASTEXITCODE -ne 0 -or -not ($remoteHeads -match "(?m)^$SourceVersion\s")) {
  throw "SourceVersion must be present on an origin branch before deployment."
}

$outputs = aws cloudformation describe-stacks --profile $AwsProfile --region $Region `
  --stack-name $FoundationStackName --query "Stacks[0].Outputs" --output json | ConvertFrom-Json
if ($LASTEXITCODE -ne 0) { throw "Production foundation lookup failed." }
function Output([string]$key) {
  $entry = $outputs | Where-Object OutputKey -eq $key
  if (-not $entry) { throw "Foundation output $key is missing." }
  return $entry.OutputValue
}
if ((Output "PhiAllowed") -ne "false" `
  -or (Output "Environment") -ne "production-clinical" `
  -or (Output "DataClassification") -ne "clinical_phi_target") {
  throw "Foundation is not the reviewed PHI-disabled production boundary."
}
if ((Output "DatabaseClusterArn") -notmatch ":$account`:cluster:") {
  throw "Foundation database does not belong to the active production account."
}
$current = aws cloudformation describe-stacks --profile $AwsProfile --region $Region `
  --stack-name $ExtensionStackName --query "Stacks[0].Outputs" --output json | ConvertFrom-Json
if ($LASTEXITCODE -ne 0) { throw "The existing log-only production API stack is required for an in-place replacement." }
$currentPhi = $current | Where-Object OutputKey -eq "PhiAllowed"
if (-not $currentPhi -or $currentPhi.OutputValue -ne "false") {
  throw "Existing production API boundary is not explicitly PHI-disabled."
}

npm run check:aws-production-clinical-api
if ($LASTEXITCODE -ne 0) { throw "Production clinical API gate failed." }
npm run build:aws-production-clinical-api
if ($LASTEXITCODE -ne 0) { throw "Production clinical API build failed." }

$artifactDir = Join-Path $root "dist\aws-clinical-core\production-clinical-api"
$zipPath = Join-Path $root "dist\aws-clinical-core\production-clinical-api.zip"
if (Test-Path -LiteralPath $zipPath) { Remove-Item -LiteralPath $zipPath }
Compress-Archive -LiteralPath (Join-Path $artifactDir "index.cjs") -DestinationPath $zipPath
$digest = (Get-FileHash -Algorithm SHA256 -LiteralPath $zipPath).Hash.ToLowerInvariant()
$artifactKey = "clinical-core/production-clinical-api/$SourceVersion/$digest.zip"
$kmsKeyArn = Output "ClinicalCoreKeyArn"
aws s3 cp $zipPath "s3://$ArtifactBucket/$artifactKey" --profile $AwsProfile --region $Region `
  --only-show-errors --sse aws:kms --sse-kms-key-id $kmsKeyArn
if ($LASTEXITCODE -ne 0) { throw "Encrypted production API artifact upload failed." }

$parameters = @(
  "ClinicalApiId=$(Output 'ClinicalApiId')",
  "WorkforceUserPoolId=$(Output 'WorkforceUserPoolId')",
  "WorkforceUserPoolClientId=$(Output 'WorkforceUserPoolClientId')",
  "ConsumerUserPoolId=$(Output 'ConsumerUserPoolId')",
  "ConsumerUserPoolClientId=$(Output 'ConsumerUserPoolClientId')",
  "DatabaseClusterArn=$(Output 'DatabaseClusterArn')",
  "DatabaseSecretArn=$(Output 'DatabaseSecretArn')",
  "DatabaseName=$(Output 'DatabaseName')",
  "ClinicalCoreKeyArn=$kmsKeyArn",
  "LambdaCodeBucket=$ArtifactBucket",
  "LambdaCodeKey=$artifactKey",
  "SourceVersion=$SourceVersion",
  "PhiAllowed=false",
  "ActivationState=blocked",
  "PilotScope=lab_intake_only",
  "PilotOrganizationId=00000000-0000-0000-0000-000000000000"
)
aws cloudformation deploy --profile $AwsProfile --region $Region `
  --stack-name $ExtensionStackName `
  --template-file "infra/aws-clinical-core/production-clinical-api-candidate.json" `
  --capabilities CAPABILITY_IAM --no-fail-on-empty-changeset `
  --parameter-overrides $parameters
if ($LASTEXITCODE -ne 0) { throw "PHI-disabled production candidate deployment failed." }

$deployed = aws cloudformation describe-stacks --profile $AwsProfile --region $Region `
  --stack-name $ExtensionStackName --query "Stacks[0].Outputs" --output json | ConvertFrom-Json
if ($LASTEXITCODE -ne 0) { throw "Deployed output verification failed." }
function DeployedOutput([string]$key) {
  return ($deployed | Where-Object OutputKey -eq $key).OutputValue
}
if ((DeployedOutput "PhiAllowed") -ne "false" `
  -or (DeployedOutput "ActivationState") -ne "blocked" `
  -or (DeployedOutput "DataPlaneEnabled") -ne "false" `
  -or (DeployedOutput "PilotScope") -ne "lab_intake_only" `
  -or (DeployedOutput "PilotOrganizationId") -ne "00000000-0000-0000-0000-000000000000" `
  -or (DeployedOutput "SourceVersion") -ne $SourceVersion) {
  throw "Deployed candidate did not preserve the closed boundary."
}

$roleName = aws cloudformation describe-stack-resource --profile $AwsProfile --region $Region `
  --stack-name $ExtensionStackName --logical-resource-id ProductionClinicalApiRole `
  --query "StackResourceDetail.PhysicalResourceId" --output text
$policyResponse = aws iam list-role-policies --profile $AwsProfile --role-name $roleName --output json | ConvertFrom-Json
$attachedResponse = aws iam list-attached-role-policies --profile $AwsProfile --role-name $roleName --output json | ConvertFrom-Json
$policies = @($policyResponse.PolicyNames)
$attached = @($attachedResponse.AttachedPolicies)
if ($policies.Count -ne 1 -or $policies[0] -ne "BoundedEncryptedLoggingOnly" -or $attached.Count -ne 0) {
  throw "Closed candidate unexpectedly has clinical data-plane permissions."
}

$functionName = DeployedOutput "FunctionName"
$invokeOutput = Join-Path ([System.IO.Path]::GetTempPath()) "alp-production-api-disabled-$PID.json"
try {
  aws lambda invoke --profile $AwsProfile --region $Region --function-name $functionName `
    --cli-binary-format raw-in-base64-out --payload "{}" $invokeOutput --output json | Out-Null
  if ($LASTEXITCODE -ne 0) { throw "Closed candidate invocation failed." }
  $response = Get-Content -Raw -LiteralPath $invokeOutput | ConvertFrom-Json
  $body = $response.body | ConvertFrom-Json
  if ($response.statusCode -ne 503 -or $body.error -ne "production_not_activated" -or $body.phiAllowed -ne $false) {
    throw "Closed candidate did not return the required bounded refusal."
  }
} finally {
  if (Test-Path -LiteralPath $invokeOutput) { Remove-Item -LiteralPath $invokeOutput }
}

Write-Host "Exact production candidate deployed closed: PHI false, activation blocked, data permissions absent, direct invocation 503."
Write-Host "Source $SourceVersion; artifact SHA-256 $digest."
