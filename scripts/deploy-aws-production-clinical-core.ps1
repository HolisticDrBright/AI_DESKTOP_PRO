param(
  [string]$FoundationStackName = "ai-longevity-production-clinical-foundation",
  [string]$AwsProfile = "ai-production",
  [string]$Region = "us-east-2",
  [switch]$ConfirmPhiDisabledSchemaOnly
)

$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
Set-Location $root
if (-not $ConfirmPhiDisabledSchemaOnly) {
  throw "Refusing operation: explicitly confirm the PHI-disabled schema-only deployment."
}
if (-not (Get-Command aws -ErrorAction SilentlyContinue)) {
  throw "AWS CLI is required. No cloud operation was attempted."
}

$account = aws sts get-caller-identity --profile $AwsProfile --query Account --output text
$outputs = aws cloudformation describe-stacks --profile $AwsProfile --region $Region `
  --stack-name $FoundationStackName --query "Stacks[0].Outputs" --output json | ConvertFrom-Json
function Output([string]$key) {
  $entry = $outputs | Where-Object OutputKey -eq $key
  if (-not $entry) { throw "Foundation output $key is missing." }
  return $entry.OutputValue
}
$phiAllowed = Output "PhiAllowed"
$environment = Output "Environment"
$classification = Output "DataClassification"
if ($phiAllowed -ne "false" -or $environment -ne "production-clinical" `
  -or $classification -ne "clinical_phi_target") {
  throw "Foundation stack is not the reviewed PHI-disabled production boundary."
}
if ((Output "DatabaseClusterArn") -notmatch ":$account`:cluster:") {
  throw "Production database account does not match the active AWS identity."
}

npm run check:aws-production-clinical-core
if ($LASTEXITCODE -ne 0) { throw "Production clinical-core gate failed." }
npm run build:aws-production-migration-operator
if ($LASTEXITCODE -ne 0) { throw "Production migration operator build failed." }

try {
  $env:AWS_PROFILE = $AwsProfile
  $env:AWS_REGION = $Region
  $env:PHI_ALLOWED = "false"
  $env:CONFIRM_PRODUCTION_SCHEMA_ONLY = "true"
  $env:EXPECTED_AWS_ACCOUNT_ID = $account
  $env:CLINICAL_DATABASE_CLUSTER_ARN = Output "DatabaseClusterArn"
  $env:CLINICAL_DATABASE_SECRET_ARN = Output "DatabaseSecretArn"
  $env:CLINICAL_DATABASE_NAME = Output "DatabaseName"
  node dist/aws-clinical-core/production-migration-operator/index.cjs apply
  if ($LASTEXITCODE -ne 0) { throw "Production schema migration refused or failed." }
} finally {
  "AWS_PROFILE","AWS_REGION","PHI_ALLOWED","CONFIRM_PRODUCTION_SCHEMA_ONLY",
    "EXPECTED_AWS_ACCOUNT_ID","CLINICAL_DATABASE_CLUSTER_ARN",
    "CLINICAL_DATABASE_SECRET_ARN","CLINICAL_DATABASE_NAME" |
    ForEach-Object { Remove-Item "Env:$_" -ErrorAction SilentlyContinue }
}

Write-Host "Production clinical schema applied with PHI disabled and zero clinical records."
