param(
  [Parameter(Mandatory = $true)][string]$ManagementProfile,
  [Parameter(Mandatory = $true)][string]$AccountEmail,
  [string]$AccountName = "AI Longevity Pro Clinical Production"
)

$ErrorActionPreference = "Stop"

if ($AccountEmail -notmatch '^[^@\s]+@[^@\s]+\.[^@\s]+$' -or $AccountEmail -like 'REPLACE_*') {
  throw "A unique, controlled production account email is required."
}

$caller = aws sts get-caller-identity --profile $ManagementProfile --output json | ConvertFrom-Json
if ($caller.Account -ne "449901517958") {
  throw "Refusing account creation: profile must resolve to the reviewed management account 449901517958."
}

$request = aws organizations create-account `
  --profile $ManagementProfile `
  --email $AccountEmail `
  --account-name $AccountName `
  --iam-user-access-to-billing DENY `
  --output json | ConvertFrom-Json

$requestId = $request.CreateAccountStatus.Id
if (-not $requestId) { throw "AWS did not return a create-account request id." }

do {
  Start-Sleep -Seconds 10
  $status = aws organizations describe-create-account-status `
    --profile $ManagementProfile `
    --create-account-request-id $requestId `
    --output json | ConvertFrom-Json
  $state = $status.CreateAccountStatus.State
  Write-Host "Production account request state: $state"
} while ($state -eq "IN_PROGRESS")

if ($state -ne "SUCCEEDED") {
  throw "Production account creation failed: $($status.CreateAccountStatus.FailureReason)"
}

[pscustomobject]@{
  AccountId = $status.CreateAccountStatus.AccountId
  AccountName = $status.CreateAccountStatus.AccountName
  State = $state
  PhiAllowed = $false
} | ConvertTo-Json
