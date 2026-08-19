param(
  [Parameter(Mandatory = $true)][string]$Profile,
  [Parameter(Mandatory = $true)][ValidatePattern('^\d{12}$')][string]$ProductionAccountId,
  [Parameter(Mandatory = $true)][string]$BudgetAlertEmail,
  [Parameter(Mandatory = $true)][string]$BaaEvidenceReference,
  [string]$Region = "us-east-2",
  [string]$StackName = "ai-longevity-production-clinical-foundation"
)

$ErrorActionPreference = "Stop"
$forbiddenAccounts = @("449901517958", "588966314750")

if ($forbiddenAccounts -contains $ProductionAccountId) {
  throw "Refusing deployment: production must use a dedicated account, not management or synthetic staging."
}
if ($BudgetAlertEmail -notmatch '^[^@\s]+@[^@\s]+\.[^@\s]+$' -or $BudgetAlertEmail -like 'REPLACE_*') {
  throw "A controlled billing alert email is required."
}
if ([string]::IsNullOrWhiteSpace($BaaEvidenceReference) -or $BaaEvidenceReference -like 'REPLACE_*') {
  throw "A controlled AWS Organizations BAA evidence reference is required."
}

$caller = aws sts get-caller-identity --profile $Profile --output json | ConvertFrom-Json
if ($caller.Account -ne $ProductionAccountId) {
  throw "Refusing deployment: profile resolves to account $($caller.Account), not $ProductionAccountId."
}

$repoRoot = Resolve-Path (Join-Path $PSScriptRoot "..")
Push-Location $repoRoot
try {
  bun run build:aws-production-foundation
  bun run check:aws-production-foundation
  aws cloudformation validate-template `
    --profile $Profile `
    --region $Region `
    --template-body file://dist/aws-clinical-core/production-foundation.json | Out-Null

  aws s3control put-public-access-block `
    --profile $Profile `
    --region $Region `
    --account-id $ProductionAccountId `
    --public-access-block-configuration BlockPublicAcls=true,IgnorePublicAcls=true,BlockPublicPolicy=true,RestrictPublicBuckets=true

  aws cloudformation deploy `
    --profile $Profile `
    --region $Region `
    --stack-name $StackName `
    --template-file dist/aws-clinical-core/production-foundation.json `
    --capabilities CAPABILITY_NAMED_IAM `
    --no-fail-on-empty-changeset `
    --parameter-overrides `
      EnvironmentName=production-clinical `
      DataClassification=clinical_phi `
      BudgetAlertEmail=$BudgetAlertEmail

  $outputs = aws cloudformation describe-stacks `
    --profile $Profile `
    --region $Region `
    --stack-name $StackName `
    --query 'Stacks[0].Outputs' `
    --output json | ConvertFrom-Json
  $phiAllowed = ($outputs | Where-Object OutputKey -eq "PhiAllowed").OutputValue
  if ($phiAllowed -ne "false") { throw "Foundation posture violation: PhiAllowed must remain false." }

  [pscustomobject]@{
    AccountId = $ProductionAccountId
    Region = $Region
    StackName = $StackName
    BaaEvidenceReference = $BaaEvidenceReference
    PhiAllowed = $false
  } | ConvertTo-Json
}
finally {
  Pop-Location
}
