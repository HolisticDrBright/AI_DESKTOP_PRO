param(
  [string]$FoundationStackName = "ai-clinical-core-synthetic-staging",
  [string]$DeploymentManifestPath = ".\infra\aws-clinical-core\deployment-manifest.json",
  [string]$SyntheticManifestPath = ".\infra\aws-clinical-core\synthetic-acceptance-manifest.json",
  [string]$Region = "us-east-2",
  [string]$Profile = "ai-synthetic-member",
  [switch]$ConfirmSyntheticOnly
)

$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
Set-Location $root
if (-not $ConfirmSyntheticOnly) { throw "Refusing operation: explicitly confirm the synthetic-only boundary." }

$credentialPath = Join-Path $env:TEMP "ai-clinical-synthetic-credentials.dpapi.json"
if (-not (Test-Path -LiteralPath $credentialPath)) { throw "The DPAPI-protected synthetic credential envelope is unavailable." }
$credentials = Get-Content -Raw -LiteralPath $credentialPath | ConvertFrom-Json
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

function Reveal([string]$protected) {
  $secure = ConvertTo-SecureString $protected
  $pointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)
  try { return [Runtime.InteropServices.Marshal]::PtrToStringBSTR($pointer) }
  finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($pointer) }
}

function Invoke-AwsJson([string]$Service, [string]$Operation, [hashtable]$Payload) {
  $requestPath = Join-Path $env:TEMP ("aws-auth-" + [guid]::NewGuid().ToString("N") + ".json")
  try {
    $json = $Payload | ConvertTo-Json -Depth 8 -Compress
    [System.IO.File]::WriteAllText($requestPath, $json, (New-Object System.Text.UTF8Encoding($false)))
    $raw = & aws $Service $Operation --cli-input-json ("file://" + $requestPath.Replace("\", "/")) --region $Region --profile $Profile --output json
    if ($LASTEXITCODE -ne 0) { throw "AWS authentication operation failed." }
    return $raw | ConvertFrom-Json
  } finally {
    Remove-Item -LiteralPath $requestPath -Force -ErrorAction SilentlyContinue
  }
}

function Convert-Base32([string]$Value) {
  $alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567"
  $buffer = 0
  $bits = 0
  $result = New-Object System.Collections.Generic.List[byte]
  foreach ($character in $Value.TrimEnd('=').ToUpperInvariant().ToCharArray()) {
    $index = $alphabet.IndexOf($character)
    if ($index -lt 0) { throw "Cognito returned an invalid MFA seed." }
    $buffer = ($buffer -shl 5) -bor $index
    $bits += 5
    if ($bits -ge 8) {
      $bits -= 8
      $result.Add([byte](($buffer -shr $bits) -band 0xff))
    }
  }
  return $result.ToArray()
}

function Get-Totp([string]$SecretCode) {
  $counter = [math]::Floor(([DateTimeOffset]::UtcNow.ToUnixTimeSeconds()) / 30)
  $bytes = [BitConverter]::GetBytes([long]$counter)
  if ([BitConverter]::IsLittleEndian) { [Array]::Reverse($bytes) }
  $hmac = New-Object System.Security.Cryptography.HMACSHA1
  try {
    $hmac.Key = Convert-Base32 $SecretCode
    $hash = $hmac.ComputeHash($bytes)
    $offset = $hash[$hash.Length - 1] -band 0x0f
    $binary = (($hash[$offset] -band 0x7f) -shl 24) -bor (($hash[$offset + 1] -band 0xff) -shl 16) -bor (($hash[$offset + 2] -band 0xff) -shl 8) -bor ($hash[$offset + 3] -band 0xff)
    return ($binary % 1000000).ToString("000000")
  } finally { $hmac.Dispose() }
}

function Get-IdToken([string]$PoolId, [string]$ClientId, [string]$Username, [string]$Password, [bool]$RequireMfa) {
  $auth = Invoke-AwsJson "cognito-idp" "admin-initiate-auth" @{
    UserPoolId = $PoolId
    ClientId = $ClientId
    AuthFlow = "ADMIN_USER_PASSWORD_AUTH"
    AuthParameters = @{ USERNAME = $Username; PASSWORD = $Password }
  }

  if ($auth.ChallengeName -eq "MFA_SETUP") {
    if (-not $RequireMfa) { throw "Unexpected MFA setup challenge." }
    $associated = Invoke-AwsJson "cognito-idp" "associate-software-token" @{ Session = $auth.Session }
    $verified = Invoke-AwsJson "cognito-idp" "verify-software-token" @{
      Session = $associated.Session
      UserCode = Get-Totp $associated.SecretCode
      FriendlyDeviceName = "synthetic-acceptance"
    }
    $auth = Invoke-AwsJson "cognito-idp" "respond-to-auth-challenge" @{
      ClientId = $ClientId
      ChallengeName = "MFA_SETUP"
      Session = $verified.Session
      ChallengeResponses = @{ USERNAME = $Username }
    }
  }

  if (-not $auth.AuthenticationResult.IdToken) { throw "Cognito did not return an ID token." }
  return $auth.AuthenticationResult.IdToken
}

$workforcePassword = Reveal $credentials.workforcePassword
$isolationPassword = Reveal $credentials.isolationPassword
$consumerPassword = Reveal $credentials.consumerPassword
try {
  $env:CLINICAL_WORKFORCE_ID_TOKEN = Get-IdToken (Output "WorkforceUserPoolId") (Output "WorkforceUserPoolClientId") $credentials.workforceUser $workforcePassword $true
  $env:CLINICAL_ISOLATION_WORKFORCE_ID_TOKEN = Get-IdToken (Output "WorkforceUserPoolId") (Output "WorkforceUserPoolClientId") $credentials.isolationUser $isolationPassword $true
  $env:CLINICAL_CONSUMER_ID_TOKEN = Get-IdToken (Output "ConsumerUserPoolId") (Output "ConsumerUserPoolClientId") $credentials.consumerUser $consumerPassword $false
  $env:AWS_PROFILE = $Profile
  & (Join-Path $PSScriptRoot "run-aws-synthetic-acceptance.ps1") `
    -FoundationStackName $FoundationStackName `
    -DeploymentManifestPath $DeploymentManifestPath `
    -SyntheticManifestPath $SyntheticManifestPath `
    -Region $Region
  if ($LASTEXITCODE -ne 0) { throw "Authenticated synthetic acceptance failed." }
} finally {
  $workforcePassword = $null
  $isolationPassword = $null
  $consumerPassword = $null
  Remove-Item Env:CLINICAL_WORKFORCE_ID_TOKEN -ErrorAction SilentlyContinue
  Remove-Item Env:CLINICAL_ISOLATION_WORKFORCE_ID_TOKEN -ErrorAction SilentlyContinue
  Remove-Item Env:CLINICAL_CONSUMER_ID_TOKEN -ErrorAction SilentlyContinue
  Remove-Item -LiteralPath $credentialPath -Force -ErrorAction SilentlyContinue
}

Write-Host "MFA-bound workforce and consumer acceptance sessions completed; temporary local credentials were destroyed."
