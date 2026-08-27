param(
  [Parameter(Mandatory = $true)][string]$FoundationStackName,
  [Parameter(Mandatory = $true)][string]$ArtifactBucket,
  [string]$ExtensionStackName = "$FoundationStackName-authenticated-api",
  [string]$Region = "us-east-2",
  [switch]$ConfirmSyntheticMigrationApplied
)

$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
Set-Location $root

if (-not (Get-Command aws -ErrorAction SilentlyContinue)) {
  throw "AWS CLI is required. No deployment was attempted."
}
if (-not $ConfirmSyntheticMigrationApplied) {
  throw "Refusing deployment: pass -ConfirmSyntheticMigrationApplied only after the reviewed migration ledger is present in synthetic Aurora."
}

npm run check:aws-clinical-core
npm run check:aws-identity-consent
npm run check:aws-authenticated-api
npm run build:aws-authenticated-api

$outputs = aws cloudformation describe-stacks --stack-name $FoundationStackName --region $Region --query "Stacks[0].Outputs" --output json | ConvertFrom-Json
function Output([string]$key) {
  $entry = $outputs | Where-Object OutputKey -eq $key
  if (-not $entry) { throw "Foundation output $key is missing." }
  return $entry.OutputValue
}
if ((Output 'PhiAllowed') -ne 'false' -or (Output 'DataClassification') -ne 'synthetic_only' -or (Output 'Environment') -ne 'synthetic-staging') {
  throw "Foundation stack is not the reviewed synthetic-only boundary."
}

$artifactDir = Join-Path $root "dist\aws-clinical-core\identity-api"
$zipPath = Join-Path $root "dist\aws-clinical-core\identity-api.zip"
if (Test-Path $zipPath) { Remove-Item -LiteralPath $zipPath }
Compress-Archive -Path (Join-Path $artifactDir "index.js") -DestinationPath $zipPath
$digest = (Get-FileHash -Algorithm SHA256 -LiteralPath $zipPath).Hash.ToLowerInvariant()
$artifactKey = "clinical-core/authenticated-api/$digest.zip"
$kmsKeyArn = Output 'ClinicalCoreKeyArn'
aws s3 cp $zipPath "s3://$ArtifactBucket/$artifactKey" --region $Region --only-show-errors `
  --sse aws:kms --sse-kms-key-id $kmsKeyArn
if ($LASTEXITCODE -ne 0) { throw "Authenticated API artifact upload failed." }

$parameters = @(
  "ClinicalApiId=$(Output 'ClinicalApiId')",
  "WorkforceUserPoolId=$(Output 'WorkforceUserPoolId')",
  "WorkforceUserPoolClientId=$(Output 'WorkforceUserPoolClientId')",
  "ConsumerUserPoolId=$(Output 'ConsumerUserPoolId')",
  "ConsumerUserPoolClientId=$(Output 'ConsumerUserPoolClientId')",
  "DatabaseClusterArn=$(Output 'DatabaseClusterArn')",
  "DatabaseSecretArn=$(Output 'DatabaseSecretArn')",
  "DatabaseName=$(Output 'DatabaseName')",
  "ClinicalCoreKeyArn=$(Output 'ClinicalCoreKeyArn')",
  "LambdaCodeBucket=$ArtifactBucket",
  "LambdaCodeKey=$artifactKey"
)

aws cloudformation deploy `
  --stack-name $ExtensionStackName `
  --template-file "infra/aws-clinical-core/identity-api-extension.json" `
  --region $Region `
  --capabilities CAPABILITY_IAM `
  --no-fail-on-empty-changeset `
  --parameter-overrides $parameters
if ($LASTEXITCODE -ne 0) { throw "Authenticated API CloudFormation deployment failed." }

Write-Host "Authenticated synthetic API extension deployed. No request payloads or credential values were printed."
