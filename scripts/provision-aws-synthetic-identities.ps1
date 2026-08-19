param(
  [Parameter(Mandatory = $true)][string]$FoundationStackName,
  [Parameter(Mandatory = $true)][string]$ManifestPath,
  [string]$Region = "us-east-2",
  [string]$Profile = "ai-synthetic-member",
  [switch]$ConfirmSyntheticOnly
)

$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
Set-Location $root
if (-not $ConfirmSyntheticOnly) { throw "Refusing operation: explicitly confirm the synthetic-only boundary." }

$outputs = aws cloudformation describe-stacks --stack-name $FoundationStackName --region $Region --profile $Profile --query "Stacks[0].Outputs" --output json | ConvertFrom-Json
if ($LASTEXITCODE -ne 0) { throw "Foundation stack lookup failed." }
function Output([string]$key) {
  $entry = $outputs | Where-Object OutputKey -eq $key
  if (-not $entry) { throw "Foundation output $key is missing." }
  return $entry.OutputValue
}
if ((Output "PhiAllowed") -ne "false" -or (Output "DataClassification") -ne "synthetic_only" -or (Output "Environment") -ne "synthetic-staging") {
  throw "Foundation stack is not the reviewed synthetic-only boundary."
}

function New-Password {
  $bytes = New-Object byte[] 32
  $generator = [System.Security.Cryptography.RandomNumberGenerator]::Create()
  try { $generator.GetBytes($bytes) } finally { $generator.Dispose() }
  return "A9!" + [Convert]::ToBase64String($bytes).Replace("/", "x").Replace("+", "Y").Replace("=", "z")
}

function Invoke-Aws([string[]]$Arguments) {
  & aws @Arguments
  if ($LASTEXITCODE -ne 0) { throw "AWS operation failed." }
}

function New-SyntheticUser(
  [string]$PoolId,
  [string]$Username,
  [string]$PersonId,
  [string]$OrganizationId,
  [string]$Password,
  [bool]$AllowPersonRotation
) {
  $requestPath = Join-Path $env:TEMP ("cognito-user-" + [guid]::NewGuid().ToString("N") + ".json")
  try {
    $existingRaw = & aws cognito-idp admin-get-user --user-pool-id $PoolId --username $Username --region $Region --profile $Profile --output json 2>$null
    $existing = if ($LASTEXITCODE -eq 0) { $existingRaw | ConvertFrom-Json } else { $null }
    [ordered]@{
      UserPoolId = $PoolId
      Username = $Username
      MessageAction = "SUPPRESS"
      UserAttributes = @(
        @{ Name = "email"; Value = $Username },
        @{ Name = "email_verified"; Value = "true" },
        @{ Name = "custom:person_id"; Value = $PersonId },
        @{ Name = "custom:organization_id"; Value = $OrganizationId },
        @{ Name = "custom:synthetic_attested"; Value = "true" }
      )
    } | ConvertTo-Json -Depth 5 | ForEach-Object {
      [System.IO.File]::WriteAllText($requestPath, $_, (New-Object System.Text.UTF8Encoding($false)))
    }
    if (-not $existing) {
      Invoke-Aws @("cognito-idp", "admin-create-user", "--cli-input-json", ("file://" + $requestPath.Replace("\", "/")), "--region", $Region, "--profile", $Profile, "--output", "json") | Out-Null
      $existingRaw = & aws cognito-idp admin-get-user --user-pool-id $PoolId --username $Username --region $Region --profile $Profile --output json
      if ($LASTEXITCODE -ne 0) { throw "Synthetic identity lookup failed." }
      $existing = $existingRaw | ConvertFrom-Json
    }
    $attributes = @{}; foreach ($entry in $existing.UserAttributes) { $attributes[$entry.Name] = $entry.Value }
    $personMismatch = (-not $AllowPersonRotation) -and ($attributes['custom:person_id'] -ne $PersonId)
    $organizationMismatch = $attributes['custom:organization_id'] -ne $OrganizationId
    $syntheticMismatch = $attributes['custom:synthetic_attested'] -ne 'true'
    if ($personMismatch -or $organizationMismatch -or $syntheticMismatch) {
      throw "Existing synthetic identity claims do not match the reviewed fixture."
    }
    Invoke-Aws @("cognito-idp", "admin-delete-user", "--user-pool-id", $PoolId, "--username", $Username, "--region", $Region, "--profile", $Profile) | Out-Null
    Invoke-Aws @("cognito-idp", "admin-create-user", "--cli-input-json", ("file://" + $requestPath.Replace("\", "/")), "--region", $Region, "--profile", $Profile, "--output", "json") | Out-Null
    Invoke-Aws @("cognito-idp", "admin-set-user-password", "--user-pool-id", $PoolId, "--username", $Username, "--password", $Password, "--permanent", "--region", $Region, "--profile", $Profile) | Out-Null
    $subject = & aws cognito-idp admin-get-user --user-pool-id $PoolId --username $Username --region $Region --profile $Profile --query "UserAttributes[?Name=='sub'].Value | [0]" --output text
    if ($LASTEXITCODE -ne 0 -or -not $subject -or $subject -eq "None") { throw "Synthetic identity subject is missing." }
    return $subject
  } finally {
    Remove-Item -LiteralPath $requestPath -Force -ErrorAction SilentlyContinue
  }
}

$workforcePool = Output "WorkforceUserPoolId"
$consumerPool = Output "ConsumerUserPoolId"
$workforceUser = "synthetic-workforce-primary@ailongevitypro.app"
$isolationUser = "synthetic-workforce-isolation@ailongevitypro.app"
$consumerUser = "synthetic-consumer-primary@ailongevitypro.app"
$workforcePassword = New-Password
$isolationPassword = New-Password
$consumerPassword = New-Password
$existingFixture = $null
if (Test-Path -LiteralPath $ManifestPath) {
  try {
    $existingManifest = Get-Content -Raw -LiteralPath $ManifestPath | ConvertFrom-Json
    if ($existingManifest.environment -eq 'synthetic-staging' -and $existingManifest.containsPhi -eq $false) {
      $existingFixture = $existingManifest.fixture
    }
  } catch {
    $existingFixture = $null
  }
}
function Stable-FixtureUuid([string]$key) {
  $candidate = if ($existingFixture) { $existingFixture.$key } else { $null }
  $parsed = [guid]::Empty
  if ($candidate -and [guid]::TryParse([string]$candidate, [ref]$parsed)) { return $parsed.ToString() }
  return [guid]::NewGuid().ToString()
}
$consumerPersonId = [guid]::NewGuid().ToString()
$patientRecordId = [guid]::NewGuid().ToString()
$consentArtifactId = [guid]::NewGuid().ToString()
$labConsentArtifactId = [guid]::NewGuid().ToString()
$protocolConsentArtifactId = [guid]::NewGuid().ToString()
$nutritionConsentArtifactId = [guid]::NewGuid().ToString()
$symptomsConsentArtifactId = [guid]::NewGuid().ToString()
$formsConsentArtifactId = [guid]::NewGuid().ToString()
$syncProviderId = Stable-FixtureUuid 'syncProviderId'

$workforceSubject = New-SyntheticUser $workforcePool $workforceUser "22222222-2222-4222-8222-222222222222" "11111111-1111-4111-8111-111111111111" $workforcePassword $false
$isolationSubject = New-SyntheticUser $workforcePool $isolationUser "77777777-7777-4777-8777-777777777777" "66666666-6666-4666-8666-666666666666" $isolationPassword $false
$consumerSubject = New-SyntheticUser $consumerPool $consumerUser $consumerPersonId "11111111-1111-4111-8111-111111111111" $consumerPassword $true

[ordered]@{
  schemaVersion = "aws-clinical-core-synthetic-acceptance/1"
  environment = "synthetic-staging"
  dataClassification = "synthetic_only"
  containsPhi = $false
  awsAccountId = "588966314750"
  awsRegion = $Region
  reviewedAt = (Get-Date).ToUniversalTime().ToString("yyyy-MM-ddTHH:mm:ssZ")
  fixture = [ordered]@{
    organizationId = "11111111-1111-4111-8111-111111111111"
    organizationLabel = "Synthetic acceptance clinic"
    workforcePersonId = "22222222-2222-4222-8222-222222222222"
    workforceSubject = $workforceSubject
    consumerPersonId = $consumerPersonId
    consumerSubject = $consumerSubject
    patientRecordId = $patientRecordId
    consentArtifactId = $consentArtifactId
    consentArtifactSha256 = "a" * 64
    labConsentArtifactId = $labConsentArtifactId
    labConsentArtifactSha256 = "b" * 64
    protocolConsentArtifactId = $protocolConsentArtifactId
    protocolConsentArtifactSha256 = "c" * 64
    nutritionConsentArtifactId = $nutritionConsentArtifactId
    nutritionConsentArtifactSha256 = "d" * 64
    symptomsConsentArtifactId = $symptomsConsentArtifactId
    symptomsConsentArtifactSha256 = "e" * 64
    formsConsentArtifactId = $formsConsentArtifactId
    formsConsentArtifactSha256 = "f" * 64
    syncProviderId = $syncProviderId
    isolationOrganizationId = "66666666-6666-4666-8666-666666666666"
    isolationOrganizationLabel = "Synthetic acceptance isolation clinic"
    isolationWorkforcePersonId = "77777777-7777-4777-8777-777777777777"
    isolationWorkforceSubject = $isolationSubject
  }
} | ConvertTo-Json -Depth 5 | ForEach-Object {
  [System.IO.File]::WriteAllText($ManifestPath, $_, (New-Object System.Text.UTF8Encoding($false)))
}

$credentialPath = Join-Path $env:TEMP "ai-clinical-synthetic-credentials.dpapi.json"
[ordered]@{
  workforceUser = $workforceUser
  workforcePassword = ConvertFrom-SecureString (ConvertTo-SecureString $workforcePassword -AsPlainText -Force)
  isolationUser = $isolationUser
  isolationPassword = ConvertFrom-SecureString (ConvertTo-SecureString $isolationPassword -AsPlainText -Force)
  consumerUser = $consumerUser
  consumerPassword = ConvertFrom-SecureString (ConvertTo-SecureString $consumerPassword -AsPlainText -Force)
} | ConvertTo-Json | ForEach-Object {
  [System.IO.File]::WriteAllText($credentialPath, $_, (New-Object System.Text.UTF8Encoding($false)))
}

Write-Host "Created three synthetic identities. The ignored manifest contains opaque subjects only; temporary credentials are DPAPI-protected for the current Windows user."
