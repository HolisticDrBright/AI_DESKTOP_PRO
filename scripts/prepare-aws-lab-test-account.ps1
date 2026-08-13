param(
  [string]$UserPoolId = "us-east-2_nYngyyYGE",
  [string]$Username = "synthetic-consumer-primary@ailongevitypro.app",
  [string]$Region = "us-east-2",
  [string]$Profile = "ai-synthetic-member"
)

$ErrorActionPreference = "Stop"
$bytes = New-Object byte[] 32
$generator = [System.Security.Cryptography.RandomNumberGenerator]::Create()
try { $generator.GetBytes($bytes) } finally { $generator.Dispose() }
$password = "A9!" + [Convert]::ToBase64String($bytes).Replace("/", "x").Replace("+", "Y").Replace("=", "z")

aws cognito-idp admin-set-user-password --user-pool-id $UserPoolId --username $Username --password $password --permanent --region $Region --profile $Profile
if ($LASTEXITCODE -ne 0) { throw "Synthetic test account password update failed." }

$path = Join-Path $env:USERPROFILE ".ai-longevity-pro-synthetic-lab-test.dpapi.json"
[ordered]@{
  email = $Username
  password = ConvertFrom-SecureString (ConvertTo-SecureString $password -AsPlainText -Force)
  user_pool_id = $UserPoolId
  client_id = "72aksm2dm4nf03l8d9nrp2dbh0"
  region = $Region
  created_at = (Get-Date).ToUniversalTime().ToString("yyyy-MM-ddTHH:mm:ssZ")
} | ConvertTo-Json | ForEach-Object {
  [System.IO.File]::WriteAllText($path, $_, (New-Object System.Text.UTF8Encoding($false)))
}

Write-Host "Synthetic AWS lab test account prepared. The password is DPAPI-protected at $path and was not printed."
