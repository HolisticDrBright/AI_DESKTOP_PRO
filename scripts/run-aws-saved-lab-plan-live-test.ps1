param(
  [string]$ApiOrigin = "https://wxv734oi12.execute-api.us-east-2.amazonaws.com",
  [string]$Profile = "ai-synthetic-member",
  [string]$Region = "us-east-2",
  [ValidateRange(3, 30)]
  [int]$MarkerCount = 3
)

$ErrorActionPreference = "Stop"
$credentialPath = Join-Path $env:USERPROFILE ".ai-longevity-pro-synthetic-lab-test.dpapi.json"
if (-not (Test-Path -LiteralPath $credentialPath)) { throw "Prepare the synthetic lab test account first." }
$record = Get-Content -LiteralPath $credentialPath -Raw | ConvertFrom-Json
$password = [System.Net.NetworkCredential]::new("", ($record.password | ConvertTo-SecureString)).Password
$clientId = $record.client_id
$temp = Join-Path $env:TEMP ("ai-saved-lab-plan-test-" + [guid]::NewGuid().ToString("N"))
New-Item -ItemType Directory -Path $temp | Out-Null
$authPath = Join-Path $temp "auth.json"
try {
  [ordered]@{ AuthFlow = "USER_PASSWORD_AUTH"; ClientId = $clientId; AuthParameters = @{ USERNAME = $record.email; PASSWORD = $password } } | ConvertTo-Json -Depth 4 | Set-Content -LiteralPath $authPath -Encoding utf8NoBOM
  $auth = aws cognito-idp initiate-auth --cli-input-json ("file://" + $authPath.Replace("\", "/")) --profile $Profile --region $Region --output json | ConvertFrom-Json
  if ($LASTEXITCODE -ne 0 -or -not $auth.AuthenticationResult.IdToken) { throw "Synthetic Cognito sign-in failed." }
  $headers = @{ Authorization = "Bearer $($auth.AuthenticationResult.IdToken)"; Accept = "application/json" }
  $panelId = "synthetic-saved-panel-$([guid]::NewGuid().ToString('N').Substring(0,8))"
  $today = (Get-Date).ToUniversalTime().ToString("yyyy-MM-dd")
  $markers = @(
    @{ markerId = "saved-glucose"; canonicalName = "Glucose"; value = 104; unit = "mg/dL"; labMin = 70; labMax = 99 },
    @{ markerId = "saved-tsh"; canonicalName = "TSH"; value = 3.4; unit = "uIU/mL"; labMin = 0.4; labMax = 4.5 },
    @{ markerId = "saved-alt"; canonicalName = "ALT"; value = 24; unit = "U/L"; labMin = 7; labMax = 56 }
  )
  for ($index = 4; $index -le $MarkerCount; $index += 1) {
    $markers += @{
      markerId = "saved-synthetic-marker-$index"
      canonicalName = "Synthetic measured marker $index"
      value = 40 + $index
      unit = "unit-$index"
      labMin = 35
      labMax = 50
    }
  }
  $createBody = @{
    panelId = $panelId; panelName = "Synthetic Saved Lab Values"; testDate = $today
    dataClassification = "synthetic_only"; attestsSyntheticOnly = $true
    patientContext = @{
      ageYears = 41; sex = "female"; pregnancyStatus = "not_pregnant"; nursing = $false
      mainComplaint = "Synthetic low energy"; complaintDuration = "3 months"; complaintSeverity = 5
      conditions = @(); medications = @(); allergies = @(); topSymptomSignals = @(@{ categoryId = "sleep"; percentage = 65 })
      lifestyle = @{ sleepHours = 6.5; sleepQuality = 5; stressLevel = 6; dietType = "omnivore"; exerciseFrequency = 3 }
    }
    longitudinalContext = @{
      incomingPanel = @{ panelId = $panelId; panelName = "Synthetic Saved Lab Values"; testDate = $today }
      priorPanels = @(@{
        panelId = "synthetic-prior-nutrients"; panelName = "Synthetic Prior Nutrient Panel"; testDate = "2026-08-01"
        biomarkers = @(
          @{ biomarkerId = "00000000-0000-4000-8000-000000000031"; canonicalName = "Vitamin D"; value = 42; unit = "ng/mL"; labMin = 30; labMax = 100; functionalMin = 50; functionalMax = 80; status = "suboptimal" },
          @{ biomarkerId = "00000000-0000-4000-8000-000000000032"; canonicalName = "Triglycerides"; value = 180; unit = "mg/dL"; labMin = 0; labMax = 150; functionalMin = 40; functionalMax = 100; status = "critical" }
        )
      })
      activeProtocol = $null
    }
    biomarkers = $markers
  } | ConvertTo-Json -Depth 8
  $created = Invoke-RestMethod -Method Post -Uri "$ApiOrigin/clinical-core/consumer/labs/plan-jobs" -Headers $headers -ContentType "application/json" -Body $createBody
  if ($created.data.state -ne "queued" -or -not $created.data.jobId) { throw "Saved-lab plan job was not queued." }
  $deadline = (Get-Date).AddMinutes(4)
  do {
    Start-Sleep -Seconds 2
    $current = Invoke-RestMethod -Method Get -Uri "$ApiOrigin/clinical-core/consumer/labs/jobs/$($created.data.jobId)" -Headers $headers
  } while ($current.data.state -notin @("completed", "needs_review", "failed") -and (Get-Date) -lt $deadline)
  if ($current.data.state -ne "completed" -or -not $current.data.result.generatedPlan) { throw "Saved-lab plan job ended in state $($current.data.state)." }
  $unexpectedVerification = @($current.data.result.biomarkers | Where-Object verificationState -ne "needs_human_review").Count
  $accepted = $current.data.result.biomarkers.Count -eq $markers.Count `
    -and $unexpectedVerification -eq 0 `
    -and $current.data.result.generatedPlan.sourcePanelId -eq $panelId `
    -and $current.data.result.generatedPlan.tasks.Count -ge 1 `
    -and $current.data.result.generatedPlan.supplementRecommendations.Count -eq 2
  if (-not $accepted) { throw "Saved-lab plan result failed acceptance checks." }
  $deleted = Invoke-RestMethod -Method Delete -Uri "$ApiOrigin/clinical-core/consumer/labs/jobs/$($created.data.jobId)" -Headers $headers
  if ($deleted.data.deleted -ne $true) { throw "Saved-lab plan job cleanup failed." }
  [pscustomobject]@{ State = $current.data.state; Markers = $current.data.result.biomarkers.Count; PlanTasks = $current.data.result.generatedPlan.tasks.Count; HistoricalSupplementConsiderations = $current.data.result.generatedPlan.supplementRecommendations.Count; MeasuredOnly = $true; ReviewProvenanceRetained = $true; Deleted = $true } | Format-List
} finally {
  Remove-Item -LiteralPath $temp -Recurse -Force -ErrorAction SilentlyContinue
}
