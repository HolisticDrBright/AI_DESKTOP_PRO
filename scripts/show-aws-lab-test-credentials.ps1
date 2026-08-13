$ErrorActionPreference = "Stop"
$path = Join-Path $env:USERPROFILE ".ai-longevity-pro-synthetic-lab-test.dpapi.json"
if (-not (Test-Path -LiteralPath $path)) { throw "Synthetic lab test credentials have not been prepared." }
$record = Get-Content -LiteralPath $path -Raw | ConvertFrom-Json
$password = [System.Net.NetworkCredential]::new("", ($record.password | ConvertTo-SecureString)).Password
Write-Host "Email: $($record.email)"
Write-Host "Password: $password"
Write-Host "Use only with synthetic or fake lab documents."
