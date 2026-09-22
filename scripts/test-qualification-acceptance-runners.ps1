$ErrorActionPreference = 'Stop'
# Credential-free test of the hosted acceptance runners. Every external command (aws, npm, node, git) is intercepted, so
# no AWS call, build or request is possible; the point is which target a runner would select and when it refuses.
# It reproduces the September 21 profile audit's cases: the documented staging foundation, the staging API and the
# staging database must be refused before anything runs, and a run may only reach the CLI bound to the reviewed
# qualification target manifest.
$exportRunner = Join-Path $PSScriptRoot 'run-aws-export-retention-acceptance.ps1'
$recordingRunner = Join-Path $PSScriptRoot 'run-aws-recording-acceptance.ps1'
# Every operator script must parse. A script that does not parse cannot refuse anything: the retention service release
# runner carried an invalid "$Command:" interpolation and would have failed at load, whatever it was asked to do.
foreach ($file in (Get-ChildItem -LiteralPath $PSScriptRoot -Filter '*.ps1' | Sort-Object Name)) {
  $tokens = $null; $parseErrors = $null
  [System.Management.Automation.Language.Parser]::ParseFile($file.FullName, [ref]$tokens, [ref]$parseErrors) > $null
  if ($parseErrors.Count) { throw ("powershell_parse_failed: " + $file.Name + " - " + $parseErrors[0].Message) }
}

$work = Join-Path ([System.IO.Path]::GetTempPath()) ("qualification-runner-test-" + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $work | Out-Null
$commit = 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678'
$global:Commit = $commit
$target = [ordered]@{
  schemaVersion = 'aws-clinical-core-qualification-target/1'; environment = 'synthetic-staging'; dataClassification = 'synthetic_only'; containsPhi = $false
  awsAccountId = '588966314750'; awsRegion = 'us-east-2'; foundationStackName = 'ai-clinical-core-qualification-foundation'
  apiId = '6zt8e9qz04'; apiOrigin = 'https://6zt8e9qz04.execute-api.us-east-2.amazonaws.com'
  databaseClusterArn = 'arn:aws:rds:us-east-2:588966314750:cluster:ai-clinical-core-synthetic-clinicaldatabasecluster-lftvrccuflxa'
  databaseSecretArn = 'arn:aws:secretsmanager:us-east-2:588966314750:secret:fictional-qualification-AbCdEf'
  databaseName = 'clinical_core_qualification'; exportBucket = 'alp-qualification-exports-588966314750-us-east-2'
  recordingBucket = 'alp-qualification-recordings-588966314750-us-east-2'
  sourceCommit = $commit; migrationReleaseHash = ('b' * 64)
  identitySubjects = [ordered]@{ consumer = '11111111-2222-4333-8444-555555555555'; workforce = '66666666-7777-4888-8999-000000000000'; foreignConsumer = '22222222-3333-4444-8555-666666666666' }
  stacks = [ordered]@{ 'personal-storage' = 'ai-clinical-core-qualification-personal-storage'; 'privacy-operations' = 'ai-clinical-core-qualification-privacy-operations'
    'recording-authority' = 'ai-clinical-core-qualification-recording-authority'; 'recording-capture' = 'ai-clinical-core-qualification-recording-capture'
    'recording-transcription' = 'ai-clinical-core-qualification-recording-transcription'; 'recording-drafting' = 'ai-clinical-core-qualification-recording-drafting'
    'recording-cleanup-review' = 'ai-clinical-core-qualification-recording-cleanup-review' }
  refused = [ordered]@{ stagingFoundationStackName = 'ai-clinical-core-synthetic-staging'; stagingApiOrigin = 'https://wxv734oi12.execute-api.us-east-2.amazonaws.com'; stagingDatabaseName = 'clinical_core' }
  reviewedAt = '2026-09-21T00:00:00Z'
}
function Write-Target([hashtable]$Patch = @{}, [hashtable]$PatchRefused = @{}, [hashtable]$PatchStacks = @{}) {
  $copy = [ordered]@{}
  foreach ($key in $target.Keys) { $copy[$key] = $target[$key] }
  foreach ($key in $Patch.Keys) { $copy[$key] = $Patch[$key] }
  if ($PatchRefused.Count) { $r = [ordered]@{}; foreach ($k in $target.refused.Keys) { $r[$k] = $target.refused[$k] }; foreach ($k in $PatchRefused.Keys) { $r[$k] = $PatchRefused[$k] }; $copy.refused = $r }
  if ($PatchStacks.Count) { $s = [ordered]@{}; foreach ($k in $target.stacks.Keys) { $s[$k] = $target.stacks[$k] }; foreach ($k in $PatchStacks.Keys) { $s[$k] = $PatchStacks[$k] }; $copy.stacks = $s }
  $file = Join-Path $work ([guid]::NewGuid().ToString('N') + '.json')
  ($copy | ConvertTo-Json -Depth 6) | Set-Content -LiteralPath $file -Encoding utf8
  return $file
}
$deploymentManifest = Join-Path $work 'deployment.json'
'{"aws_account_id":"588966314750","aws_region":"us-east-2"}' | Set-Content -LiteralPath $deploymentManifest -Encoding utf8
$syntheticManifest = Join-Path $work 'synthetic.json'
'{"schemaVersion":"aws-clinical-core-synthetic-acceptance/1"}' | Set-Content -LiteralPath $syntheticManifest -Encoding utf8

# Interception. $global:Selected records what the runner would have handed to the CLI; $global:External counts outside calls.
$global:Selected = $null
$global:External = 0
$global:StackOutputs = @{
  'ai-clinical-core-qualification-foundation' = '{"Outputs":[{"OutputKey":"PhiAllowed","OutputValue":"false"},{"OutputKey":"Activation","OutputValue":"blocked"},{"OutputKey":"QualificationExecution","OutputValue":"disabled"},{"OutputKey":"ApiId","OutputValue":"6zt8e9qz04"}],"Parameters":[]}'
}
function global:CandidateStack([hashtable]$Patch = @{}) {
  # A fictional deployed stack: reviewed posture, and the resources the manifest names. $Patch replaces one, or drops it with $null.
  $outputs = [ordered]@{ PhiAllowed = 'false'; Activation = 'blocked'; QualificationExecution = 'enabled'; SourceCommit = $global:Commit }
  $parameters = [ordered]@{ DatabaseClusterArn = 'arn:aws:rds:us-east-2:588966314750:cluster:ai-clinical-core-synthetic-clinicaldatabasecluster-lftvrccuflxa'
    DatabaseSecretArn = 'arn:aws:secretsmanager:us-east-2:588966314750:secret:fictional-qualification-AbCdEf'
    DatabaseName = 'clinical_core_qualification'; QualificationAccountId = '588966314750'; ApiId = '6zt8e9qz04'
    ExportBucketName = 'alp-qualification-exports-588966314750-us-east-2'; RecordingBucket = 'alp-qualification-recordings-588966314750-us-east-2'
    SourceCommit = $global:Commit; QualificationIdentitySubjects = '11111111-2222-4333-8444-555555555555,66666666-7777-4888-8999-000000000000,22222222-3333-4444-8555-666666666666' }
  $status = 'CREATE_COMPLETE'
  foreach ($key in $Patch.Keys) {
    if ($key -eq 'StackStatus') { $status = $Patch[$key]; continue }
    if ($key -in @('PhiAllowed','Activation','QualificationExecution')) { $outputs[$key] = $Patch[$key]; continue }
    if ($key -eq 'SourceCommit') { $outputs[$key] = $Patch[$key]; $parameters[$key] = $Patch[$key]; continue }
    if ($null -eq $Patch[$key]) { $parameters.Remove($key) } else { $parameters[$key] = $Patch[$key] }
  }
  $body = [ordered]@{ StackStatus = $status
    Outputs = @($outputs.Keys | ForEach-Object { [ordered]@{ OutputKey = $_; OutputValue = $outputs[$_] } })
    Parameters = @($parameters.Keys | ForEach-Object { [ordered]@{ ParameterKey = $_; ParameterValue = $parameters[$_] } }) }
  return ($body | ConvertTo-Json -Depth 6 -Compress)
}
foreach ($candidate in $target.stacks.Values) { $global:StackOutputs[$candidate] = (CandidateStack) }
function aws {
  $global:External++
  if ($args[0] -eq 'sts') { $global:LASTEXITCODE = 0; return $global:StsAccount }
  if ($args[0] -eq 'cloudformation') {
    $name = $args[[array]::IndexOf($args, '--stack-name') + 1]
    if ($global:StackOutputs.ContainsKey($name)) { $global:LASTEXITCODE = 0; return $global:StackOutputs[$name] }
    $global:LASTEXITCODE = 255; return $null
  }
  throw 'unexpected_external_call'
}
function npm { $global:External++; $global:LASTEXITCODE = 0 }
function git { $global:LASTEXITCODE = 0; if ($args[0] -eq 'rev-parse') { return $global:Head }; throw 'unexpected_git_call' }
function node {
  $global:External++; $global:LASTEXITCODE = 0
  $global:Selected = [ordered]@{ command = ($args -join ' '); target = $env:CLINICAL_QUALIFICATION_TARGET; apiOriginEnv = $env:CLINICAL_API_ORIGIN; databaseEnv = $env:CLINICAL_DATABASE_NAME
    account = $env:OBSERVED_AWS_ACCOUNT_ID; source = $env:SOURCE_COMMIT; mode = $env:ACCEPTANCE_MODE }
  if ("$($args)" -match 'fixture') { return '{"ok":true,"encounterId":"11111111-1111-4111-8111-111111111111","database":"clinical_core_qualification","reused":false}' }
}
$global:Head = $commit
$global:StsAccount = '588966314750'
# Each runner clears the token variables in its finally block, as a real run must; the test sets fictional ones per case.
$global:StaleToken = $true
function Set-FictionalTokens {
  $env:CLINICAL_WORKFORCE_ID_TOKEN = 'fictional.workforce.token'
  $env:CLINICAL_CONSUMER_ID_TOKEN = 'fictional.consumer.token'
  $env:CLINICAL_FOREIGN_CONSUMER_ID_TOKEN = 'fictional.foreign.token'
  if ($global:StaleToken) { $env:CLINICAL_STALE_CONSUMER_ID_TOKEN = 'fictional.stale.token' } else { Remove-Item Env:CLINICAL_STALE_CONSUMER_ID_TOKEN -ErrorAction SilentlyContinue }
}

$global:passed = 0
function Invoke-Case([string]$name, [scriptblock]$body, [string]$expectRefusal) {
  $global:Selected = $null; $global:External = 0
  Set-FictionalTokens
  $caught = 'none'
  try { & $body *> $null } catch { $caught = $_.Exception.Message }
  if ($expectRefusal) {
    if ($caught -notlike "*$expectRefusal*") { throw "$name did not refuse as expected (expected *$expectRefusal*, got $caught)" }
    if ($global:Selected) { throw "$name reached the acceptance CLI despite the refusal" }
  } else {
    if ($caught -ne 'none') { throw "$name refused unexpectedly: $caught" }
    if (-not $global:Selected) { throw "$name never reached the acceptance CLI" }
  }
  $global:passed++
}
function Export-Run([string]$targetFile, [string]$mode = 'acceptance') { & $exportRunner -QualificationTargetPath $targetFile -DeploymentManifestPath $deploymentManifest -Mode $mode -ConfirmSyntheticOnly }
function Recording-Run([string]$targetFile, [string]$mode = 'acceptance') { & $recordingRunner -QualificationTargetPath $targetFile -DeploymentManifestPath $deploymentManifest -SyntheticManifestPath $syntheticManifest -Jurisdiction 'US-SYNTHETIC' -Mode $mode -ConfirmSyntheticOnly }

$good = Write-Target
# 1. The reviewed target is selected, and nothing but the manifest path reaches the CLI: no ambient API origin or database name.
Invoke-Case 'export selects the qualification target' { Export-Run $good } $null
if ($global:Selected.target -ne $good -or $global:Selected.apiOriginEnv -or $global:Selected.databaseEnv) { throw 'export runner passed an ambient origin or database' }
if ($global:Selected.account -ne '588966314750' -or $global:Selected.source -ne $commit -or $global:Selected.mode -ne 'acceptance') { throw 'export runner passed the wrong binding' }
Invoke-Case 'recording selects the qualification target' { Recording-Run $good } $null
if ($global:Selected.target -ne $good -or $global:Selected.apiOriginEnv -or $global:Selected.databaseEnv) { throw 'recording runner passed an ambient origin or database' }
if ($global:Selected.command -notlike '*run*') { throw 'recording runner did not reach the run command' }

# 2. The audit's cases: the documented staging foundation, the staging API and the staging database, in the target manifest.
Invoke-Case 'staging foundation as the qualification foundation' { Export-Run (Write-Target @{ foundationStackName = 'ai-clinical-core-synthetic-staging' }) } 'qualification_target_refused:foundationStackName'
Invoke-Case 'staging foundation as a candidate stack' { Export-Run (Write-Target -PatchStacks @{ 'personal-storage' = 'ai-clinical-core-synthetic-staging' }) } 'qualification_target_refused:stacks.personal-storage'
Invoke-Case 'staging API as the target API' { Export-Run (Write-Target @{ apiId = 'wxv734oi12'; apiOrigin = 'https://wxv734oi12.execute-api.us-east-2.amazonaws.com' }) } 'qualification_target_refused:stagingApiOrigin'
Invoke-Case 'staging database as the target database' { Recording-Run (Write-Target @{ databaseName = 'clinical_core' }) } 'qualification_target_refused:databaseName'
Invoke-Case 'maintenance database as the target database' { Recording-Run (Write-Target @{ databaseName = 'postgres' }) } 'qualification_target_refused:databaseName'
Invoke-Case 'a database that does not name itself a qualification target' { Recording-Run (Write-Target @{ databaseName = 'clinical_core_two' }) } 'qualification_target_refused:databaseName'
Invoke-Case 'the production account' { Export-Run (Write-Target @{ awsAccountId = '173535830222' }) } 'qualification_target_refused:awsAccountId'
Invoke-Case 'a target naming another account than the reviewed deployment manifest' { Export-Run (Write-Target @{ awsAccountId = '111111111111' }) } 'qualification_target_refused:deployment_manifest'
$global:StsAccount = '111111111111'
Invoke-Case 'signed in to another account than the target' { Export-Run $good } 'qualification_target_refused:account'
$global:StsAccount = '173535830222'
Invoke-Case 'signed in to the production account' { Export-Run $good } 'qualification_target_refused:account'
$global:StsAccount = '588966314750'
Invoke-Case 'another region' { Export-Run (Write-Target @{ awsRegion = 'us-west-2' }) } 'qualification_target_refused:awsRegion'
Invoke-Case 'a deployment manifest for another account' {
  $other = Join-Path $work 'other-deployment.json'
  '{"aws_account_id":"111111111111","aws_region":"us-east-2"}' | Set-Content -LiteralPath $other -Encoding utf8
  & $exportRunner -QualificationTargetPath $good -DeploymentManifestPath $other -ConfirmSyntheticOnly } 'qualification_target_refused:deployment_manifest'
Invoke-Case 'an unfilled example target' { Export-Run (Write-Target @{ sourceCommit = ('0' * 40) }) } 'qualification_target_refused:sourceCommit'

# 3. A stale checkout, and candidate stacks that are not the reviewed qualification posture.
$global:Head = 'f' * 40
Invoke-Case 'a checkout that is not the deployed commit' { Export-Run $good } 'qualification_target_refused:sourceCommit_checkout'
$global:Head = $commit
function Invoke-CandidateCase([string]$name, [hashtable]$patch, [string]$expect, [string]$stack = 'ai-clinical-core-qualification-personal-storage', [scriptblock]$body) {
  if (-not $body) { $body = { Export-Run $good } }
  $global:StackOutputs[$stack] = (CandidateStack $patch)
  Invoke-Case $name $body $expect
  $global:StackOutputs[$stack] = (CandidateStack)
}
Invoke-CandidateCase 'a candidate with PHI enabled' @{ PhiAllowed = 'true' } 'qualification_target_refused:stack_phi.personal-storage'
Invoke-CandidateCase 'a candidate with production activation approved' @{ Activation = 'approved' } 'qualification_target_refused:stack_activation.personal-storage'
Invoke-CandidateCase 'a candidate whose qualification execution is disabled' @{ QualificationExecution = 'disabled' } 'qualification_target_refused:stack_execution.personal-storage'
Invoke-CandidateCase 'a candidate deployed from another commit' @{ SourceCommit = ('c' * 40) } 'qualification_target_refused:stack_source.personal-storage'
Invoke-CandidateCase 'a candidate that has not finished deploying' @{ StackStatus = 'UPDATE_IN_PROGRESS' } 'qualification_target_refused:stack_status.personal-storage'
# A database or API name does not identify one database or API: the cluster, the secret and the buckets are compared too.
Invoke-CandidateCase 'a candidate pointed at the staging database' @{ DatabaseName = 'clinical_core' } 'qualification_target_refused:stack_parameter.personal-storage.DatabaseName'
Invoke-CandidateCase 'a candidate on another cluster' @{ DatabaseClusterArn = 'arn:aws:rds:us-east-2:588966314750:cluster:some-other-cluster' } 'qualification_target_refused:stack_parameter.personal-storage.DatabaseClusterArn'
Invoke-CandidateCase 'a candidate with another database secret' @{ DatabaseSecretArn = 'arn:aws:secretsmanager:us-east-2:588966314750:secret:some-other-secret' } 'qualification_target_refused:stack_parameter.personal-storage.DatabaseSecretArn'
Invoke-CandidateCase 'a candidate delivering to another export bucket' @{ ExportBucketName = 'some-other-bucket' } 'qualification_target_refused:stack_parameter.personal-storage.ExportBucketName'
Invoke-CandidateCase 'a candidate on the staging API' @{ ApiId = 'wxv734oi12' } 'qualification_target_refused:stack_parameter.personal-storage.ApiId'
Invoke-CandidateCase 'a candidate pinned to another account' @{ QualificationAccountId = '111111111111' } 'qualification_target_refused:stack_parameter.personal-storage.QualificationAccountId'
Invoke-CandidateCase 'a candidate missing the cluster parameter' @{ DatabaseClusterArn = $null } 'qualification_target_refused:stack_parameter_missing.personal-storage.DatabaseClusterArn'
Invoke-CandidateCase 'a candidate missing the export bucket parameter' @{ ExportBucketName = $null } 'qualification_target_refused:stack_parameter_missing.personal-storage.ExportBucketName'
Invoke-CandidateCase 'a candidate serving an undesignated identity' @{ QualificationIdentitySubjects = '11111111-2222-4333-8444-555555555555,66666666-7777-4888-8999-000000000000,22222222-3333-4444-8555-666666666666,99999999-9999-4999-8999-999999999999' } 'qualification_target_refused:stack_subjects.personal-storage'
Invoke-CandidateCase 'a candidate that does not serve the second consumer' @{ QualificationIdentitySubjects = '11111111-2222-4333-8444-555555555555,66666666-7777-4888-8999-000000000000' } 'qualification_target_refused:stack_subjects.personal-storage'
Invoke-CandidateCase 'a recording candidate storing audio in another bucket' @{ RecordingBucket = 'some-other-bucket' } 'qualification_target_refused:stack_parameter.recording-capture.RecordingBucket' 'ai-clinical-core-qualification-recording-capture' { Recording-Run $good }
Invoke-CandidateCase 'a recording candidate missing the recording bucket parameter' @{ RecordingBucket = $null } 'qualification_target_refused:stack_parameter_missing.recording-capture.RecordingBucket' 'ai-clinical-core-qualification-recording-capture' { Recording-Run $good }
$global:StackOutputs.Remove('ai-clinical-core-qualification-recording-capture')
Invoke-Case 'a recording candidate that is not deployed' { Recording-Run $good } 'qualification_target_refused:stack_missing.recording-capture'
$global:StackOutputs['ai-clinical-core-qualification-recording-capture'] = (CandidateStack)
# The manifest itself must name the second consumer and a recording bucket distinct from the export bucket.
Invoke-Case 'a manifest without the second consumer' { Export-Run (Write-Target @{ identitySubjects = [ordered]@{ consumer = '11111111-2222-4333-8444-555555555555'; workforce = '66666666-7777-4888-8999-000000000000' } }) } 'qualification_target_refused:identitySubjects'
Invoke-Case 'a manifest whose recording bucket is the export bucket' { Export-Run (Write-Target @{ recordingBucket = 'alp-qualification-exports-588966314750-us-east-2' }) } 'qualification_target_refused:recordingBucket'
$global:StackOutputs['ai-clinical-core-qualification-foundation'] = '{"Outputs":[{"OutputKey":"PhiAllowed","OutputValue":"true"}],"Parameters":[]}'
Invoke-Case 'a foundation that does not state PHI false' { Export-Run $good } 'qualification_target_refused:foundation_phi'
$global:StackOutputs['ai-clinical-core-qualification-foundation'] = '{"Outputs":[{"OutputKey":"PhiAllowed","OutputValue":"false"},{"OutputKey":"ApiId","OutputValue":"wxv734oi12"}],"Parameters":[]}'
Invoke-Case 'a foundation that names the staging API' { Export-Run $good } 'qualification_target_refused:foundation_api'
$global:StackOutputs['ai-clinical-core-qualification-foundation'] = '{"Outputs":[{"OutputKey":"PhiAllowed","OutputValue":"false"},{"OutputKey":"ApiId","OutputValue":"6zt8e9qz04"}],"Parameters":[]}'

# 4. Acceptance mode needs the whole token matrix; an exploratory run is allowed to be partial and says so.
$global:StaleToken = $false
Invoke-Case 'acceptance without a stale sign-in token' { Export-Run $good } 'stale consumer token'
Invoke-Case 'exploratory without a stale sign-in token' { Export-Run $good 'exploratory' } $null
if ($global:Selected.mode -ne 'exploratory') { throw 'exploratory mode was not passed through' }
$global:StaleToken = $true

# 5. The retention service release is bound the same way: the row is written to the qualification database the manifest
#    names, never to a database a foundation stack exports, and exactly one target may be named.
$retentionRunner = Join-Path $PSScriptRoot 'release-aws-retention-service.ps1'
function Retention-Run([string]$targetFile) { & $retentionRunner -Command inspect -QualificationTargetPath $targetFile -DeploymentManifestPath $deploymentManifest }
Invoke-Case 'retention release selects the qualification database' { Retention-Run $good } $null
if ($global:Selected.databaseEnv -ne 'clinical_core_qualification') { throw 'retention release did not select the qualification database' }
Invoke-Case 'retention release refuses the staging database' { Retention-Run (Write-Target @{ databaseName = 'clinical_core' }) } 'qualification_target_refused:databaseName'
Invoke-Case 'retention release refuses two targets at once' { & $retentionRunner -Command inspect -QualificationTargetPath $good -FoundationStackName 'ai-clinical-core-synthetic-staging' -DeploymentManifestPath $deploymentManifest } 'exactly one target'
Invoke-Case 'retention release refuses no target at all' { & $retentionRunner -Command inspect -DeploymentManifestPath $deploymentManifest } 'exactly one target'

# 6. The synthetic-only confirmation is still required, and no external call happens without it.
Invoke-Case 'no synthetic-only confirmation' { & $exportRunner -QualificationTargetPath $good -DeploymentManifestPath $deploymentManifest } 'synthetic-only boundary'
if ($global:External -ne 0) { throw 'an external call happened before the synthetic-only confirmation' }

foreach ($name in 'CLINICAL_WORKFORCE_ID_TOKEN','CLINICAL_CONSUMER_ID_TOKEN','CLINICAL_FOREIGN_CONSUMER_ID_TOKEN','CLINICAL_STALE_CONSUMER_ID_TOKEN') { Remove-Item "Env:$name" -ErrorAction SilentlyContinue }
Remove-Item -Recurse -Force -LiteralPath $work
Write-Host "Hosted acceptance runner target binding: $global:passed cases passed (no AWS calls, no requests, no fixture writes)."
