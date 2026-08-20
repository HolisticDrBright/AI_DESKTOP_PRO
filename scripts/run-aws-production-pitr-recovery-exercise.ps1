param(
  [string]$FoundationStackName = "ai-longevity-production-clinical-foundation",
  [string]$AwsProfile = "ai-production",
  [string]$Region = "us-east-2",
  [string]$OutputPath = "",
  [switch]$ConfirmPhiDisabledRecoveryExercise
)

$ErrorActionPreference = "Stop"
$expectedAccount = "173535830222"
$exerciseStarted = [DateTimeOffset]::UtcNow
$stamp = $exerciseStarted.ToUnixTimeSeconds()
$restoreId = "ai-production-phi-disabled-pitr-$stamp"
$restoreInstanceId = "$restoreId-writer"
$clusterCreated = $false
$instanceCreated = $false

if (-not $ConfirmPhiDisabledRecoveryExercise) {
  throw "Refusing operation: explicitly confirm the PHI-disabled production recovery exercise."
}
if (-not (Get-Command aws -ErrorAction SilentlyContinue)) {
  throw "AWS CLI is required. No cloud operation was attempted."
}

$account = aws sts get-caller-identity --profile $AwsProfile --query Account --output text
if ($account -ne $expectedAccount) { throw "Production recovery exercise requires account $expectedAccount." }
$env:AWS_PROFILE = $AwsProfile
$env:AWS_REGION = $Region

function StackOutput([object[]]$outputs, [string]$key) {
  $entry = $outputs | Where-Object OutputKey -eq $key
  if (-not $entry) { throw "Foundation output $key is missing." }
  return $entry.OutputValue
}

function QueryDatabase([string]$resourceArn, [string]$secretArn, [string]$database, [string]$sql) {
  $requestPath = Join-Path $env:TEMP ("production-pitr-query-" + [guid]::NewGuid().ToString("N") + ".json")
  try {
    @{
      resourceArn = $resourceArn
      secretArn = $secretArn
      database = $database
      sql = $sql
      includeResultMetadata = $true
    } | ConvertTo-Json -Compress | ForEach-Object {
      [IO.File]::WriteAllText($requestPath, $_, (New-Object Text.UTF8Encoding($false)))
    }
    $result = aws rds-data execute-statement --cli-input-json `
      ("file://" + $requestPath.Replace("\", "/")) --output json | ConvertFrom-Json
    if ($LASTEXITCODE -ne 0) { throw "Recovery database query failed." }
    return $result
  } finally {
    Remove-Item -LiteralPath $requestPath -Force -ErrorAction SilentlyContinue
  }
}

try {
  $outputs = aws cloudformation describe-stacks --region $Region --stack-name $FoundationStackName `
    --query "Stacks[0].Outputs" --output json | ConvertFrom-Json
  $phiAllowed = StackOutput $outputs "PhiAllowed"
  $environment = StackOutput $outputs "Environment"
  $classification = StackOutput $outputs "DataClassification"
  if ($phiAllowed -ne "false" -or $environment -ne "production-clinical" `
    -or $classification -ne "clinical_phi_target") {
    throw "Foundation is not the reviewed PHI-disabled production boundary."
  }

  $clusterArn = StackOutput $outputs "DatabaseClusterArn"
  $clusterId = $clusterArn.Split(":")[-1]
  $secretArn = StackOutput $outputs "DatabaseSecretArn"
  $database = StackOutput $outputs "DatabaseName"
  $databaseKeyId = aws cloudformation describe-stack-resource --region $Region `
    --stack-name $FoundationStackName --logical-resource-id DatabaseKey `
    --query "StackResourceDetail.PhysicalResourceId" --output text
  if ($databaseKeyId -notmatch '^[0-9a-f-]{36}$') { throw "Foundation DatabaseKey is missing." }
  $kmsKeyArn = "arn:aws:kms:${Region}:${account}:key/${databaseKeyId}"
  $source = aws rds describe-db-clusters --db-cluster-identifier $clusterId `
    --query "DBClusters[0]" --output json | ConvertFrom-Json
  if (-not $source.StorageEncrypted -or $source.KmsKeyId -ne $kmsKeyArn `
    -or $source.PubliclyAccessible -or -not $source.DeletionProtection `
    -or [int]$source.BackupRetentionPeriod -ne 35) {
    throw "Source cluster encryption, network, deletion, or retention posture is invalid."
  }
  if (-not $source.LatestRestorableTime) { throw "Source cluster has no latest restorable time." }

  $sourceCounts = QueryDatabase $clusterArn $secretArn $database @"
select
  (select count(*)::int from clinical_core.schema_migrations),
  (select count(*)::int from information_schema.tables
    where table_schema in ('clinical_core','clinical_private','clinical_audit')
      and table_name <> 'schema_migrations'),
  (select count(*)::int from clinical_core.organizations),
  (select count(*)::int from clinical_core.persons),
  (select count(*)::int from clinical_core.patient_records),
  (select count(*)::int from clinical_core.lab_import_events),
  (select count(*)::int from clinical_core.consumer_clinical_record_versions),
  (select count(*)::int from clinical_core.review_queue_items),
  (select count(*)::int from clinical_core.appointments),
  (select count(*)::int from clinical_core.appointment_status_events),
  (select count(*)::int from clinical_core.encounters),
  (select count(*)::int from clinical_core.clinical_notes),
  (select count(*)::int from clinical_core.clinical_note_versions),
  (select count(*)::int from clinical_core.note_signatures),
  (select count(*)::int from clinical_core.note_addenda),
  (select count(*)::int from clinical_core.note_provenance_refs),
  (select count(*)::int from clinical_audit.events)
"@
  $sourceVector = @($sourceCounts.records[0] | ForEach-Object { [int64]$_.longValue })
  if (($sourceVector -join ",") -ne "12,26,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0") {
    throw "Source database is not the reviewed empty 12-migration/26-table state."
  }

  $securityGroups = @($source.VpcSecurityGroups | ForEach-Object { $_.VpcSecurityGroupId })
  $restoreRequest = @(
    "rds", "restore-db-cluster-to-point-in-time",
    "--source-db-cluster-identifier", $clusterId,
    "--db-cluster-identifier", $restoreId,
    "--restore-type", "full-copy",
    "--use-latest-restorable-time",
    "--db-subnet-group-name", $source.DBSubnetGroup,
    "--vpc-security-group-ids"
  ) + $securityGroups + @(
    "--kms-key-id", $kmsKeyArn,
    "--enable-iam-database-authentication",
    "--serverless-v2-scaling-configuration", "MinCapacity=0.5,MaxCapacity=1",
    "--tags", "Key=DataClassification,Value=clinical_phi_target", "Key=Purpose,Value=phi_disabled_recovery_exercise",
    "--region", $Region
  )
  & aws @restoreRequest | Out-Null
  if ($LASTEXITCODE -ne 0) { throw "Point-in-time restore request failed." }
  $clusterCreated = $true
  aws rds wait db-cluster-available --db-cluster-identifier $restoreId --region $Region
  if ($LASTEXITCODE -ne 0) { throw "Restored cluster did not become available." }

  $restored = aws rds describe-db-clusters --db-cluster-identifier $restoreId `
    --query "DBClusters[0]" --output json | ConvertFrom-Json
  if (-not $restored.StorageEncrypted -or $restored.KmsKeyId -ne $kmsKeyArn `
    -or $restored.PubliclyAccessible -or $restored.DBSubnetGroup -ne $source.DBSubnetGroup) {
    throw "Restored cluster encryption or private-network posture is invalid."
  }
  aws rds enable-http-endpoint --resource-arn $restored.DBClusterArn --region $Region | Out-Null
  if ($LASTEXITCODE -ne 0) { throw "Restored Data API enablement failed." }
  aws rds create-db-instance --db-instance-identifier $restoreInstanceId `
    --db-cluster-identifier $restoreId --engine aurora-postgresql `
    --db-instance-class db.serverless --region $Region `
    --tags Key=DataClassification,Value=clinical_phi_target Key=Purpose,Value=phi_disabled_recovery_exercise | Out-Null
  if ($LASTEXITCODE -ne 0) { throw "Restored writer creation failed." }
  $instanceCreated = $true
  aws rds wait db-instance-available --db-instance-identifier $restoreInstanceId --region $Region
  if ($LASTEXITCODE -ne 0) { throw "Restored writer did not become available." }

  $restoredCounts = QueryDatabase $restored.DBClusterArn $secretArn $database @"
select
  (select count(*)::int from clinical_core.schema_migrations),
  (select count(*)::int from information_schema.tables
    where table_schema in ('clinical_core','clinical_private','clinical_audit')
      and table_name <> 'schema_migrations'),
  (select count(*)::int from clinical_core.organizations),
  (select count(*)::int from clinical_core.persons),
  (select count(*)::int from clinical_core.patient_records),
  (select count(*)::int from clinical_core.lab_import_events),
  (select count(*)::int from clinical_core.consumer_clinical_record_versions),
  (select count(*)::int from clinical_core.review_queue_items),
  (select count(*)::int from clinical_core.appointments),
  (select count(*)::int from clinical_core.appointment_status_events),
  (select count(*)::int from clinical_core.encounters),
  (select count(*)::int from clinical_core.clinical_notes),
  (select count(*)::int from clinical_core.clinical_note_versions),
  (select count(*)::int from clinical_core.note_signatures),
  (select count(*)::int from clinical_core.note_addenda),
  (select count(*)::int from clinical_core.note_provenance_refs),
  (select count(*)::int from clinical_audit.events)
"@
  $restoredVector = @($restoredCounts.records[0] | ForEach-Object { [int64]$_.longValue })
  if (($restoredVector -join ",") -ne ($sourceVector -join ",")) {
    throw "Restored database does not match the reviewed empty source state."
  }

  $verifiedAt = [DateTimeOffset]::UtcNow
  $evidence = [ordered]@{
    contractVersion = "production-pitr-recovery-exercise/1"
    observedAt = $verifiedAt.ToString("o")
    account = $account
    region = $Region
    phiAllowed = $false
    sourceClusterEncrypted = $true
    sourceDeletionProtection = $true
    sourceBackupRetentionDays = 35
    sourceLatestRestorableTime = ([DateTimeOffset]$source.LatestRestorableTime).ToString("o")
    restoredClusterEncrypted = $true
    restoredClusterPrivate = $true
    migrationCount = $restoredVector[0]
    tableCount = $restoredVector[1]
    clinicalRowCount = ($restoredVector[2..16] | Measure-Object -Sum).Sum
    restoreVerificationSeconds = [math]::Round(($verifiedAt - $exerciseStarted).TotalSeconds, 1)
    temporaryResourcesDeleted = $false
  }
} finally {
  if ($instanceCreated) {
    aws rds delete-db-instance --db-instance-identifier $restoreInstanceId `
      --skip-final-snapshot --region $Region | Out-Null
    aws rds wait db-instance-deleted --db-instance-identifier $restoreInstanceId --region $Region
  }
  if ($clusterCreated) {
    aws rds delete-db-cluster --db-cluster-identifier $restoreId `
      --skip-final-snapshot --region $Region | Out-Null
    aws rds wait db-cluster-deleted --db-cluster-identifier $restoreId --region $Region
  }
  Remove-Item Env:AWS_PROFILE,Env:AWS_REGION -ErrorAction SilentlyContinue
}

if (-not $evidence) { throw "Recovery exercise did not produce evidence." }
$evidence.temporaryResourcesDeleted = $true
$canonical = $evidence | ConvertTo-Json -Depth 8 -Compress
$hash = [Convert]::ToHexString([Security.Cryptography.SHA256]::HashData(
  [Text.Encoding]::UTF8.GetBytes($canonical))).ToLowerInvariant()
if ($OutputPath) {
  $parent = Split-Path -Parent $OutputPath
  if (-not $parent -or -not (Test-Path -LiteralPath $parent -PathType Container)) {
    throw "OutputPath parent must already exist."
  }
  $record = [ordered]@{}
  foreach ($key in $evidence.Keys) { $record[$key] = $evidence[$key] }
  $record.evidenceSha256 = $hash
  [IO.File]::WriteAllText($OutputPath, ($record | ConvertTo-Json -Depth 8), `
    (New-Object Text.UTF8Encoding($false)))
}
Write-Host "Production PITR recovery exercise passed; temporary resources were deleted. Evidence SHA-256: $hash"
