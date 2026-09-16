param([switch]$ConfirmSyntheticOnly)
$ErrorActionPreference = 'Stop'
if (-not $ConfirmSyntheticOnly) { throw 'Synthetic-only confirmation required.' }
Set-Location (Split-Path -Parent $PSScriptRoot)
$profileName = 'ai-synthetic-member'
$regionName = 'us-east-2'
$stackName = 'ai-clinical-core-synthetic-staging-chat-transcription'
$account = aws sts get-caller-identity --profile $profileName --query Account --output text
if ($LASTEXITCODE -ne 0 -or $account -ne '588966314750') { throw 'Unexpected account.' }
$stack = (aws cloudformation describe-stacks --stack-name $stackName --profile $profileName --region $regionName --output json | ConvertFrom-Json).Stacks[0]
if ($LASTEXITCODE -ne 0 -or $stack.StackStatus -notin @('CREATE_COMPLETE', 'UPDATE_COMPLETE')) { throw 'Stack is not ready.' }
function Parameter([string]$name) { return ($stack.Parameters | Where-Object ParameterKey -eq $name).ParameterValue }
if ((Parameter ClinicalApiId) -ne 'wxv734oi12') { throw 'Unexpected API.' }
npm run typecheck
if ($LASTEXITCODE -ne 0) { throw 'Typecheck failed.' }
npm run build:aws-chat-transcription
if ($LASTEXITCODE -ne 0) { throw 'Build failed.' }
npm run check:aws-chat-transcription
if ($LASTEXITCODE -ne 0) { throw 'Boundary check failed.' }
$zip = Join-Path (Get-Location) ('dist/aws-clinical-core/voice-jobs-' + [guid]::NewGuid().ToString('N') + '.zip')
Compress-Archive -LiteralPath 'dist/aws-clinical-core/chat-transcription/jobs/index.js' -DestinationPath $zip
$hash = (Get-FileHash -LiteralPath $zip -Algorithm SHA256).Hash.ToLowerInvariant()
$key = "clinical-core/voice-jobs/$hash.zip"
aws s3 cp $zip "s3://$(Parameter LambdaCodeBucket)/$key" --profile $profileName --region $regionName --only-show-errors --sse aws:kms --sse-kms-key-id (Parameter ClinicalCoreKeyArn)
if ($LASTEXITCODE -ne 0) { throw 'Artifact upload failed.' }
aws cloudformation deploy --stack-name $stackName --template-file 'infra/aws-clinical-core/chat-transcription-extension.json' --profile $profileName --region $regionName --capabilities CAPABILITY_IAM --no-execute-changeset --parameter-overrides "VoiceJobsCodeKey=$key"
if ($LASTEXITCODE -ne 0) { throw 'Change-set creation failed.' }
$sets = aws cloudformation list-change-sets --stack-name $stackName --profile $profileName --region $regionName --output json | ConvertFrom-Json
if ($LASTEXITCODE -ne 0) { throw 'Change-set lookup failed.' }
$id = ($sets.Summaries | Sort-Object CreationTime -Descending | Select-Object -First 1).ChangeSetId
$change = aws cloudformation describe-change-set --change-set-name $id --profile $profileName --region $regionName --output json | ConvertFrom-Json
if ($LASTEXITCODE -ne 0 -or $change.Status -ne 'CREATE_COMPLETE' -or ($change.Parameters | Where-Object ParameterKey -eq VoiceJobsCodeKey).ParameterValue -ne $key) { throw 'Unexpected change set.' }
foreach ($old in $stack.Parameters) {
  if ($old.ParameterKey -eq 'VoiceJobsCodeKey') { continue }
  if (($change.Parameters | Where-Object ParameterKey -eq $old.ParameterKey).ParameterValue -ne $old.ParameterValue) { throw 'Existing configuration changed.' }
}
foreach ($entry in $change.Changes) {
  $r = $entry.ResourceChange
  if ($r.LogicalResourceId -notmatch '^Voice(JobTable|JobRole|JobFunction|JobIntegration|StartRoute|StatusRoute|CancelRoute|ApiPermission|SweepRule|SweepPermission)$' -or $r.Action -notin @('Add', 'Modify') -or ($r.Action -eq 'Modify' -and $r.Replacement -ne 'False')) { throw "Unexpected change: $($r.LogicalResourceId)." }
}
aws cloudformation execute-change-set --change-set-name $id --profile $profileName --region $regionName
if ($LASTEXITCODE -ne 0) { throw 'Deployment start failed.' }
[pscustomobject]@{ Stack = $stackName; ArtifactSha256 = $hash; State = 'UPDATE_REQUESTED'; PhiAllowed = $false } | Format-List
