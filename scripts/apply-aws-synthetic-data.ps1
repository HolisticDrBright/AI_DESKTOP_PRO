param(
  [Parameter(Mandatory = $true)][string]$FoundationStackName,
  [Parameter(Mandatory = $true)][string]$DeploymentManifestPath,
  [Parameter(Mandatory = $true)][string]$SyntheticManifestPath,
  [string]$Region = "us-east-2",
  [switch]$ConfirmSyntheticOnly
)

$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
Set-Location $root
if (-not $ConfirmSyntheticOnly) { throw "Refusing operation: explicitly confirm the reviewed synthetic-only boundary." }
if (-not (Get-Command aws -ErrorAction SilentlyContinue)) { throw "AWS CLI is required. No cloud operation was attempted." }

npm run preflight:aws-synthetic -- $DeploymentManifestPath
$deployment = Get-Content -Raw -LiteralPath $DeploymentManifestPath | ConvertFrom-Json
$fixture = Get-Content -Raw -LiteralPath $SyntheticManifestPath | ConvertFrom-Json
$account = aws sts get-caller-identity --query Account --output text
if ($account -ne $deployment.aws_account_id -or $account -ne $fixture.awsAccountId) { throw "AWS account does not match both reviewed manifests." }
if ($Region -ne $deployment.aws_region -or $Region -ne $fixture.awsRegion) { throw "AWS region does not match both reviewed manifests." }
if ($fixture.environment -ne "synthetic-staging" -or $fixture.dataClassification -ne "synthetic_only" -or $fixture.containsPhi -ne $false) {
  throw "Fixture manifest is not synthetic-only."
}

npm run check:aws-deployment-acceptance
npm run build:aws-deployment-tools
$outputs = aws cloudformation describe-stacks --stack-name $FoundationStackName --region $Region --query "Stacks[0].Outputs" --output json | ConvertFrom-Json
function Output([string]$key) {
  $entry = $outputs | Where-Object OutputKey -eq $key
  if (-not $entry) { throw "Foundation output $key is missing." }
  return $entry.OutputValue
}
if ((Output 'PhiAllowed') -ne 'false' -or (Output 'DataClassification') -ne 'synthetic_only' -or (Output 'Environment') -ne 'synthetic-staging') {
  throw "Foundation stack is not the reviewed synthetic-only boundary."
}

try {
  $env:AWS_REGION = $Region
  $env:CLINICAL_DATABASE_CLUSTER_ARN = Output 'DatabaseClusterArn'
  $env:CLINICAL_DATABASE_SECRET_ARN = Output 'DatabaseSecretArn'
  $env:CLINICAL_DATABASE_NAME = Output 'DatabaseName'
  node dist/aws-clinical-core/deployment-tools/operator.js migrate
  if ($LASTEXITCODE -ne 0) { throw "Migration runner refused or failed." }
  $env:CLINICAL_SYNTHETIC_MANIFEST = (Resolve-Path -LiteralPath $SyntheticManifestPath).Path
  node dist/aws-clinical-core/deployment-tools/operator.js fixtures
  if ($LASTEXITCODE -ne 0) { throw "Fixture provisioner refused or failed." }
} finally {
  Remove-Item Env:CLINICAL_DATABASE_CLUSTER_ARN -ErrorAction SilentlyContinue
  Remove-Item Env:CLINICAL_DATABASE_SECRET_ARN -ErrorAction SilentlyContinue
  Remove-Item Env:CLINICAL_DATABASE_NAME -ErrorAction SilentlyContinue
  Remove-Item Env:CLINICAL_SYNTHETIC_MANIFEST -ErrorAction SilentlyContinue
}
Write-Host "Synthetic migrations and fixtures completed without printing credentials or fixture subjects."
