# Shared by the hosted acceptance runners: reads the reviewed qualification target manifest
# (infra/aws-clinical-core/qualification-target.example.json, filled) and verifies, before any request or fixture write,
# that the live account and every candidate stack are the target it names. The old wrappers took the API origin and
# database from whatever foundation stack was named, and the documented name was the staging foundation; nothing here
# reads a foundation stack, and the staging origin, database and foundation stack the manifest lists are refused by name.
# Every refusal is thrown as 'qualification_target_refused:<field>'. Nothing is printed but stack names.
$QualificationTargetProductionAccount = '173535830222'
$QualificationTargetReservedDatabases = @('clinical_core', 'postgres', 'rdsadmin', 'template0', 'template1')

function Get-QualificationSubjects($Target) {
  # The designated fictional identities a candidate may serve: the owner, the workforce operator, the second consumer
  # whose refusal proves owner isolation (an identity the outer gate refuses would prove nothing), and, when the sweep is
  # under test, the retention service.
  $subjects = @($Target.identitySubjects.consumer, $Target.identitySubjects.workforce, $Target.identitySubjects.foreignConsumer)
  if ($Target.identitySubjects.PSObject.Properties.Name -contains 'retentionService' -and $Target.identitySubjects.retentionService) { $subjects += $Target.identitySubjects.retentionService }
  return $subjects
}

function Read-QualificationTarget([string]$Path, [string]$Region) {
  # Pre-network checks on the manifest itself; the Node CLI validates it again in full (qualification-target-manifest.ts).
  $target = Get-Content -Raw -LiteralPath $Path | ConvertFrom-Json
  if ($target.schemaVersion -ne 'aws-clinical-core-qualification-target/1') { throw 'qualification_target_refused:schemaVersion' }
  if ($target.environment -ne 'synthetic-staging' -or $target.dataClassification -ne 'synthetic_only' -or $target.containsPhi -ne $false) { throw 'qualification_target_refused:posture' }
  if ($target.awsAccountId -notmatch '^\d{12}$' -or $target.awsAccountId -eq $QualificationTargetProductionAccount -or $target.awsAccountId -eq '000000000000') { throw 'qualification_target_refused:awsAccountId' }
  if ($target.awsRegion -ne $Region) { throw 'qualification_target_refused:awsRegion' }
  if (-not $target.refused -or -not $target.refused.stagingApiOrigin -or -not $target.refused.stagingDatabaseName -or -not $target.refused.stagingFoundationStackName) { throw 'qualification_target_refused:refused' }
  if ($target.apiId -cnotmatch '^[a-z0-9]{10}$' -or $target.apiId -match 'replace') { throw 'qualification_target_refused:apiId' }
  if ($target.apiOrigin -ne "https://$($target.apiId).execute-api.$Region.amazonaws.com") { throw 'qualification_target_refused:apiOrigin' }
  if ($target.apiOrigin -eq $target.refused.stagingApiOrigin) { throw 'qualification_target_refused:stagingApiOrigin' }
  if ($target.databaseName -cnotmatch '^[a-z][a-z0-9_]{0,62}$' -or -not $target.databaseName.Contains('qualification') -or
      $target.databaseName -in $QualificationTargetReservedDatabases -or $target.databaseName -eq $target.refused.stagingDatabaseName) { throw 'qualification_target_refused:databaseName' }
  if ($target.sourceCommit -cnotmatch '^[a-f0-9]{40}$' -or $target.sourceCommit -match '^0+$') { throw 'qualification_target_refused:sourceCommit' }
  if ($target.migrationReleaseHash -cnotmatch '^[a-f0-9]{64}$' -or $target.migrationReleaseHash -match '^0+$') { throw 'qualification_target_refused:migrationReleaseHash' }
  if (-not $target.exportBucket -or $target.exportBucket -match 'replace') { throw 'qualification_target_refused:exportBucket' }
  if (-not $target.recordingBucket -or $target.recordingBucket -match 'replace' -or $target.recordingBucket -eq $target.exportBucket) { throw 'qualification_target_refused:recordingBucket' }
  if (-not $target.identitySubjects -or -not $target.identitySubjects.consumer -or -not $target.identitySubjects.workforce -or -not $target.identitySubjects.foreignConsumer) { throw 'qualification_target_refused:identitySubjects' }
  foreach ($subject in (Get-QualificationSubjects $target)) { if ($subject -match 'replace') { throw 'qualification_target_refused:identitySubjects' } }
  if (-not $target.foundationStackName -or $target.foundationStackName -eq $target.refused.stagingFoundationStackName -or $target.foundationStackName -match 'synthetic-staging') { throw 'qualification_target_refused:foundationStackName' }
  if (-not $target.stacks) { throw 'qualification_target_refused:stacks' }
  foreach ($stack in $target.stacks.PSObject.Properties) {
    if (-not $stack.Value -or $stack.Value -eq $target.refused.stagingFoundationStackName -or $stack.Value -match 'synthetic-staging') { throw "qualification_target_refused:stacks.$($stack.Name)" }
  }
  return $target
}

function Assert-QualificationDeploymentManifest($Target, [string]$DeploymentManifestPath, [string]$Region) {
  # The reviewed deployment manifest pins the same account and region; a disagreement means the wrong manifest was named.
  $deployment = Get-Content -Raw -LiteralPath $DeploymentManifestPath | ConvertFrom-Json
  if ($deployment.aws_account_id -eq $QualificationTargetProductionAccount) { throw 'qualification_target_refused:deployment_manifest_production' }
  if ($deployment.aws_account_id -ne $Target.awsAccountId -or $deployment.aws_region -ne $Region) { throw 'qualification_target_refused:deployment_manifest' }
  return $deployment
}

function Assert-QualificationSourceCommit($Target) {
  $head = (git rev-parse HEAD)
  if ($LASTEXITCODE -ne 0 -or -not $head) { throw 'qualification_target_refused:git' }
  $head = "$head".Trim()
  if ($head -ne $Target.sourceCommit) { throw 'qualification_target_refused:sourceCommit_checkout' }
  return $head
}

function Assert-QualificationAccount($Target) {
  $account = aws sts get-caller-identity --query Account --output text
  if ($LASTEXITCODE -ne 0 -or -not $account) { throw 'qualification_target_refused:sts' }
  $account = "$account".Trim()
  if ($account -eq $QualificationTargetProductionAccount -or $account -ne $Target.awsAccountId) { throw 'qualification_target_refused:account' }
  return $account
}

function Assert-QualificationFoundation($Target, [string]$Region) {
  # The dedicated qualification foundation (API, buckets, keys, alarms): PHI false, and where it states the API or database
  # they are the manifest's. Its QualificationExecution output reads 'disabled' by design (it deploys no candidate) and is
  # not candidate evidence; the candidates are verified one by one below. The staging foundation is refused by name above.
  $described = aws cloudformation describe-stacks --stack-name $Target.foundationStackName --region $Region --query 'Stacks[0]' --output json
  if ($LASTEXITCODE -ne 0 -or -not $described) { throw 'qualification_target_refused:foundation_missing' }
  $stack = $described | ConvertFrom-Json
  if (-not $stack) { throw 'qualification_target_refused:foundation_missing' }
  $outputs = @{}
  foreach ($entry in @($stack.Outputs)) { if ($entry) { $outputs[$entry.OutputKey] = $entry.OutputValue } }
  if ($outputs['PhiAllowed'] -ne 'false') { throw 'qualification_target_refused:foundation_phi' }
  if ($outputs.ContainsKey('Activation') -and $outputs['Activation'] -ne 'blocked') { throw 'qualification_target_refused:foundation_activation' }
  if ($outputs.ContainsKey('ApiId') -and $outputs['ApiId'] -ne $Target.apiId) { throw 'qualification_target_refused:foundation_api' }
  if ($outputs.ContainsKey('ApiOrigin') -and $outputs['ApiOrigin'] -ne $Target.apiOrigin) { throw 'qualification_target_refused:foundation_api' }
  if ($outputs.ContainsKey('DatabaseName') -and $outputs['DatabaseName'] -ne $Target.databaseName) { throw 'qualification_target_refused:foundation_database' }
  Write-Host "Verified qualification foundation $($Target.foundationStackName) (prepared infrastructure only; not candidate evidence)."
}

function Assert-QualificationStacks($Target, [string[]]$Candidates, [string]$Region, [ValidateSet('qualification','drain')][string]$Posture = 'qualification') {
  # Every candidate the run depends on must be deployed from the target's commit with PHI false, production activation
  # blocked and qualification execution enabled, against the target's API and database. A stack that reports otherwise
  # (or the staging foundation, or a missing stack) stops the run before any request.
  foreach ($candidate in $Candidates) {
    $name = $Target.stacks.$candidate
    if (-not $name -or $name -eq $Target.refused.stagingFoundationStackName) { throw "qualification_target_refused:stacks.$candidate" }
    $described = aws cloudformation describe-stacks --stack-name $name --region $Region --query 'Stacks[0]' --output json
    if ($LASTEXITCODE -ne 0 -or -not $described) { throw "qualification_target_refused:stack_missing.$candidate" }
    $stack = $described | ConvertFrom-Json
    if (-not $stack) { throw "qualification_target_refused:stack_missing.$candidate" }
    $outputs = @{}
    foreach ($entry in @($stack.Outputs)) { if ($entry) { $outputs[$entry.OutputKey] = $entry.OutputValue } }
    $parameters = @{}
    foreach ($entry in @($stack.Parameters)) { if ($entry) { $parameters[$entry.ParameterKey] = $entry.ParameterValue } }
    if ($outputs['PhiAllowed'] -ne 'false') { throw "qualification_target_refused:stack_phi.$candidate" }
    if ($Posture -eq 'drain') {
      # The voice shutdown posture: the candidate serves no one, and qualification execution is refused by policy while draining.
      if ($outputs['Activation'] -ne 'draining') { throw "qualification_target_refused:stack_activation.$candidate" }
      if ($outputs['QualificationExecution'] -ne 'disabled') { throw "qualification_target_refused:stack_execution.$candidate" }
    } else {
      if ($outputs['Activation'] -ne 'blocked') { throw "qualification_target_refused:stack_activation.$candidate" }
      if ($outputs['QualificationExecution'] -ne 'enabled') { throw "qualification_target_refused:stack_execution.$candidate" }
    }
    # owned-lab and owned-voice attach to the shared API and export no SourceCommit; the others must export the manifest's.
    if ($candidate -in @('owned-lab','owned-voice')) {
      if ($outputs.ContainsKey('SourceCommit') -and $outputs['SourceCommit'] -ne $Target.sourceCommit) { throw "qualification_target_refused:stack_source.$candidate" }
    } elseif ($outputs['SourceCommit'] -ne $Target.sourceCommit) { throw "qualification_target_refused:stack_source.$candidate" }
    if ($stack.StackStatus -notin @('CREATE_COMPLETE','UPDATE_COMPLETE','UPDATE_ROLLBACK_COMPLETE','IMPORT_COMPLETE','IMPORT_ROLLBACK_COMPLETE')) { throw "qualification_target_refused:stack_status.$candidate" }
    # A database or API name does not identify one database or API: compare the resources themselves. Every candidate
    # carries the cluster, secret, database and account; the API and the buckets are required of the candidates that use them.
    $required = [ordered]@{ DatabaseClusterArn = $Target.databaseClusterArn; DatabaseSecretArn = $Target.databaseSecretArn; DatabaseName = $Target.databaseName; QualificationAccountId = $Target.awsAccountId }
    if ($candidate -in @('owned-lab','owned-voice')) { $required['ClinicalApiId'] = $Target.apiId } else { $required['ApiId'] = $Target.apiId }
    if ($candidate -in @('personal-storage','privacy-operations')) { $required['ExportBucketName'] = $Target.exportBucket }
    if ($candidate -in @('recording-capture','recording-transcription','recording-drafting','recording-cleanup-execution')) { $required['RecordingBucket'] = $Target.recordingBucket }
    foreach ($key in $required.Keys) {
      if (-not $parameters.ContainsKey($key)) { throw "qualification_target_refused:stack_parameter_missing.$candidate.$key" }
      if ($parameters[$key] -ne $required[$key]) { throw "qualification_target_refused:stack_parameter.$candidate.$key" }
    }
    if ($parameters.ContainsKey('SourceCommit') -and $parameters['SourceCommit'] -ne $Target.sourceCommit) { throw "qualification_target_refused:stack_source.$candidate" }
    if ($Posture -eq 'drain') { Write-Host "Verified draining candidate $name ($candidate); it serves no one."; continue }
    $expectedSubjects = Get-QualificationSubjects $Target
    $listed = @()
    if ($parameters.ContainsKey('QualificationIdentitySubjects')) { $listed = @($parameters['QualificationIdentitySubjects'] -split ',' | ForEach-Object { $_.Trim() } | Where-Object { $_ }) }
    if ($listed.Count -ne $expectedSubjects.Count -or (@($expectedSubjects | Where-Object { $_ -notin $listed }).Count -gt 0)) { throw "qualification_target_refused:stack_subjects.$candidate" }
    Write-Host "Verified qualification stack $name ($candidate)."
  }
}
