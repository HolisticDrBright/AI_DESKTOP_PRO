param(
  [string]$FoundationStackName = "ai-clinical-core-synthetic-staging",
  [string]$Region = "us-east-2",
  [string]$Profile = "ai-synthetic-member",
  [string]$ExistingSnapshotId = "",
  [switch]$ConfirmSyntheticOnly
)

$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
Set-Location $root
if (-not $ConfirmSyntheticOnly) { throw "Refusing operation: explicitly confirm the synthetic-only boundary." }
$env:AWS_PROFILE = $Profile
$env:AWS_REGION = $Region

$outputs = aws cloudformation describe-stacks --stack-name $FoundationStackName --region $Region --query "Stacks[0].Outputs" --output json | ConvertFrom-Json
function Output([string]$key) {
  $entry = $outputs | Where-Object OutputKey -eq $key
  if (-not $entry) { throw "Foundation output $key is missing." }
  return $entry.OutputValue
}
if ((Output "PhiAllowed") -ne "false" -or (Output "DataClassification") -ne "synthetic_only") { throw "Synthetic-only foundation required." }

$clusterArn = Output "DatabaseClusterArn"
$clusterId = $clusterArn.Split(":")[-1]
$secretArn = Output "DatabaseSecretArn"
$database = Output "DatabaseName"
$kmsKeyArn = Output "ClinicalCoreKeyArn"
$stamp = [DateTimeOffset]::UtcNow.ToUnixTimeSeconds()
$snapshotId = if ($ExistingSnapshotId) { $ExistingSnapshotId } else { "ai-clinical-synthetic-acceptance-$stamp" }
$restoreId = "ai-clinical-synthetic-restore-$stamp"
$restoreInstanceId = "$restoreId-writer"
$restoreCreated = $false

function Query([string]$sql) {
  $requestPath = Join-Path $env:TEMP ("rds-acceptance-" + [guid]::NewGuid().ToString("N") + ".json")
  try {
    @{ resourceArn = $clusterArn; secretArn = $secretArn; database = $database; sql = $sql; includeResultMetadata = $true } |
      ConvertTo-Json -Compress | ForEach-Object { [IO.File]::WriteAllText($requestPath, $_, (New-Object Text.UTF8Encoding($false))) }
    $result = aws rds-data execute-statement --cli-input-json ("file://" + $requestPath.Replace("\", "/")) --region $Region --output json | ConvertFrom-Json
    if ($LASTEXITCODE -ne 0) { throw "Audit query failed." }
    return $result
  } finally { Remove-Item -LiteralPath $requestPath -Force -ErrorAction SilentlyContinue }
}

$audit = Query "select action, count(*)::int as count from clinical_audit.events where action in ('connection.invitation_issued','connection.invitation_claimed','consent.granted','consent.revoked') group by action order by action"
$actions = @($audit.records | ForEach-Object { $_[0].stringValue })
foreach ($required in @("connection.invitation_issued", "connection.invitation_claimed", "consent.granted", "consent.revoked")) {
  if ($actions -notcontains $required) { throw "Required synthetic audit action is missing." }
}

$trail = aws cloudtrail get-trail-status --name "ai-clinical-core-synthetic-staging" --region $Region --output json | ConvertFrom-Json
if (-not $trail.IsLogging -or -not $trail.LatestDeliveryTime) { throw "CloudTrail delivery is not active." }

try {
  if (-not $ExistingSnapshotId) {
    aws rds create-db-cluster-snapshot --db-cluster-identifier $clusterId --db-cluster-snapshot-identifier $snapshotId --region $Region --tags Key=DataClassification,Value=synthetic_only Key=Purpose,Value=recovery_acceptance | Out-Null
    if ($LASTEXITCODE -ne 0) { throw "Snapshot creation failed." }
    aws rds wait db-cluster-snapshot-available --db-cluster-snapshot-identifier $snapshotId --region $Region
  }
  $snapshot = aws rds describe-db-cluster-snapshots --db-cluster-snapshot-identifier $snapshotId --region $Region --query "DBClusterSnapshots[0]" --output json | ConvertFrom-Json
  if (-not $snapshot.StorageEncrypted -or $snapshot.KmsKeyId -ne $kmsKeyArn -or $snapshot.Status -ne "available") { throw "Snapshot encryption or availability check failed." }

  $source = aws rds describe-db-clusters --db-cluster-identifier $clusterId --region $Region --query "DBClusters[0]" --output json | ConvertFrom-Json
  $securityGroups = @($source.VpcSecurityGroups | ForEach-Object { $_.VpcSecurityGroupId })
  $restoreRequest = @(
    "rds", "restore-db-cluster-from-snapshot",
    "--db-cluster-identifier", $restoreId,
    "--snapshot-identifier", $snapshotId,
    "--engine", "aurora-postgresql",
    "--db-subnet-group-name", $source.DBSubnetGroup,
    "--vpc-security-group-ids"
  ) + $securityGroups + @(
    "--kms-key-id", $kmsKeyArn,
    "--enable-iam-database-authentication",
    "--serverless-v2-scaling-configuration", "MinCapacity=0.5,MaxCapacity=1",
    "--region", $Region,
    "--tags", "Key=DataClassification,Value=synthetic_only", "Key=Purpose,Value=recovery_acceptance"
  )
  & aws @restoreRequest | Out-Null
  if ($LASTEXITCODE -ne 0) { throw "Cluster restore failed." }
  $restoreCreated = $true
  aws rds wait db-cluster-available --db-cluster-identifier $restoreId --region $Region
  aws rds enable-http-endpoint --resource-arn ("arn:aws:rds:${Region}:" + (aws sts get-caller-identity --query Account --output text) + ":cluster:$restoreId") --region $Region | Out-Null
  if ($LASTEXITCODE -ne 0) { throw "Restored Data API enablement failed." }
  aws rds create-db-instance --db-instance-identifier $restoreInstanceId --db-cluster-identifier $restoreId --engine aurora-postgresql --db-instance-class db.serverless --region $Region --tags Key=DataClassification,Value=synthetic_only Key=Purpose,Value=recovery_acceptance | Out-Null
  if ($LASTEXITCODE -ne 0) { throw "Restored writer creation failed." }
  aws rds wait db-instance-available --db-instance-identifier $restoreInstanceId --region $Region

  $restored = aws rds describe-db-clusters --db-cluster-identifier $restoreId --region $Region --query "DBClusters[0]" --output json | ConvertFrom-Json
  if (-not $restored.StorageEncrypted -or $restored.KmsKeyId -ne $kmsKeyArn -or $restored.PubliclyAccessible) { throw "Restored cluster posture is invalid." }
  if ($restored.DBSubnetGroup -ne $source.DBSubnetGroup) { throw "Restored cluster left the reviewed private subnet group." }
  $readPath = Join-Path $env:TEMP ("rds-restore-read-" + [guid]::NewGuid().ToString("N") + ".json")
  try {
    @{ resourceArn = $restored.DBClusterArn; secretArn = $secretArn; database = $database; sql = "select count(*)::int as count from clinical_core.schema_migrations"; includeResultMetadata = $true } |
      ConvertTo-Json -Compress | ForEach-Object { [IO.File]::WriteAllText($readPath, $_, (New-Object Text.UTF8Encoding($false))) }
    $read = aws rds-data execute-statement --cli-input-json ("file://" + $readPath.Replace("\", "/")) --region $Region --output json | ConvertFrom-Json
    if ($LASTEXITCODE -ne 0 -or [int]$read.records[0][0].longValue -lt 2) { throw "Restored database readability check failed." }
  } finally { Remove-Item -LiteralPath $readPath -Force -ErrorAction SilentlyContinue }
} finally {
  if ($restoreCreated) {
    aws rds delete-db-instance --db-instance-identifier $restoreInstanceId --skip-final-snapshot --region $Region 2>$null | Out-Null
    aws rds wait db-instance-deleted --db-instance-identifier $restoreInstanceId --region $Region 2>$null
    aws rds delete-db-cluster --db-cluster-identifier $restoreId --skip-final-snapshot --region $Region 2>$null | Out-Null
    aws rds wait db-cluster-deleted --db-cluster-identifier $restoreId --region $Region 2>$null
  }
}

Write-Host "Audit delivery, encrypted backup, and private restore acceptance passed. The temporary restore was deleted; the encrypted acceptance snapshot was retained."
