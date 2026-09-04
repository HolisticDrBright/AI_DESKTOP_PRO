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
$temp = Join-Path $env:TEMP ("ai-lab-direction-test-" + [guid]::NewGuid().ToString("N"))
New-Item -ItemType Directory -Path $temp | Out-Null
$authPath = Join-Path $temp "auth.json"
try {
  [ordered]@{ AuthFlow = "USER_PASSWORD_AUTH"; ClientId = $record.client_id; AuthParameters = @{ USERNAME = $record.email; PASSWORD = $password } } | ConvertTo-Json -Depth 4 | Set-Content -LiteralPath $authPath -Encoding utf8NoBOM
  $auth = aws cognito-idp initiate-auth --cli-input-json ("file://" + $authPath.Replace("\", "/")) --profile $Profile --region $Region --output json | ConvertFrom-Json
  if ($LASTEXITCODE -ne 0 -or -not $auth.AuthenticationResult.IdToken) { throw "Synthetic Cognito sign-in failed." }
  $headers = @{ Authorization = "Bearer $($auth.AuthenticationResult.IdToken)"; Accept = "application/json" }
  $panelId = "synthetic-direction-$([guid]::NewGuid().ToString('N').Substring(0,8))"
  $today = (Get-Date).ToUniversalTime().ToString("yyyy-MM-dd")
  $markers = @(
    @{ markerId = "high-vitamin-d"; canonicalName = "Vitamin D"; value = 120; unit = "ng/mL"; labMin = 30; labMax = 100 },
    @{ markerId = "high-vitamin-b12"; canonicalName = "Vitamin B12"; value = 1400; unit = "pg/mL"; labMin = 200; labMax = 900 },
    @{ markerId = "high-folate"; canonicalName = "Folate"; value = 30; unit = "ng/mL"; labMin = 3; labMax = 17 },
    @{ markerId = "high-iron"; canonicalName = "Serum Iron"; value = 200; unit = "mcg/dL"; labMin = 50; labMax = 170 },
    @{ markerId = "high-ferritin"; canonicalName = "Ferritin"; value = 320; unit = "ng/mL"; labMin = 20; labMax = 250 },
    @{ markerId = "high-omega"; canonicalName = "Omega 3 Index"; value = 15; unit = "%"; labMin = 4; labMax = 12 },
    @{ markerId = "high-estradiol"; canonicalName = "Estradiol"; value = 80; unit = "pg/mL"; labMin = 10; labMax = 40 },
    @{ markerId = "high-progesterone"; canonicalName = "Progesterone"; value = 2; unit = "ng/mL"; labMin = 0.1; labMax = 1 }
  )
  $createBody = @{
    panelId = $panelId; panelName = "Synthetic Direction Safety Matrix"; testDate = $today
    dataClassification = "synthetic_only"; attestsSyntheticOnly = $true
    patientContext = @{
      ageYears = 41; sex = "male"; pregnancyStatus = "not_applicable"; nursing = $false
      mainComplaint = "Synthetic safety verification"; complaintDuration = "1 month"; complaintSeverity = 2
      conditions = @(); medications = @(); allergies = @(); topSymptomSignals = @()
      lifestyle = @{ sleepHours = 7; sleepQuality = 7; stressLevel = 4; dietType = "omnivore"; exerciseFrequency = 3 }
    }
    longitudinalContext = @{
      incomingPanel = @{ panelId = $panelId; panelName = "Synthetic Direction Safety Matrix"; testDate = $today }
      priorPanels = @(); activeProtocol = $null
    }
    biomarkers = $markers
  } | ConvertTo-Json -Depth 8
  $created = Invoke-RestMethod -Method Post -Uri "$ApiOrigin/clinical-core/consumer/labs/plan-jobs" -Headers $headers -ContentType "application/json" -Body $createBody
  if ($created.data.state -ne "queued" -or -not $created.data.jobId) { throw "Directional safety job was not queued." }
  $deadline = (Get-Date).AddMinutes(4)
  do {
    Start-Sleep -Seconds 2
    $current = Invoke-RestMethod -Method Get -Uri "$ApiOrigin/clinical-core/consumer/labs/jobs/$($created.data.jobId)" -Headers $headers
  } while ($current.data.state -notin @("completed", "needs_review", "failed") -and (Get-Date) -lt $deadline)
  if ($current.data.state -ne "completed" -or -not $current.data.result.generatedPlan) { throw "Directional safety job ended in state $($current.data.state)." }
  $supplements = @($current.data.result.generatedPlan.supplementRecommendations)
  $unsafeNames = @($supplements | Where-Object { $_.name -match "iron|ferr|vitamin d|b12|folate|omega|estrogen|estradiol|progesterone|vitex|chaste" })
  $outside = @($current.data.result.biomarkers | Where-Object status -in @("suboptimal", "critical"))
  $relationshipReviewPresent = [string]$current.data.result.summary -like "*Related-marker review:*"
  if ($current.data.result.biomarkers.Count -ne $markers.Count -or $outside.Count -ne $markers.Count -or $supplements.Count -ne 0 -or $unsafeNames.Count -ne 0 -or -not $relationshipReviewPresent) {
    throw "Directional safety acceptance failed."
  }
  $deleted = Invoke-RestMethod -Method Delete -Uri "$ApiOrigin/clinical-core/consumer/labs/jobs/$($created.data.jobId)" -Headers $headers
  if ($deleted.data.deleted -ne $true) { throw "Directional safety job cleanup failed." }
  [pscustomobject]@{
    State = $current.data.state
    HighMarkersRetained = $current.data.result.biomarkers.Count
    OutsideRangeClassifications = $outside.Count
    AutomaticSupplementConsiderations = $supplements.Count
    UnsafeMatches = $unsafeNames.Count
    RelationshipReviewPresent = $relationshipReviewPresent
    MaleContextRetained = $true
    Deleted = $true
  } | Format-List
} finally {
  Remove-Item -LiteralPath $temp -Recurse -Force -ErrorAction SilentlyContinue
}
