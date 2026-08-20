param(
  [string]$FoundationStackName = "ai-longevity-production-clinical-foundation",
  [string]$DisabledApiStackName = "ai-longevity-production-clinical-api-disabled",
  [string]$AwsProfile = "ai-production",
  [string]$Region = "us-east-2",
  [string]$OutputPath = "",
  [switch]$ConfirmPhiDisabled
)

$ErrorActionPreference = "Stop"
$expectedAccount = "173535830222"
if (-not $ConfirmPhiDisabled) {
  throw "Refusing exercise: explicitly confirm the PHI-disabled production boundary."
}

function StackOutputs([string]$stackName) {
  $stack = aws cloudformation describe-stacks --profile $AwsProfile --region $Region `
    --stack-name $stackName --query "Stacks[0]" --output json | ConvertFrom-Json
  if ($LASTEXITCODE -ne 0 -or $stack.StackStatus -notmatch "^(CREATE|UPDATE)_COMPLETE$") {
    throw "Required stack is not complete: $stackName"
  }
  $values = @{}
  foreach ($entry in $stack.Outputs) { $values[$entry.OutputKey] = $entry.OutputValue }
  return @{ status = $stack.StackStatus; values = $values }
}

function QueryDatabase([hashtable]$foundation, [string]$sql) {
  $requestPath = Join-Path ([IO.Path]::GetTempPath()) ("production-boundary-db-" + [guid]::NewGuid().ToString("N") + ".json")
  try {
    @{
      resourceArn = $foundation.DatabaseClusterArn
      secretArn = $foundation.DatabaseSecretArn
      database = $foundation.DatabaseName
      sql = $sql
      includeResultMetadata = $true
    } | ConvertTo-Json -Compress | ForEach-Object {
      [IO.File]::WriteAllText($requestPath, $_, (New-Object Text.UTF8Encoding($false)))
    }
    $result = aws rds-data execute-statement --profile $AwsProfile --region $Region `
      --cli-input-json ("file://" + $requestPath.Replace("\", "/")) --output json | ConvertFrom-Json
    if ($LASTEXITCODE -ne 0) { throw "Production database posture query failed." }
    return $result
  } finally {
    Remove-Item -LiteralPath $requestPath -Force -ErrorAction SilentlyContinue
  }
}

$account = aws sts get-caller-identity --profile $AwsProfile --query Account --output text
if ($LASTEXITCODE -ne 0 -or $account -ne $expectedAccount) {
  throw "Exercise requires the reviewed production account."
}

$foundationStack = StackOutputs $FoundationStackName
$foundation = $foundationStack.values
if ($foundation.PhiAllowed -ne "false" -or $foundation.Environment -ne "production-clinical" `
  -or $foundation.DataClassification -ne "clinical_phi_target") {
  throw "Foundation is not the reviewed PHI-disabled production boundary."
}

$productionBoundPools = 0
foreach ($poolId in @($foundation.WorkforceUserPoolId, $foundation.ConsumerUserPoolId)) {
  $attribute = @(aws cognito-idp describe-user-pool --profile $AwsProfile --region $Region `
    --user-pool-id $poolId --query "UserPool.SchemaAttributes[?Name=='custom:production_bound']" `
    --output json | ConvertFrom-Json)
  if ($attribute.Count -ne 1 -or $attribute[0].AttributeDataType -ne "String" `
    -or $attribute[0].Mutable -ne $false -or $attribute[0].Required -ne $false `
    -or $attribute[0].StringAttributeConstraints.MinLength -ne "4" `
    -or $attribute[0].StringAttributeConstraints.MaxLength -ne "4") {
    throw "Production Cognito pool is missing the immutable four-character production_bound attribute."
  }
  $productionBoundPools++
}

$guardDuty = aws guardduty get-detector --profile $AwsProfile --region $Region `
  --detector-id $foundation.GuardDutyDetectorId --output json | ConvertFrom-Json
$guardDutyFeatureState = @{}
foreach ($feature in $guardDuty.Features) { $guardDutyFeatureState[$feature.Name] = $feature.Status }
$requiredGuardDutyFeatures = @(
  "S3_DATA_EVENTS", "EKS_AUDIT_LOGS", "EBS_MALWARE_PROTECTION",
  "RDS_LOGIN_EVENTS", "LAMBDA_NETWORK_LOGS", "RUNTIME_MONITORING"
)
if (@($requiredGuardDutyFeatures | Where-Object { $guardDutyFeatureState[$_] -ne "ENABLED" }).Count -ne 0) {
  throw "A reviewed GuardDuty production protection plan is not enabled."
}

$driftDetectionId = aws cloudformation detect-stack-drift --profile $AwsProfile --region $Region `
  --stack-name $FoundationStackName --query "StackDriftDetectionId" --output text
do {
  Start-Sleep -Seconds 3
  $drift = aws cloudformation describe-stack-drift-detection-status --profile $AwsProfile --region $Region `
    --stack-drift-detection-id $driftDetectionId --output json | ConvertFrom-Json
} while ($drift.DetectionStatus -eq "DETECTION_IN_PROGRESS")
if ($drift.DetectionStatus -ne "DETECTION_COMPLETE") { throw "Production foundation drift detection did not complete." }
$serviceReportedDisabledFeatures = 0
if ($drift.StackDriftStatus -ne "IN_SYNC") {
  $resourceDrifts = @(aws cloudformation describe-stack-resource-drifts --profile $AwsProfile --region $Region `
    --stack-name $FoundationStackName --stack-resource-drift-status-filters MODIFIED DELETED NOT_CHECKED `
    --query "StackResourceDrifts" --output json | ConvertFrom-Json)
  if ($resourceDrifts.Count -ne 1 -or $resourceDrifts[0].LogicalResourceId -ne "GuardDutyDetector" `
    -or $resourceDrifts[0].StackResourceDriftStatus -ne "MODIFIED") {
    throw "Production foundation has unreviewed resource drift."
  }
  $allowedServiceResults = @("AI_ANALYST", "AI_PROTECTION", "EKS_RUNTIME_MONITORING")
  $actualServiceResults = @()
  foreach ($difference in $resourceDrifts[0].PropertyDifferences) {
    $actual = $difference.ActualValue | ConvertFrom-Json
    if ($difference.DifferenceType -ne "ADD" -or $difference.ExpectedValue -ne "null" `
      -or $actual.Status -ne "DISABLED" -or $allowedServiceResults -notcontains $actual.Name) {
      throw "Production foundation has unreviewed GuardDuty drift."
    }
    $actualServiceResults += $actual.Name
  }
  if ((@($actualServiceResults | Sort-Object -Unique) -join ",") `
    -ne (@($allowedServiceResults | Sort-Object) -join ",")) {
    throw "Production foundation GuardDuty drift does not match the reviewed service-returned disabled fields."
  }
  $serviceReportedDisabledFeatures = $actualServiceResults.Count
}

$disabledStack = StackOutputs $DisabledApiStackName
$disabled = $disabledStack.values
if ($disabled.PhiAllowed -ne "false" -or $disabled.ActivationState -ne "blocked" `
  -or $disabled.DataPlaneEnabled -ne "false" -or $disabled.SourceVersion -notmatch "^[0-9a-f]{40}$") {
  throw "Production candidate does not report the reviewed closed posture and exact source."
}

$routes = @(aws apigatewayv2 get-routes --profile $AwsProfile --region $Region `
  --api-id $foundation.ClinicalApiId --query "Items" --output json | ConvertFrom-Json) |
  Where-Object { $_.RouteKey -match "^(GET|POST) /clinical-core/" }
if ($routes.Count -ne 21 -or @($routes | Where-Object AuthorizationType -ne "JWT").Count -ne 0 `
  -or @($routes | Where-Object RouteKey -match "ANY|\{proxy\+\}").Count -ne 0) {
  throw "Production candidate must expose exactly 21 explicit JWT-only clinical routes."
}

$posture = Invoke-RestMethod -Method Get -Uri $foundation.PostureUrl -MaximumRedirection 0
if ($posture.phiAllowed -ne $false -or $posture.environment -ne "production-clinical") {
  throw "Public production posture is not fail-closed."
}

$unauthorized = Invoke-WebRequest -Method Get `
  -Uri "$($foundation.ApiOrigin)/clinical-core/workforce/posture" `
  -MaximumRedirection 0 -SkipHttpErrorCheck
if ([int]$unauthorized.StatusCode -ne 401) { throw "Unauthenticated clinical request was not refused." }

$functionName = $disabled.FunctionName
$configuration = aws lambda get-function-configuration --profile $AwsProfile --region $Region `
  --function-name $functionName --output json | ConvertFrom-Json
if ($configuration.Environment.Variables.PHI_ALLOWED -ne "false" `
  -or $configuration.Environment.Variables.ACTIVATION_STATE -ne "blocked" `
  -or $configuration.Environment.Variables.SOURCE_VERSION -ne $disabled.SourceVersion) {
  throw "Deployed disabled Lambda is not activation-blocked."
}

$invokePath = Join-Path ([IO.Path]::GetTempPath()) ("production-boundary-invoke-" + [guid]::NewGuid().ToString("N") + ".json")
try {
  aws lambda invoke --profile $AwsProfile --region $Region --function-name $functionName `
    --cli-binary-format raw-in-base64-out --payload "{}" $invokePath --output json | Out-Null
  if ($LASTEXITCODE -ne 0) { throw "Disabled Lambda invocation failed." }
  $invoked = Get-Content -Raw -LiteralPath $invokePath | ConvertFrom-Json
  $body = $invoked.body | ConvertFrom-Json
  if ([int]$invoked.statusCode -ne 503 -or $body.error -ne "production_not_activated" `
    -or $body.phiAllowed -ne $false) {
    throw "Disabled Lambda did not return the bounded refusal contract."
  }
} finally {
  Remove-Item -LiteralPath $invokePath -Force -ErrorAction SilentlyContinue
}

$roleName = aws cloudformation describe-stack-resource --profile $AwsProfile --region $Region `
  --stack-name $DisabledApiStackName --logical-resource-id ProductionClinicalApiRole `
  --query "StackResourceDetail.PhysicalResourceId" --output text
$managedPolicies = aws iam list-attached-role-policies --profile $AwsProfile --role-name $roleName `
  --query "AttachedPolicies" --output json | ConvertFrom-Json
$inlineNames = @(aws iam list-role-policies --profile $AwsProfile --role-name $roleName `
  --query "PolicyNames" --output json | ConvertFrom-Json)
if (@($managedPolicies).Count -ne 0 -or $inlineNames.Count -ne 1) {
  throw "Disabled API role has an unexpected policy attachment."
}
$policy = aws iam get-role-policy --profile $AwsProfile --role-name $roleName `
  --policy-name $inlineNames[0] --query "PolicyDocument" --output json | ConvertFrom-Json
$actions = @($policy.Statement | ForEach-Object { $_.Action }) | Sort-Object -Unique
if (($actions -join ",") -ne "logs:CreateLogStream,logs:PutLogEvents") {
  throw "Disabled API role has a non-logging permission."
}

$database = QueryDatabase $foundation @"
select
  (select count(*)::int from clinical_core.schema_migrations) as migration_count,
  (select count(*)::int from information_schema.tables
    where table_schema in ('clinical_core','clinical_private','clinical_audit')
      and table_name <> 'schema_migrations') as table_count,
  (select count(*)::int from clinical_core.organizations) as organization_count,
  (select count(*)::int from clinical_core.persons) as person_count,
  (select count(*)::int from clinical_core.patient_records) as patient_count,
  (select count(*)::int from clinical_core.lab_import_events) as lab_import_count,
  (select count(*)::int from clinical_core.consumer_clinical_record_versions) as clinical_record_count,
  (select count(*)::int from clinical_core.review_queue_items) as review_queue_count,
  (select count(*)::int from clinical_audit.events) as audit_count
"@
$counts = @($database.records[0] | ForEach-Object { [int64]$_.longValue })
if (($counts -join ",") -ne "10,18,0,0,0,0,0,0,0") {
  throw "Production database is not the reviewed empty 10-migration/18-table state: $($counts -join ',')."
}

$alarmName = "$functionName-errors"
$alarm = aws cloudwatch describe-alarms --profile $AwsProfile --region $Region `
  --alarm-names $alarmName --query "MetricAlarms[0]" --output json | ConvertFrom-Json
if (-not $alarm -or $alarm.StateValue -ne "OK") { throw "Disabled API error alarm is not OK." }

$logGroup = "/ai-clinical-core/production-clinical/disabled-api-v1/$($foundation.ClinicalApiId)"
$startTime = [DateTimeOffset]::UtcNow.AddMinutes(-15).ToUnixTimeMilliseconds()
$messages = @(aws logs filter-log-events --profile $AwsProfile --region $Region `
  --log-group-name $logGroup --start-time $startTime --query "events[].message" --output json | ConvertFrom-Json)
$unsafeLog = $messages | Where-Object { $_ -match "(?i)authorization|bearer|token|patient|biomarker|laboratory|@" }
if ($unsafeLog) { throw "Potential sensitive content appeared in the disabled API logs." }

$evidence = [ordered]@{
  contractVersion = "production-closed-boundary-exercise/2"
  observedAt = [DateTimeOffset]::UtcNow.ToString("o")
  account = $account
  region = $Region
  phiAllowed = $false
  activationState = "blocked"
  dataPlaneEnabled = $false
  sourceVersion = $disabled.SourceVersion
  productionBoundIdentityPools = $productionBoundPools
  guardDutyManagedFeaturesEnabled = $requiredGuardDutyFeatures.Count
  serviceReportedDisabledGuardDutyFeatures = $serviceReportedDisabledFeatures
  unreviewedFoundationDrift = 0
  foundationStackStatus = $foundationStack.status
  disabledApiStackStatus = $disabledStack.status
  clinicalRouteCount = $routes.Count
  allClinicalRoutesJwt = $true
  unauthenticatedHttpStatus = 401
  authenticatedFunctionStatus = 503
  functionCodeSha256 = $configuration.CodeSha256
  functionPermissions = $actions
  migrationCount = $counts[0]
  tableCount = $counts[1]
  clinicalRowCount = ($counts[2..8] | Measure-Object -Sum).Sum
  alarmState = $alarm.StateValue
  unsafeLogMatches = 0
}
$canonical = $evidence | ConvertTo-Json -Depth 8 -Compress
$hash = [Convert]::ToHexString([Security.Cryptography.SHA256]::HashData(
  [Text.Encoding]::UTF8.GetBytes($canonical))).ToLowerInvariant()

if ($OutputPath) {
  $resolvedParent = Split-Path -Parent $OutputPath
  if (-not $resolvedParent -or -not (Test-Path -LiteralPath $resolvedParent -PathType Container)) {
    throw "OutputPath parent must already exist."
  }
  $outputRecord = [ordered]@{}
  foreach ($key in $evidence.Keys) { $outputRecord[$key] = $evidence[$key] }
  $outputRecord["evidenceSha256"] = $hash
  [IO.File]::WriteAllText($OutputPath, ($outputRecord | ConvertTo-Json -Depth 8), `
    (New-Object Text.UTF8Encoding($false)))
}

Write-Host "Production closed-boundary exercise passed. Evidence SHA-256: $hash"
