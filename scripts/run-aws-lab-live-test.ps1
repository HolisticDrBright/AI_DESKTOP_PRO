param(
  [string]$ApiOrigin = "https://wxv734oi12.execute-api.us-east-2.amazonaws.com",
  [string]$Profile = "ai-synthetic-member",
  [string]$Region = "us-east-2"
)

$ErrorActionPreference = "Stop"
$credentialPath = Join-Path $env:USERPROFILE ".ai-longevity-pro-synthetic-lab-test.dpapi.json"
if (-not (Test-Path -LiteralPath $credentialPath)) { throw "Prepare the synthetic lab test account first." }
$record = Get-Content -LiteralPath $credentialPath -Raw | ConvertFrom-Json
$password = [System.Net.NetworkCredential]::new("", ($record.password | ConvertTo-SecureString)).Password
$temp = Join-Path $env:TEMP ("ai-lab-live-test-" + [guid]::NewGuid().ToString("N"))
New-Item -ItemType Directory -Path $temp | Out-Null
$authPath = Join-Path $temp "auth.json"
$imagePath = Join-Path $temp "synthetic-functional-lab.png"
try {
  [ordered]@{ AuthFlow = "USER_PASSWORD_AUTH"; ClientId = $record.client_id; AuthParameters = @{ USERNAME = $record.email; PASSWORD = $password } } | ConvertTo-Json -Depth 4 | Set-Content -LiteralPath $authPath -Encoding utf8NoBOM
  $auth = aws cognito-idp initiate-auth --cli-input-json ("file://" + $authPath.Replace("\", "/")) --profile $Profile --region $Region --output json | ConvertFrom-Json
  if ($LASTEXITCODE -ne 0 -or -not $auth.AuthenticationResult.IdToken) { throw "Synthetic Cognito sign-in failed." }
  $token = $auth.AuthenticationResult.IdToken

  Add-Type -AssemblyName System.Drawing
  $bitmap = [System.Drawing.Bitmap]::new(1600, 1000)
  $graphics = [System.Drawing.Graphics]::FromImage($bitmap)
  try {
    $graphics.Clear([System.Drawing.Color]::White)
    $title = [System.Drawing.Font]::new("Arial", 34, [System.Drawing.FontStyle]::Bold)
    $body = [System.Drawing.Font]::new("Arial", 25, [System.Drawing.FontStyle]::Regular)
    $brush = [System.Drawing.Brushes]::Black
    $graphics.DrawString("SYNTHETIC FUNCTIONAL LAB - NOT A REAL PATIENT", $title, $brush, 60, 55)
    $lines = @(
      "Glucose 104 mg/dL Reference 70-99", "Hemoglobin A1c 5.7 % Reference 4.0-5.6",
      "Fasting Insulin 9.2 uIU/mL Reference 2.0-20.0", "TSH 3.4 uIU/mL Reference 0.4-4.5",
      "Free T3 2.8 pg/mL Reference 2.3-4.2", "Free T4 1.0 ng/dL Reference 0.8-1.8",
      "Vitamin D 32 ng/mL Reference 30-100", "hs-CRP 2.4 mg/L Reference 0.0-3.0",
      "Triglycerides 145 mg/dL Reference 0-149", "HDL Cholesterol 48 mg/dL Reference 40-100",
      "LDL Cholesterol 118 mg/dL Reference 0-129"
    )
    for ($i = 0; $i -lt $lines.Count; $i++) { $graphics.DrawString($lines[$i], $body, $brush, 90, 145 + $i * 70) }
    $bitmap.Save($imagePath, [System.Drawing.Imaging.ImageFormat]::Png)
  } finally { $graphics.Dispose(); $bitmap.Dispose() }

  $documentId = [guid]::NewGuid().ToString()
  $headers = @{ Authorization = "Bearer $token"; Accept = "application/json" }
  $createBody = @{ dataClassification = "synthetic_only"; attestsSyntheticOnly = $true; panelId = "synthetic-functional-panel"; documents = @(@{ clientDocumentId = $documentId; fileName = "synthetic-functional-lab.png"; contentType = "image/png"; byteSize = (Get-Item $imagePath).Length }) } | ConvertTo-Json -Depth 5
  $created = Invoke-RestMethod -Method Post -Uri "$ApiOrigin/clinical-core/consumer/labs/jobs" -Headers $headers -ContentType "application/json" -Body $createBody
  $target = $created.data.documents[0]
  if (-not $target.uploadUrl) { throw "AWS did not provide an upload URL." }
  $uploadHeaders = @{}; foreach ($property in $target.requiredHeaders.PSObject.Properties) { $uploadHeaders[$property.Name] = [string]$property.Value }
  $response = Invoke-WebRequest -Method Put -Uri $target.uploadUrl -Headers $uploadHeaders -InFile $imagePath -ContentType "image/png"
  if ($response.StatusCode -lt 200 -or $response.StatusCode -ge 300) { throw "Synthetic S3 upload failed." }
  $completeBody = @{ uploadedDocuments = @(@{ clientDocumentId = $documentId; etag = [string]$response.Headers.ETag }) } | ConvertTo-Json -Depth 4
  $null = Invoke-RestMethod -Method Post -Uri "$ApiOrigin/clinical-core/consumer/labs/jobs/$($created.data.jobId)/complete-upload" -Headers $headers -ContentType "application/json" -Body $completeBody
  $deadline = (Get-Date).AddMinutes(4)
  do {
    Start-Sleep -Seconds 2
    $current = Invoke-RestMethod -Method Get -Uri "$ApiOrigin/clinical-core/consumer/labs/jobs/$($created.data.jobId)" -Headers $headers
    $state = $current.data.state
  } while ($state -notin @("completed", "needs_review", "failed") -and (Get-Date) -lt $deadline)
  if ($state -ne "completed") { throw "Synthetic lab analysis ended in state $state." }
  $result = $current.data.result
  if ($current.data.passesCompleted -ne 5 -or $current.data.progressPercent -ne 100 -or $result.biomarkers.Count -lt 8 -or $result.recommendations.Count -ne 0) { throw "Synthetic lab result failed acceptance checks." }

  $idempotent = Invoke-RestMethod -Method Post -Uri "$ApiOrigin/clinical-core/consumer/labs/jobs/$($created.data.jobId)/complete-upload" -Headers $headers -ContentType "application/json" -Body $completeBody
  if ($idempotent.data.state -ne "completed") { throw "Completed upload retry was not idempotent." }

  $freshAuth = aws cognito-idp initiate-auth --cli-input-json ("file://" + $authPath.Replace("\", "/")) --profile $Profile --region $Region --output json | ConvertFrom-Json
  if ($LASTEXITCODE -ne 0 -or -not $freshAuth.AuthenticationResult.IdToken) { throw "Fresh synthetic Cognito sign-in failed." }
  $freshHeaders = @{ Authorization = "Bearer $($freshAuth.AuthenticationResult.IdToken)"; Accept = "application/json" }
  $resumed = Invoke-RestMethod -Method Get -Uri "$ApiOrigin/clinical-core/consumer/labs/jobs/$($created.data.jobId)" -Headers $freshHeaders
  if ($resumed.data.state -ne "completed" -or $resumed.data.result.analysisId -ne $result.analysisId) { throw "A fresh session could not resume the persisted result." }

  [pscustomobject]@{ Contract = $current.data.contractVersion; State = $state; Passes = $current.data.passesCompleted; Biomarkers = $result.biomarkers.Count; Recommendations = $result.recommendations.Count; ReviewState = $result.reviewState; IdempotentRetry = $true; FreshSessionResume = $true } | Format-List
} finally {
  Remove-Item -LiteralPath $temp -Recurse -Force -ErrorAction SilentlyContinue
}
