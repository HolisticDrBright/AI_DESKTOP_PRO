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
$clientId = aws cloudformation describe-stacks `
  --stack-name "ai-clinical-core-synthetic-staging" `
  --profile $Profile `
  --region $Region `
  --query "Stacks[0].Outputs[?OutputKey=='ConsumerUserPoolClientId'].OutputValue | [0]" `
  --output text
if ($LASTEXITCODE -ne 0 -or -not $clientId -or $clientId -eq "None") { throw "Synthetic Cognito client lookup failed." }

$temp = Join-Path $env:TEMP ("ai-lab-80-marker-test-" + [guid]::NewGuid().ToString("N"))
New-Item -ItemType Directory -Path $temp | Out-Null
$authPath = Join-Path $temp "auth.json"
try {
  [ordered]@{
    AuthFlow = "USER_PASSWORD_AUTH"
    ClientId = $clientId
    AuthParameters = @{ USERNAME = $record.email; PASSWORD = $password }
  } | ConvertTo-Json -Depth 4 | Set-Content -LiteralPath $authPath -Encoding utf8NoBOM
  $auth = aws cognito-idp initiate-auth --cli-input-json ("file://" + $authPath.Replace("\", "/")) --profile $Profile --region $Region --output json | ConvertFrom-Json
  if ($LASTEXITCODE -ne 0 -or -not $auth.AuthenticationResult.IdToken) { throw "Synthetic Cognito sign-in failed." }
  $headers = @{ Authorization = "Bearer $($auth.AuthenticationResult.IdToken)"; Accept = "application/json" }

  Add-Type -AssemblyName System.Drawing
  $documents = @()
  for ($page = 0; $page -lt 4; $page += 1) {
    $path = Join-Path $temp ("synthetic-lab-page-{0}.png" -f ($page + 1))
    $bitmap = [System.Drawing.Bitmap]::new(2000, 1550)
    $graphics = [System.Drawing.Graphics]::FromImage($bitmap)
    try {
      $graphics.Clear([System.Drawing.Color]::White)
      $title = [System.Drawing.Font]::new("Arial", 30, [System.Drawing.FontStyle]::Bold)
      $body = [System.Drawing.Font]::new("Arial", 22, [System.Drawing.FontStyle]::Regular)
      $header = [System.Drawing.Font]::new("Arial", 22, [System.Drawing.FontStyle]::Bold)
      $brush = [System.Drawing.Brushes]::Black
      $pen = [System.Drawing.Pen]::new([System.Drawing.Color]::DarkGray, 2)
      $graphics.DrawString("SYNTHETIC 80-MARKER LAB - NOT A REAL PATIENT", $title, $brush, 45, 25)
      $columns = @(45, 900, 1150, 1450, 1950)
      $rowTop = 100
      $rowHeight = 65
      $columnHeaders = @("Biomarker", "Result", "Unit", "Reference Range")
      for ($column = 0; $column -lt 4; $column += 1) {
        $graphics.DrawRectangle($pen, $columns[$column], $rowTop, $columns[$column + 1] - $columns[$column], $rowHeight)
        $graphics.DrawString($columnHeaders[$column], $header, $brush, $columns[$column] + 12, $rowTop + 15)
      }
      for ($row = 0; $row -lt 20; $row += 1) {
        $marker = $page * 20 + $row + 1
        $y = $rowTop + ($row + 1) * $rowHeight
        $values = @(("Synthetic Biomarker {0:D3}" -f $marker), [string](50 + $marker), "mg/dL", "10-200")
        for ($column = 0; $column -lt 4; $column += 1) {
          $graphics.DrawRectangle($pen, $columns[$column], $y, $columns[$column + 1] - $columns[$column], $rowHeight)
          $graphics.DrawString($values[$column], $body, $brush, $columns[$column] + 12, $y + 16)
        }
      }
      $bitmap.Save($path, [System.Drawing.Imaging.ImageFormat]::Png)
    } finally {
      $graphics.Dispose()
      $bitmap.Dispose()
    }
    $documents += [pscustomobject]@{
      clientDocumentId = [guid]::NewGuid().ToString()
      fileName = Split-Path -Leaf $path
      contentType = "image/png"
      byteSize = (Get-Item -LiteralPath $path).Length
      path = $path
    }
  }

  $createBody = @{
    dataClassification = "synthetic_only"
    attestsSyntheticOnly = $true
    panelId = "synthetic-80-marker-panel"
    documents = @($documents | Select-Object clientDocumentId, fileName, contentType, byteSize)
    longitudinalContext = @{
      incomingPanel = @{
        panelId = "synthetic-80-marker-panel"
        panelName = "Synthetic Current Lab"
        testDate = "2026-08-17"
      }
      priorPanels = @(
        @{
          panelId = "synthetic-prior-panel"
          panelName = "Synthetic Prior Lab"
          testDate = "2026-05-17"
          biomarkers = @(
            @{
              biomarkerId = "00000000-0000-4000-8000-000000000001"
              canonicalName = "Synthetic Biomarker 001"
              value = 49
              unit = "mg/dL"
              labMin = 10
              labMax = 200
              functionalMin = 10
              functionalMax = 200
              status = "optimal"
            }
          )
        }
      )
      activeProtocol = @{
        protocolId = "synthetic-protocol"
        protocolName = "Synthetic Review Protocol"
        version = 1
        items = @(
          @{
            itemId = "synthetic-protocol-item"
            kind = "lifestyle"
            name = "Synthetic hydration review"
          }
        )
      }
    }
  } | ConvertTo-Json -Depth 9
  $created = Invoke-RestMethod -Method Post -Uri "$ApiOrigin/clinical-core/consumer/labs/jobs" -Headers $headers -ContentType "application/json" -Body $createBody
  $uploaded = @()
  foreach ($document in $documents) {
    $target = $created.data.documents | Where-Object clientDocumentId -eq $document.clientDocumentId
    if (-not $target.uploadUrl) { throw "AWS did not provide every upload URL." }
    $uploadHeaders = @{}
    foreach ($property in $target.requiredHeaders.PSObject.Properties) { $uploadHeaders[$property.Name] = [string]$property.Value }
    $response = Invoke-WebRequest -Method Put -Uri $target.uploadUrl -Headers $uploadHeaders -InFile $document.path -ContentType $document.contentType
    if ($response.StatusCode -lt 200 -or $response.StatusCode -ge 300) { throw "Synthetic S3 upload failed." }
    $uploaded += @{ clientDocumentId = $document.clientDocumentId; etag = [string]$response.Headers.ETag }
  }
  $completeBody = @{ uploadedDocuments = $uploaded } | ConvertTo-Json -Depth 5
  $null = Invoke-RestMethod -Method Post -Uri "$ApiOrigin/clinical-core/consumer/labs/jobs/$($created.data.jobId)/complete-upload" -Headers $headers -ContentType "application/json" -Body $completeBody
  $deadline = (Get-Date).AddMinutes(6)
  do {
    Start-Sleep -Seconds 3
    $current = Invoke-RestMethod -Method Get -Uri "$ApiOrigin/clinical-core/consumer/labs/jobs/$($created.data.jobId)" -Headers $headers
    $state = $current.data.state
  } while ($state -notin @("completed", "needs_review", "failed") -and (Get-Date) -lt $deadline)
  if ($state -ne "completed") { throw "Synthetic 80-marker analysis ended in state $state." }
  $result = $current.data.result
  $uniqueNames = @($result.biomarkers.canonicalName | Sort-Object -Unique)
  if ($current.data.passesCompleted -ne 5 -or $result.biomarkers.Count -ne 80 -or $uniqueNames.Count -ne 80 -or $result.recommendations.Count -ne 0 -or $result.longitudinalReview.panelCount -ne 2 -or -not $result.longitudinalReview.planImpact -or -not $result.summary.StartsWith("AI-assisted functional-medicine draft for practitioner review.")) {
    throw "Synthetic 80-marker result failed completeness checks: returned $($result.biomarkers.Count) marker(s), $($uniqueNames.Count) unique."
  }
  [pscustomobject]@{
    Contract = $current.data.contractVersion
    State = $state
    Passes = $current.data.passesCompleted
    SourceMarkers = 80
    ReturnedBiomarkers = $result.biomarkers.Count
    UniqueBiomarkers = $uniqueNames.Count
    AiSynthesis = $true
    Recommendations = $result.recommendations.Count
    ReviewState = $result.reviewState
    LongitudinalPanels = $result.longitudinalReview.panelCount
    PlanImpactChanges = $result.longitudinalReview.planImpact.changes.Count
  } | Format-List
} finally {
  Remove-Item -LiteralPath $temp -Recurse -Force -ErrorAction SilentlyContinue
}
