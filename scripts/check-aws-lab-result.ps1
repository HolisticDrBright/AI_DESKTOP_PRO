param(
  [Parameter(Mandatory = $true)][ValidatePattern('^[0-9a-f-]{36}$')][string]$JobId,
  [string]$ApiOrigin = "https://wxv734oi12.execute-api.us-east-2.amazonaws.com",
  [string]$Profile = "ai-synthetic-member",
  [string]$Region = "us-east-2"
)

$ErrorActionPreference = "Stop"
$credentialPath = Join-Path $env:USERPROFILE ".ai-longevity-pro-synthetic-lab-test.dpapi.json"
if (-not (Test-Path -LiteralPath $credentialPath)) { throw "Prepare the synthetic lab test account first." }
$record = Get-Content -LiteralPath $credentialPath -Raw | ConvertFrom-Json
$password = [System.Net.NetworkCredential]::new("", ($record.password | ConvertTo-SecureString)).Password
$clientId = $record.client_id
if (-not $clientId) {
  $clientId = aws cloudformation describe-stacks `
    --stack-name "ai-clinical-core-synthetic-staging" `
    --profile $Profile `
    --region $Region `
    --query "Stacks[0].Outputs[?OutputKey=='ConsumerUserPoolClientId'].OutputValue | [0]" `
    --output text
  if ($LASTEXITCODE -ne 0 -or -not $clientId -or $clientId -eq "None") { throw "Synthetic Cognito client lookup failed." }
}
$temp = Join-Path $env:TEMP ("ai-lab-result-auth-" + [guid]::NewGuid().ToString("N") + ".json")
try {
  [ordered]@{
    AuthFlow = "USER_PASSWORD_AUTH"
    ClientId = $clientId
    AuthParameters = @{ USERNAME = $record.email; PASSWORD = $password }
  } | ConvertTo-Json -Depth 4 | Set-Content -LiteralPath $temp -Encoding utf8NoBOM
  $auth = aws cognito-idp initiate-auth --cli-input-json ("file://" + $temp.Replace("\", "/")) --profile $Profile --region $Region --output json | ConvertFrom-Json
  if ($LASTEXITCODE -ne 0 -or -not $auth.AuthenticationResult.IdToken) { throw "Synthetic Cognito sign-in failed." }
  $response = Invoke-RestMethod -Method Get -Uri "$ApiOrigin/clinical-core/consumer/labs/jobs/$JobId" -Headers @{ Authorization = "Bearer $($auth.AuthenticationResult.IdToken)" }
  $biomarkers = @($response.data.result.biomarkers)
  [pscustomobject]@{
    State = $response.data.state
    Passes = $response.data.passesCompleted
    Biomarkers = $biomarkers.Count
    EmptyCanonicalNames = @($biomarkers | Where-Object { [string]::IsNullOrWhiteSpace($_.canonicalName) }).Count
  } | Format-List
} finally {
  Remove-Item -LiteralPath $temp -Force -ErrorAction SilentlyContinue
}
