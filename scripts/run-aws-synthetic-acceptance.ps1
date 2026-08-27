param(
  [Parameter(Mandatory = $true)][string]$FoundationStackName,
  [Parameter(Mandatory = $true)][string]$DeploymentManifestPath,
  [Parameter(Mandatory = $true)][string]$SyntheticManifestPath,
  [string]$Region = "us-east-2"
)

$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
Set-Location $root
if (-not (Get-Command aws -ErrorAction SilentlyContinue)) { throw "AWS CLI is required. No acceptance request was attempted." }
if (-not $env:CLINICAL_WORKFORCE_ID_TOKEN -or -not $env:CLINICAL_CONSUMER_ID_TOKEN -or -not $env:CLINICAL_ISOLATION_WORKFORCE_ID_TOKEN) {
  throw "Fresh primary workforce, consumer, and isolation-workforce Cognito ID tokens must be set in this PowerShell process only."
}
$deployment = Get-Content -Raw -LiteralPath $DeploymentManifestPath | ConvertFrom-Json
$fixture = Get-Content -Raw -LiteralPath $SyntheticManifestPath | ConvertFrom-Json
$account = aws sts get-caller-identity --query Account --output text
if ($account -ne $deployment.aws_account_id -or $account -ne $fixture.awsAccountId) { throw "AWS account does not match both reviewed manifests." }
if ($Region -ne $deployment.aws_region -or $Region -ne $fixture.awsRegion) { throw "AWS region does not match both reviewed manifests." }
$outputs = aws cloudformation describe-stacks --stack-name $FoundationStackName --region $Region --query "Stacks[0].Outputs" --output json | ConvertFrom-Json
function Output([string]$key) {
  $entry = $outputs | Where-Object OutputKey -eq $key
  if (-not $entry) { throw "Foundation output $key is missing." }
  return $entry.OutputValue
}
if ((Output 'PhiAllowed') -ne 'false' -or (Output 'DataClassification') -ne 'synthetic_only' -or (Output 'Environment') -ne 'synthetic-staging') {
  throw "Foundation stack is not the reviewed synthetic-only boundary."
}
npm run check:aws-deployment-acceptance
if ($LASTEXITCODE -ne 0) { throw "Deployment acceptance check refused or failed." }
npm run build:aws-deployment-tools
if ($LASTEXITCODE -ne 0) { throw "Deployment tools build failed." }
try {
  $env:CLINICAL_API_ORIGIN = Output 'ApiOrigin'
  $env:CLINICAL_SYNTHETIC_MANIFEST = (Resolve-Path -LiteralPath $SyntheticManifestPath).Path
  node dist/aws-clinical-core/deployment-tools/acceptance.js
  if ($LASTEXITCODE -ne 0) { throw "Synthetic acceptance gate refused or failed." }
} finally {
  Remove-Item Env:CLINICAL_API_ORIGIN -ErrorAction SilentlyContinue
  Remove-Item Env:CLINICAL_SYNTHETIC_MANIFEST -ErrorAction SilentlyContinue
  Remove-Item Env:CLINICAL_WORKFORCE_ID_TOKEN -ErrorAction SilentlyContinue
  Remove-Item Env:CLINICAL_CONSUMER_ID_TOKEN -ErrorAction SilentlyContinue
  Remove-Item Env:CLINICAL_ISOLATION_WORKFORCE_ID_TOKEN -ErrorAction SilentlyContinue
}
Write-Host "Synthetic acceptance completed. Tokens and invitation material were not printed or written."
