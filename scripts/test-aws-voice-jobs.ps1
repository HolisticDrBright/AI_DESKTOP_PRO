$ErrorActionPreference = 'Stop'
$profileName = 'ai-synthetic-member'
$regionName = 'us-east-2'
$origin = 'https://wxv734oi12.execute-api.us-east-2.amazonaws.com'
$account = aws sts get-caller-identity --profile $profileName --query Account --output text
if ($LASTEXITCODE -ne 0 -or $account -ne '588966314750') { throw 'Synthetic account required.' }
$taskTemp = Join-Path $env:TEMP ('alp-voice-acceptance-' + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $taskTemp | Out-Null
$jobId = $null
$headers = $null
try {
  Add-Type -AssemblyName System.Speech
  $speaker = New-Object System.Speech.Synthesis.SpeechSynthesizer
  $wav = Join-Path $taskTemp 'fictional.wav'
  try {
    $speaker.SetOutputToWaveFile($wav)
    $speaker.Speak('This is a fictional test message. Please explain how to use the app.')
  } finally { $speaker.Dispose() }
  $record = Get-Content -LiteralPath (Join-Path $env:USERPROFILE '.ai-longevity-pro-synthetic-lab-test.dpapi.json') -Raw | ConvertFrom-Json
  $password = [System.Net.NetworkCredential]::new('', ($record.password | ConvertTo-SecureString)).Password
  $authPath = Join-Path $taskTemp 'auth.json'
  @{ AuthFlow = 'USER_PASSWORD_AUTH'; ClientId = $record.client_id; AuthParameters = @{ USERNAME = $record.email; PASSWORD = $password } } | ConvertTo-Json -Depth 4 | Set-Content -LiteralPath $authPath -Encoding utf8NoBOM
  $auth = aws cognito-idp initiate-auth --cli-input-json ("file://" + $authPath.Replace('\', '/')) --profile $profileName --region $regionName --output json | ConvertFrom-Json
  if ($LASTEXITCODE -ne 0 -or -not $auth.AuthenticationResult.IdToken) { throw 'Synthetic login failed.' }
  $headers = @{ authorization = "Bearer $($auth.AuthenticationResult.IdToken)" }
  $body = @{ requestId = [guid]::NewGuid().ToString(); audioBase64 = [Convert]::ToBase64String([IO.File]::ReadAllBytes($wav)); mimeType = 'audio/wav'; consentVersion = 'patient-chat-consent/1'; purpose = 'patient_chat_voice_input' } | ConvertTo-Json -Compress
  $started = Invoke-RestMethod -Method Post -Uri "$origin/clinical-core/consumer/chat-transcription/jobs" -Headers $headers -ContentType 'application/json' -Body $body
  $jobId = $started.jobId
  if ($jobId -notmatch '^[a-f0-9]{64}$') { throw 'Invalid job response.' }
  $retry = Invoke-RestMethod -Method Post -Uri "$origin/clinical-core/consumer/chat-transcription/jobs" -Headers $headers -ContentType 'application/json' -Body $body
  if ($retry.jobId -ne $jobId) { throw 'Retry created another job.' }
  $deadline = (Get-Date).AddMinutes(3)
  do {
    Start-Sleep -Seconds 3
    $result = Invoke-RestMethod -Method Get -Uri "$origin/clinical-core/consumer/chat-transcription/jobs/$jobId" -Headers $headers
  } while ($result.state -eq 'processing' -and (Get-Date) -lt $deadline)
  if ($result.state -ne 'ready' -or $result.transcript -notmatch 'fictional test message' -or $result.transcript -notmatch 'use the app') { throw 'Synthetic transcription did not match the fixture.' }
  $cancelled = Invoke-RestMethod -Method Delete -Uri "$origin/clinical-core/consumer/chat-transcription/jobs/$jobId" -Headers $headers
  $hidden = Invoke-RestMethod -Method Get -Uri "$origin/clinical-core/consumer/chat-transcription/jobs/$jobId" -Headers $headers
  if ($cancelled.state -ne 'cancelled' -or $hidden.state -ne 'cancelled' -or $hidden.transcript) { throw 'Cancelled transcript was exposed.' }
  $resources = aws cloudformation list-stack-resources --stack-name 'ai-clinical-core-synthetic-staging-chat-transcription' --profile $profileName --region $regionName --output json | ConvertFrom-Json
  if ($LASTEXITCODE -ne 0) { throw 'Resource lookup failed.' }
  $table = ($resources.StackResourceSummaries | Where-Object LogicalResourceId -eq VoiceJobTable).PhysicalResourceId
  $bucket = ($resources.StackResourceSummaries | Where-Object LogicalResourceId -eq TranscriptionBucket).PhysicalResourceId
  $keyPath = Join-Path $taskTemp 'key.json'
  @{ id = @{ S = $jobId } } | ConvertTo-Json | Set-Content -LiteralPath $keyPath -Encoding utf8NoBOM
  $deadline = (Get-Date).AddMinutes(2)
  do {
    $state = aws dynamodb get-item --table-name $table --key ("file://" + $keyPath.Replace('\', '/')) --consistent-read --profile $profileName --region $regionName --query Item.state.S --output text
    if ($LASTEXITCODE -ne 0) { throw 'Cleanup ledger lookup failed.' }
    if ($state -ne 'cleaned') { Start-Sleep -Seconds 3 }
  } while ($state -ne 'cleaned' -and (Get-Date) -lt $deadline)
  if ($state -ne 'cleaned') { throw 'Cleanup was not confirmed.' }
  foreach ($prefix in @("temporary-input/$jobId", "temporary-output/$jobId")) {
    $listed = aws s3api list-objects-v2 --bucket $bucket --prefix $prefix --no-paginate --max-keys 10 --profile $profileName --region $regionName --output json | ConvertFrom-Json
    if ($LASTEXITCODE -ne 0 -or $null -eq $listed.KeyCount -or $listed.KeyCount -ne 0 -or $listed.IsTruncated) { throw 'Voice objects remain after cleanup.' }
  }
  [pscustomobject]@{ TranscriptionMatched = $true; RetrySameJob = $true; CancellationHidesTranscript = $true; CleanupState = $state; RemainingVoiceObjects = 0; PhiAllowed = $false } | Format-List
} finally {
  if ($jobId -and $headers) {
    try { Invoke-RestMethod -Method Delete -Uri "$origin/clinical-core/consumer/chat-transcription/jobs/$jobId" -Headers $headers | Out-Null }
    catch { Write-Warning "Synthetic voice job $jobId requires cleanup retry; scheduled expiry remains in place." }
  }
  $resolved = [IO.Path]::GetFullPath($taskTemp)
  $base = [IO.Path]::GetFullPath($env:TEMP).TrimEnd('\') + '\'
  if (-not $resolved.StartsWith($base, [StringComparison]::OrdinalIgnoreCase) -or (Split-Path -Leaf $resolved) -notmatch '^alp-voice-acceptance-[a-f0-9]{32}$') { throw 'Unsafe cleanup path.' }
  Remove-Item -LiteralPath $resolved -Recurse -Force
}
