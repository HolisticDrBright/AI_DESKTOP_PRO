param(
  [Parameter(Mandatory = $true)][string]$OriginalSourceDirectory,
  [Parameter(Mandatory = $true)][ValidatePattern('^[0-9a-f]{64}$')][string]$OriginalManifestSha256,
  [Parameter(Mandatory = $true)][string]$CandidateSourceDirectory,
  [Parameter(Mandatory = $true)][ValidatePattern('^[0-9a-f]{64}$')][string]$CandidateManifestSha256,
  [Parameter(Mandatory = $true)][string]$ApprovalFile,
  [Parameter(Mandatory = $true)][ValidatePattern('^[0-9a-f-]{36}$')][string]$ReviewerPersonId,
  [string]$FoundationStackName = "ai-clinical-core-synthetic-staging",
  [string]$Profile = "ai-synthetic-member",
  [string]$Region = "us-east-2",
  [switch]$ConfirmSyntheticOnly
)

$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
Set-Location $root
if (-not $ConfirmSyntheticOnly) { throw "Refusing expanded catalog deployment without synthetic-only confirmation." }
if (-not (Get-Command aws -ErrorAction SilentlyContinue)) { throw "AWS CLI is required." }
$account = aws sts get-caller-identity --profile $Profile --query Account --output text
if ($LASTEXITCODE -ne 0 -or $account -ne "588966314750") { throw "The selected profile is not the dedicated synthetic-staging account." }

$outputs = aws cloudformation describe-stacks --profile $Profile --stack-name $FoundationStackName `
  --region $Region --query "Stacks[0].Outputs" --output json | ConvertFrom-Json
function Output([string]$key) {
  $entry = $outputs | Where-Object OutputKey -eq $key
  if (-not $entry) { throw "Foundation output $key is missing." }
  return $entry.OutputValue
}
if ((Output 'PhiAllowed') -ne 'false' -or (Output 'DataClassification') -ne 'synthetic_only' `
  -or (Output 'Environment') -ne 'synthetic-staging') { throw "Foundation is not synthetic-only." }

npm run check:aws-governed-catalog
if ($LASTEXITCODE -ne 0) { throw "Governed catalog boundary check failed." }
npm run build:aws-deployment-tools
if ($LASTEXITCODE -ne 0) { throw "Deployment tools build failed." }

$tempRoot = [IO.Path]::GetTempPath()
$tempDirectory = Join-Path $tempRoot ("ai-expanded-catalog-" + [Guid]::NewGuid().ToString("N"))
New-Item -ItemType Directory -Path $tempDirectory | Out-Null
$manifestFile = Join-Path $tempDirectory "synthetic-expanded-catalog.json"
try {
  $env:AWS_PROFILE = $Profile
  $env:AWS_REGION = $Region
  $env:CLINICAL_CATALOG_ENVIRONMENT = "synthetic-staging"
  $env:CLINICAL_CATALOG_ORIGINAL_SOURCE_DIR = (Resolve-Path -LiteralPath $OriginalSourceDirectory).Path
  $env:CLINICAL_CATALOG_ORIGINAL_SOURCE_MANIFEST_SHA256 = $OriginalManifestSha256
  $env:CLINICAL_CATALOG_CANDIDATE_SOURCE_DIR = (Resolve-Path -LiteralPath $CandidateSourceDirectory).Path
  $env:CLINICAL_CATALOG_CANDIDATE_SOURCE_MANIFEST_SHA256 = $CandidateManifestSha256
  $env:CLINICAL_CATALOG_CANDIDATE_APPROVAL = (Resolve-Path -LiteralPath $ApprovalFile).Path
  $env:CLINICAL_CATALOG_OUTPUT = $manifestFile
  node dist/aws-clinical-core/deployment-tools/catalogOperator.js adapt-expanded
  if ($LASTEXITCODE -ne 0) { throw "Expanded catalog adaptation failed." }

  $env:CLINICAL_DATABASE_CLUSTER_ARN = Output 'DatabaseClusterArn'
  $env:CLINICAL_DATABASE_SECRET_ARN = Output 'DatabaseSecretArn'
  $env:CLINICAL_DATABASE_NAME = Output 'DatabaseName'
  node dist/aws-clinical-core/deployment-tools/catalogOperator.js migrate
  if ($LASTEXITCODE -ne 0) { throw "Catalog migration failed." }
  $env:CLINICAL_CATALOG_MANIFEST = $manifestFile
  node dist/aws-clinical-core/deployment-tools/catalogOperator.js import
  if ($LASTEXITCODE -ne 0) { throw "Expanded catalog import failed." }
  $env:CLINICAL_CATALOG_REVIEWER_PERSON_ID = $ReviewerPersonId
  $env:CLINICAL_CATALOG_REVIEW_REASON = "Catalog owner approved all 710 expanded products for governed catalog availability. Original governed products remain primary; expanded products fill uncovered needs. Commercial offers, automatic doses, peptides, research products, and patient-specific safety remain separately gated."
  node dist/aws-clinical-core/deployment-tools/catalogOperator.js approve-release
  if ($LASTEXITCODE -ne 0) { throw "Expanded catalog approval failed." }
} finally {
  foreach ($name in @(
    'AWS_PROFILE','AWS_REGION','CLINICAL_CATALOG_ENVIRONMENT','CLINICAL_CATALOG_ORIGINAL_SOURCE_DIR',
    'CLINICAL_CATALOG_ORIGINAL_SOURCE_MANIFEST_SHA256','CLINICAL_CATALOG_CANDIDATE_SOURCE_DIR',
    'CLINICAL_CATALOG_CANDIDATE_SOURCE_MANIFEST_SHA256','CLINICAL_CATALOG_CANDIDATE_APPROVAL',
    'CLINICAL_CATALOG_OUTPUT','CLINICAL_DATABASE_CLUSTER_ARN','CLINICAL_DATABASE_SECRET_ARN',
    'CLINICAL_DATABASE_NAME','CLINICAL_CATALOG_MANIFEST','CLINICAL_CATALOG_REVIEWER_PERSON_ID',
    'CLINICAL_CATALOG_REVIEW_REASON'
  )) { Remove-Item "Env:$name" -ErrorAction SilentlyContinue }
  $resolvedTemp = [IO.Path]::GetFullPath($tempDirectory)
  $resolvedRoot = [IO.Path]::GetFullPath($tempRoot)
  if ($resolvedTemp.StartsWith($resolvedRoot, [StringComparison]::OrdinalIgnoreCase)) {
    Remove-Item -LiteralPath $resolvedTemp -Recurse -Force -ErrorAction SilentlyContinue
  }
}

Write-Host "Expanded catalog imported and owner-approved in synthetic-only AWS. Commercial offers remain disabled."
