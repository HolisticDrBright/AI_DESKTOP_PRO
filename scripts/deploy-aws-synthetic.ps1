param(
  [string]$ManifestPath = "infra/aws-clinical-core/deployment-manifest.json"
)

$ErrorActionPreference = "Stop"
$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$templatePath = (Resolve-Path (Join-Path $repoRoot "infra/aws-clinical-core/template.json")).Path
$templateUri = "file://" + ($templatePath -replace "\\", "/")
$manifestFullPath = (Resolve-Path (Join-Path $repoRoot $ManifestPath)).Path

node (Join-Path $repoRoot "scripts/preflight-aws-synthetic.mjs") $manifestFullPath
if ($LASTEXITCODE -ne 0) { throw "Synthetic staging preflight refused deployment." }

if (-not (Get-Command aws -ErrorAction SilentlyContinue)) {
  throw "AWS CLI is not installed or not available in PATH."
}

$manifest = Get-Content $manifestFullPath -Raw | ConvertFrom-Json
$identity = aws sts get-caller-identity --output json | ConvertFrom-Json
if ($LASTEXITCODE -ne 0) { throw "AWS identity lookup failed." }
if ($identity.Account -ne $manifest.aws_account_id) {
  throw "Authenticated AWS account does not match the reviewed deployment manifest."
}

aws cloudformation validate-template --region $manifest.aws_region --template-body $templateUri | Out-Null
if ($LASTEXITCODE -ne 0) { throw "CloudFormation rejected the template." }

$origins = $manifest.allowed_client_origins -join ","
aws cloudformation deploy `
  --region $manifest.aws_region `
  --stack-name "ai-clinical-core-synthetic-staging" `
  --template-file $templatePath `
  --capabilities CAPABILITY_NAMED_IAM `
  --no-fail-on-empty-changeset `
  --parameter-overrides `
    "EnvironmentName=synthetic-staging" `
    "DataClassification=synthetic_only" `
    "BudgetAlertEmail=$($manifest.budget_alert_email)" `
    "AllowedClientOrigins=$origins" `
  --tags `
    "Environment=synthetic-staging" `
    "DataClassification=synthetic_only" `
    "ContainsPhi=false"

if ($LASTEXITCODE -ne 0) { throw "CloudFormation deployment failed." }

aws cloudformation describe-stacks `
  --region $manifest.aws_region `
  --stack-name "ai-clinical-core-synthetic-staging" `
  --query "Stacks[0].Outputs" `
  --output table
