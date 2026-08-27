param(
  [Parameter(Mandatory = $true)][string]$SourceDirectory,
  [Parameter(Mandatory = $true)][ValidatePattern('^[0-9a-f]{64}$')][string]$SourceManifestSha256,
  [string]$FoundationStackName = "ai-clinical-core-synthetic-staging",
  [string]$ExtensionStackName = "ai-clinical-core-synthetic-staging-governed-catalog",
  [string]$Profile = "ai-synthetic-member",
  [string]$Region = "us-east-2",
  [switch]$ConfirmSyntheticOnly
)

$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
Set-Location $root

if (-not $ConfirmSyntheticOnly) {
  throw "Refusing catalog deployment without explicit synthetic-only confirmation."
}
if (-not (Get-Command aws -ErrorAction SilentlyContinue)) {
  throw "AWS CLI is required. No cloud operation was attempted."
}

$account = aws sts get-caller-identity --profile $Profile --query Account --output text
if ($LASTEXITCODE -ne 0 -or $account -ne "588966314750") {
  throw "The selected profile is not the dedicated synthetic-staging account."
}

$outputs = aws cloudformation describe-stacks --profile $Profile --stack-name $FoundationStackName `
  --region $Region --query "Stacks[0].Outputs" --output json | ConvertFrom-Json
function Output([string]$key) {
  $entry = $outputs | Where-Object OutputKey -eq $key
  if (-not $entry) { throw "Foundation output $key is missing." }
  return $entry.OutputValue
}
if ((Output 'PhiAllowed') -ne 'false' -or (Output 'DataClassification') -ne 'synthetic_only' `
  -or (Output 'Environment') -ne 'synthetic-staging') {
  throw "Foundation stack is not the reviewed synthetic-only boundary."
}

npm run check:aws-governed-catalog
if ($LASTEXITCODE -ne 0) { throw "Governed catalog boundary check failed." }
npm run check:aws-governed-catalog-api
if ($LASTEXITCODE -ne 0) { throw "Governed catalog API boundary check failed." }
npm run build:aws-deployment-tools
if ($LASTEXITCODE -ne 0) { throw "Deployment tools build failed." }
npm run build:aws-governed-catalog-api
if ($LASTEXITCODE -ne 0) { throw "Catalog API build failed." }

$tempRoot = [IO.Path]::GetTempPath()
$tempDirectory = Join-Path $tempRoot ("ai-governed-catalog-" + [Guid]::NewGuid().ToString("N"))
New-Item -ItemType Directory -Path $tempDirectory | Out-Null
$adaptedManifest = Join-Path $tempDirectory "synthetic-governed-catalog.json"

try {
  $env:AWS_PROFILE = $Profile
  $env:AWS_REGION = $Region
  $env:CLINICAL_CATALOG_ENVIRONMENT = "synthetic-staging"
  $env:CLINICAL_CATALOG_SOURCE_DIR = (Resolve-Path -LiteralPath $SourceDirectory).Path
  $env:CLINICAL_CATALOG_SOURCE_MANIFEST_SHA256 = $SourceManifestSha256
  $env:CLINICAL_CATALOG_OUTPUT = $adaptedManifest
  node dist/aws-clinical-core/deployment-tools/catalogOperator.js adapt
  if ($LASTEXITCODE -ne 0) { throw "Catalog source adaptation failed." }

  $env:CLINICAL_DATABASE_CLUSTER_ARN = Output 'DatabaseClusterArn'
  $env:CLINICAL_DATABASE_SECRET_ARN = Output 'DatabaseSecretArn'
  $env:CLINICAL_DATABASE_NAME = Output 'DatabaseName'
  node dist/aws-clinical-core/deployment-tools/catalogOperator.js migrate
  if ($LASTEXITCODE -ne 0) { throw "Catalog migration failed." }
  $env:CLINICAL_CATALOG_MANIFEST = $adaptedManifest
  node dist/aws-clinical-core/deployment-tools/catalogOperator.js import
  if ($LASTEXITCODE -ne 0) { throw "Catalog import failed." }

  $artifactDir = Join-Path $root "dist\aws-clinical-core\governed-catalog-api"
  $zipPath = Join-Path $tempDirectory "governed-catalog-api.zip"
  Compress-Archive -Path (Join-Path $artifactDir "index.js") -DestinationPath $zipPath
  $digest = (Get-FileHash -Algorithm SHA256 -LiteralPath $zipPath).Hash.ToLowerInvariant()
  $artifactBucket = Output 'ClinicalDocumentsBucketName'
  $artifactKey = "clinical-core/governed-catalog-api/$digest.zip"
  aws s3 cp $zipPath "s3://$artifactBucket/$artifactKey" --profile $Profile --region $Region `
    --only-show-errors --sse aws:kms --sse-kms-key-id (Output 'ClinicalCoreKeyArn')
  if ($LASTEXITCODE -ne 0) { throw "Catalog API artifact upload failed." }

  $parameters = @(
    "EnvironmentName=synthetic-staging",
    "ClinicalApiId=$(Output 'ClinicalApiId')",
    "WorkforceUserPoolId=$(Output 'WorkforceUserPoolId')",
    "WorkforceUserPoolClientId=$(Output 'WorkforceUserPoolClientId')",
    "ConsumerUserPoolId=$(Output 'ConsumerUserPoolId')",
    "ConsumerUserPoolClientId=$(Output 'ConsumerUserPoolClientId')",
    "DatabaseClusterArn=$(Output 'DatabaseClusterArn')",
    "DatabaseSecretArn=$(Output 'DatabaseSecretArn')",
    "DatabaseName=$(Output 'DatabaseName')",
    "ClinicalCoreKeyArn=$(Output 'ClinicalCoreKeyArn')",
    "LambdaCodeBucket=$artifactBucket",
    "LambdaCodeKey=$artifactKey"
  )
  aws cloudformation deploy --profile $Profile --stack-name $ExtensionStackName `
    --template-file "infra/aws-clinical-core/catalog-api-extension.json" --region $Region `
    --capabilities CAPABILITY_IAM --no-fail-on-empty-changeset --parameter-overrides $parameters `
    --tags Environment=synthetic-staging DataClassification=reference_only ContainsPhi=false
  if ($LASTEXITCODE -ne 0) { throw "Catalog API CloudFormation deployment failed." }
} finally {
  foreach ($name in @(
    'AWS_PROFILE','AWS_REGION','CLINICAL_CATALOG_ENVIRONMENT','CLINICAL_CATALOG_SOURCE_DIR',
    'CLINICAL_CATALOG_SOURCE_MANIFEST_SHA256','CLINICAL_CATALOG_OUTPUT',
    'CLINICAL_DATABASE_CLUSTER_ARN','CLINICAL_DATABASE_SECRET_ARN','CLINICAL_DATABASE_NAME',
    'CLINICAL_CATALOG_MANIFEST'
  )) { Remove-Item "Env:$name" -ErrorAction SilentlyContinue }
  $resolvedTemp = [IO.Path]::GetFullPath($tempDirectory)
  $resolvedRoot = [IO.Path]::GetFullPath($tempRoot)
  if ($resolvedTemp.StartsWith($resolvedRoot, [StringComparison]::OrdinalIgnoreCase)) {
    Remove-Item -LiteralPath $resolvedTemp -Recurse -Force -ErrorAction SilentlyContinue
  }
}

Write-Host "Governed catalog migrated, imported as needs_review, and API deployed in synthetic-only AWS."
