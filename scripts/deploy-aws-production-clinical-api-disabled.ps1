param(
  [string]$FoundationStackName = "ai-longevity-production-clinical-foundation",
  [string]$ExtensionStackName = "ai-longevity-production-clinical-api-disabled",
  [string]$AwsProfile = "ai-production",
  [string]$Region = "us-east-2",
  [switch]$ConfirmPhiDisabled
)

$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
Set-Location $root
if (-not $ConfirmPhiDisabled) {
  throw "Refusing operation: explicitly confirm the PHI-disabled API boundary."
}
npm run check:aws-production-clinical-api
if ($LASTEXITCODE -ne 0) { throw "Production clinical API safety gate failed." }

$account = aws sts get-caller-identity --profile $AwsProfile --query Account --output text
$outputs = aws cloudformation describe-stacks --profile $AwsProfile --region $Region `
  --stack-name $FoundationStackName --query "Stacks[0].Outputs" --output json | ConvertFrom-Json
function Output([string]$key) {
  $entry = $outputs | Where-Object OutputKey -eq $key
  if (-not $entry) { throw "Foundation output $key is missing." }
  return $entry.OutputValue
}
if ((Output "PhiAllowed") -ne "false" -or (Output "Environment") -ne "production-clinical" `
  -or (Output "DataClassification") -ne "clinical_phi_target") {
  throw "Foundation stack is not the reviewed PHI-disabled production boundary."
}
if ((Output "DatabaseClusterArn") -notmatch ":$account`:cluster:") {
  throw "Production account does not match the active AWS identity."
}

$parameters = @(
  "ClinicalApiId=$(Output 'ClinicalApiId')",
  "WorkforceUserPoolId=$(Output 'WorkforceUserPoolId')",
  "WorkforceUserPoolClientId=$(Output 'WorkforceUserPoolClientId')",
  "ConsumerUserPoolId=$(Output 'ConsumerUserPoolId')",
  "ConsumerUserPoolClientId=$(Output 'ConsumerUserPoolClientId')",
  "ClinicalCoreKeyArn=$(Output 'ClinicalCoreKeyArn')",
  "PhiAllowed=false"
)
$existingStatus = aws cloudformation describe-stacks --profile $AwsProfile --region $Region `
  --stack-name $ExtensionStackName --query "Stacks[0].StackStatus" --output text 2>$null
if ($LASTEXITCODE -eq 0 -and $existingStatus -eq "ROLLBACK_COMPLETE") {
  aws cloudformation delete-stack --profile $AwsProfile --region $Region --stack-name $ExtensionStackName
  aws cloudformation wait stack-delete-complete --profile $AwsProfile --region $Region --stack-name $ExtensionStackName
  if ($LASTEXITCODE -ne 0) { throw "Failed stack cleanup did not complete." }
}
aws cloudformation deploy --profile $AwsProfile --region $Region `
  --stack-name $ExtensionStackName `
  --template-file "infra/aws-clinical-core/production-clinical-api-disabled.json" `
  --capabilities CAPABILITY_IAM --no-fail-on-empty-changeset `
  --parameter-overrides $parameters
if ($LASTEXITCODE -ne 0) { throw "PHI-disabled production API deployment failed." }

Write-Host "PHI-disabled production clinical API boundary deployed with no data-plane permissions."
