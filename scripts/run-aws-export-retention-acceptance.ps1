param(
  [Parameter(Mandatory = $true)][string]$FoundationStackName,
  [Parameter(Mandatory = $true)][string]$DeploymentManifestPath,
  [string]$Region = "us-east-2",
  [switch]$ConfirmSyntheticOnly
)
# Hosted acceptance of the personal-storage export job and its retention actions against the synthetic account only.
# Tokens come from this process's environment (set by run-aws-synthetic-live-acceptance.ps1's token step or an equivalent);
# nothing is printed or written except the machine-readable report under dist/qualification.
$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
Set-Location $root
if (-not $ConfirmSyntheticOnly) { throw "Refusing operation: explicitly confirm the synthetic-only boundary." }
if (-not (Get-Command aws -ErrorAction SilentlyContinue)) { throw "AWS CLI is required. No acceptance request was attempted." }
if (-not $env:CLINICAL_WORKFORCE_ID_TOKEN -or -not $env:CLINICAL_CONSUMER_ID_TOKEN) { throw "Fresh consumer and workforce Cognito ID tokens must be set in this PowerShell process only." }
$deployment = Get-Content -Raw -LiteralPath $DeploymentManifestPath | ConvertFrom-Json
$account = aws sts get-caller-identity --query Account --output text
if ($LASTEXITCODE -ne 0) { throw "AWS identity lookup failed." }
if ($account -ne $deployment.aws_account_id -or $account -eq "173535830222") { throw "AWS account does not match the reviewed synthetic manifest, or is the production account." }
if ($Region -ne $deployment.aws_region) { throw "AWS region does not match the reviewed manifest." }
$outputs = aws cloudformation describe-stacks --stack-name $FoundationStackName --region $Region --query "Stacks[0].Outputs" --output json | ConvertFrom-Json
function Output([string]$key) { $entry = $outputs | Where-Object OutputKey -eq $key; if (-not $entry) { throw "Foundation output $key is missing." }; return $entry.OutputValue }
if ((Output 'PhiAllowed') -ne 'false' -or (Output 'DataClassification') -ne 'synthetic_only' -or (Output 'Environment') -ne 'synthetic-staging') { throw "Foundation stack is not the reviewed synthetic-only boundary." }
npm run build:aws-production-clinical-core
if ($LASTEXITCODE -ne 0) { throw "Production migration artifact build failed." }
npm run build:aws-deployment-tools
if ($LASTEXITCODE -ne 0) { throw "Deployment tools build failed." }
try {
  $env:CLINICAL_API_ORIGIN = Output 'ApiOrigin'
  $env:EXPECTED_AWS_ACCOUNT_ID = $deployment.aws_account_id
  $env:OBSERVED_AWS_ACCOUNT_ID = $account
  $env:SOURCE_COMMIT = (git rev-parse HEAD).Trim()
  node dist/aws-clinical-core/deployment-tools/exportRetentionAcceptance.js
  if ($LASTEXITCODE -ne 0) { throw "Export and retention acceptance did not pass; read the report under dist/qualification." }
} finally {
  foreach ($name in 'CLINICAL_API_ORIGIN','EXPECTED_AWS_ACCOUNT_ID','OBSERVED_AWS_ACCOUNT_ID','SOURCE_COMMIT','CLINICAL_WORKFORCE_ID_TOKEN','CLINICAL_CONSUMER_ID_TOKEN','CLINICAL_FOREIGN_CONSUMER_ID_TOKEN') { Remove-Item "Env:$name" -ErrorAction SilentlyContinue }
}
Write-Host "Export and retention acceptance completed; tokens were not printed or written."
