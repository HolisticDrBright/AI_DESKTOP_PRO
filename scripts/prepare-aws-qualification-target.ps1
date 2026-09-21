param(
  [Parameter(Mandatory = $true)][ValidateSet('inspect','create','apply','fixtures')][string]$Command,
  [Parameter(Mandatory = $true)][string]$FoundationStackName,
  [Parameter(Mandatory = $true)][string]$DeploymentManifestPath,
  [string]$QualificationDatabaseName = "clinical_core_qualification",
  [string]$SyntheticManifestPath,
  [string]$Region = "us-east-2",
  [switch]$ConfirmQualificationTarget
)
# Prepares the isolated qualification database on the synthetic cluster (docs/aws-qualification-target.md):
#   inspect  - read-only: does the qualification database exist, what do both migration ledgers hold.
#   create   - creates the empty qualification database; refuses when it exists.
#   apply    - applies the built production artifact to the qualification database through the production migration
#              operator (inspect first; apply only when safeToApply); never to the staging database.
#   fixtures - inserts the fictional production-shaped fixtures from the reviewed synthetic acceptance manifest.
# The AWS account is pinned with STS against the reviewed deployment manifest; the production account is refused; PHI stays
# disabled (read from the foundation stack, must be false); the staging database name is taken from the foundation stack and
# is refused as a qualification name. No secret is printed.
$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
Set-Location $root
if (-not (Get-Command aws -ErrorAction SilentlyContinue)) { throw "AWS CLI is required. Nothing was attempted." }
if ($Command -ne 'inspect' -and -not $ConfirmQualificationTarget) { throw "Refusing $Command: pass -ConfirmQualificationTarget after reading docs/aws-qualification-target.md." }
if ($Command -eq 'fixtures' -and -not $SyntheticManifestPath) { throw "fixtures needs -SyntheticManifestPath (the reviewed synthetic acceptance manifest)." }
$deployment = Get-Content -Raw -LiteralPath $DeploymentManifestPath | ConvertFrom-Json
if ($deployment.aws_account_id -eq '173535830222') { throw "The production account is never a qualification target." }
$account = aws sts get-caller-identity --query Account --output text
if ($LASTEXITCODE -ne 0) { throw "AWS identity lookup failed." }
if ($account -ne $deployment.aws_account_id) { throw "AWS account does not match the reviewed deployment manifest." }
if ($Region -ne $deployment.aws_region) { throw "AWS region does not match the reviewed manifest." }
$outputs = aws cloudformation describe-stacks --stack-name $FoundationStackName --region $Region --query "Stacks[0].Outputs" --output json | ConvertFrom-Json
function Output([string]$key) { $entry = $outputs | Where-Object OutputKey -eq $key; if (-not $entry) { throw "Foundation output $key is missing." }; return $entry.OutputValue }
if ((Output 'PhiAllowed') -ne 'false') { throw "Foundation stack does not state PhiAllowed=false; the qualification target is synthetic-only." }
$stagingDatabase = Output 'DatabaseName'
if ($QualificationDatabaseName -eq $stagingDatabase) { throw "The qualification database must not be the staging database ($stagingDatabase)." }
npm run build:aws-qualification-target-operator
if ($LASTEXITCODE -ne 0) { throw "Operator build failed." }
if ($Command -eq 'apply' -or $Command -eq 'fixtures') {
  npm run build:aws-production-clinical-core
  if ($LASTEXITCODE -ne 0) { throw "Production artifact build failed." }
  npm run check:aws-production-clinical-core
  if ($LASTEXITCODE -ne 0) { throw "Production artifact gate failed." }
}
if ($Command -eq 'apply') {
  node scripts/build-aws-production-migration-operator.mjs
  if ($LASTEXITCODE -ne 0) { throw "Migration operator build failed." }
}
try {
  $env:PHI_ALLOWED = 'false'
  $env:EXPECTED_AWS_ACCOUNT_ID = $deployment.aws_account_id
  $env:AWS_REGION = $Region
  $env:CLINICAL_DATABASE_CLUSTER_ARN = Output 'DatabaseClusterArn'
  $env:CLINICAL_DATABASE_SECRET_ARN = Output 'DatabaseSecretArn'
  $env:QUALIFICATION_DATABASE_NAME = $QualificationDatabaseName
  $env:STAGING_DATABASE_NAME = $stagingDatabase
  if ($Command -ne 'inspect') { $env:CONFIRM_QUALIFICATION_TARGET = 'true' }
  if ($Command -eq 'apply') {
    # The production migration operator addresses the qualification database only; the staging name never reaches it.
    $env:CLINICAL_DATABASE_NAME = $QualificationDatabaseName
    $env:CONFIRM_PRODUCTION_SCHEMA_ONLY = 'true'
    $inspection = node dist/aws-clinical-core/production-migration-operator/index.cjs inspect
    if ($LASTEXITCODE -ne 0) { throw "Qualification ledger inspection refused or found mismatched/unknown history; nothing applied." }
    $parsed = $inspection | ConvertFrom-Json
    if (-not $parsed.safeToApply) { throw "Qualification ledger is not safe to apply." }
    node dist/aws-clinical-core/production-migration-operator/index.cjs apply
    if ($LASTEXITCODE -ne 0) { throw "Production migration operator refused or failed on the qualification database; the printed category says why." }
  } else {
    if ($Command -eq 'fixtures') { $env:CLINICAL_SYNTHETIC_MANIFEST = $SyntheticManifestPath }
    node dist/aws-clinical-core/qualification-target-operator/index.cjs $Command
    if ($LASTEXITCODE -ne 0) { throw "Qualification target operator refused or failed ($Command); the printed category says why." }
  }
} finally {
  foreach ($name in 'PHI_ALLOWED','EXPECTED_AWS_ACCOUNT_ID','CLINICAL_DATABASE_CLUSTER_ARN','CLINICAL_DATABASE_SECRET_ARN','CLINICAL_DATABASE_NAME','QUALIFICATION_DATABASE_NAME','STAGING_DATABASE_NAME','CONFIRM_QUALIFICATION_TARGET','CONFIRM_PRODUCTION_SCHEMA_ONLY','CLINICAL_SYNTHETIC_MANIFEST') { Remove-Item "Env:$name" -ErrorAction SilentlyContinue }
}
Write-Host "Qualification target step finished ($Command). Record the printed JSON with the deployment evidence."
