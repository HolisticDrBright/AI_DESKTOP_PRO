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
$target = [ordered]@{
  schemaVersion = 'aws-clinical-core-qualification-target/1'; environment = 'synthetic-staging'; dataClassification = 'synthetic_only'; containsPhi = $false
  awsAccountId = '588966314750'; awsRegion = 'us-east-2'; foundationStackName = 'ai-clinical-core-qualification-foundation'
  apiId = '6zt8e9qz04'; apiOrigin = 'https://6zt8e9qz04.execute-api.us-east-2.amazonaws.com'
  databaseClusterArn = 'arn:aws:rds:us-east-2:588966314750:cluster:ai-clinical-core-synthetic-clinicaldatabasecluster-lftvrccuflxa'
  databaseSecretArn = 'arn:aws:secretsmanager:us-east-2:588966314750:secret:fictional-qualification-AbCdEf'
  databaseName = 'clinical_core_qualification'; exportBucket = 'alp-qualification-exports-588966314750-us-east-2'
  sourceCommit = $commit; migrationReleaseHash = ('b' * 64)
  identitySubjects = [ordered]@{ consumer = '11111111-2222-4333-8444-555555555555'; workforce = '66666666-7777-4888-8999-000000000000' }
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
function global:CandidateStack([string]$name, [string]$phi = 'false', [string]$activation = 'blocked', [string]$execution = 'enabled', [string]$source = $commit, [string]$database = 'clinical_core_qualification') {
  return "{""Outputs"":[{""OutputKey"":""PhiAllowed"",""OutputValue"":""$phi""},{""OutputKey"":""Activation"",""OutputValue"":""$activation""},{""OutputKey"":""QualificationExecution"",""OutputValue"":""$execution""},{""OutputKey"":""SourceCommit"",""OutputValue"":""$source""}],""Parameters"":[{""ParameterKey"":""DatabaseName"",""ParameterValue"":""$database""},{""ParameterKey"":""ApiId"",""ParameterValue"":""6zt8e9qz04""}]}"
}
foreach ($candidate in $target.stacks.Values) { $global:StackOutputs[$candidate] = (CandidateStack $candidate) }
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
$global:StackOutputs['ai-clinical-core-qualification-personal-storage'] = (CandidateStack 'x' 'true')
Invoke-Case 'a candidate with PHI enabled' { Export-Run $good } 'qualification_target_refused:stack_phi.personal-storage'
$global:StackOutputs['ai-clinical-core-qualification-personal-storage'] = (CandidateStack 'x' 'false' 'approved')
Invoke-Case 'a candidate with production activation approved' { Export-Run $good } 'qualification_target_refused:stack_activation.personal-storage'
$global:StackOutputs['ai-clinical-core-qualification-personal-storage'] = (CandidateStack 'x' 'false' 'blocked' 'disabled')
Invoke-Case 'a candidate whose qualification execution is disabled' { Export-Run $good } 'qualification_target_refused:stack_execution.personal-storage'
$global:StackOutputs['ai-clinical-core-qualification-personal-storage'] = (CandidateStack 'x' 'false' 'blocked' 'enabled' ('c' * 40))
Invoke-Case 'a candidate deployed from another commit' { Export-Run $good } 'qualification_target_refused:stack_source.personal-storage'
$global:StackOutputs['ai-clinical-core-qualification-personal-storage'] = (CandidateStack 'x' 'false' 'blocked' 'enabled' $commit 'clinical_core')
Invoke-Case 'a candidate pointed at the staging database' { Export-Run $good } 'qualification_target_refused:stack_database.personal-storage'
$global:StackOutputs['ai-clinical-core-qualification-personal-storage'] = (CandidateStack 'x')
$global:StackOutputs.Remove('ai-clinical-core-qualification-recording-capture')
Invoke-Case 'a recording candidate that is not deployed' { Recording-Run $good } 'qualification_target_refused:stack_missing.recording-capture'
$global:StackOutputs['ai-clinical-core-qualification-recording-capture'] = (CandidateStack 'x')
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

# 5. The synthetic-only confirmation is still required, and no external call happens without it.
Invoke-Case 'no synthetic-only confirmation' { & $exportRunner -QualificationTargetPath $good -DeploymentManifestPath $deploymentManifest } 'synthetic-only boundary'
if ($global:External -ne 0) { throw 'an external call happened before the synthetic-only confirmation' }

foreach ($name in 'CLINICAL_WORKFORCE_ID_TOKEN','CLINICAL_CONSUMER_ID_TOKEN','CLINICAL_FOREIGN_CONSUMER_ID_TOKEN','CLINICAL_STALE_CONSUMER_ID_TOKEN') { Remove-Item "Env:$name" -ErrorAction SilentlyContinue }
Remove-Item -Recurse -Force -LiteralPath $work
Write-Host "Hosted acceptance runner target binding: $global:passed cases passed (no AWS calls, no requests, no fixture writes)."
