param(
  [string]$FoundationStackName = "ai-clinical-core-synthetic-staging",
  [string]$StackName = "ai-clinical-core-synthetic-staging-patient-sync",
  [string]$ArtifactBucket = "ai-clinical-core-synthetic-clinicaldocumentsbucket-1wv5abdrcnn7",
  [string]$Region = "us-east-2",
  [string]$Profile = "ai-synthetic-member",
  [string]$SupabaseProjectRef = "urcjiehlxoehievobezf",
  [string]$OrganizationId = "a0000000-0000-4000-8000-000000000001",
  [string]$V2BaseUrl = "https://expo-sunlit-resonance-4543.fly.dev",
  [switch]$ConfirmSyntheticOnly
)

$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
Set-Location $root
if (-not $ConfirmSyntheticOnly) { throw "Refusing deployment: explicitly confirm synthetic-only use." }

$outputs = aws cloudformation describe-stacks --stack-name $FoundationStackName --region $Region --profile $Profile --query "Stacks[0].Outputs" --output json | ConvertFrom-Json
if ($LASTEXITCODE -ne 0) { throw "Foundation lookup failed." }
function Output([string]$key) { $entry = $outputs | Where-Object OutputKey -eq $key; if (-not $entry) { throw "Missing output $key." }; return $entry.OutputValue }
if ((Output "PhiAllowed") -ne "false" -or (Output "DataClassification") -ne "synthetic_only") { throw "Foundation is not synthetic-only." }

npm run typecheck
npm run build:aws-sync-bridge

$zip = Join-Path $root "dist\aws-clinical-core\patient-sync-bridge.zip"
Remove-Item -LiteralPath $zip -Force -ErrorAction SilentlyContinue
Compress-Archive -Path (Join-Path $root "dist\aws-clinical-core\sync-bridge\index.js") -DestinationPath $zip
$digest = (Get-FileHash -Algorithm SHA256 -LiteralPath $zip).Hash.ToLowerInvariant()
$codeKey = "clinical-core/patient-sync/bridge-$digest.zip"
$kmsKey = Output "ClinicalCoreKeyArn"
aws s3 cp $zip "s3://$ArtifactBucket/$codeKey" --profile $Profile --region $Region --only-show-errors --sse aws:kms --sse-kms-key-id $kmsKey
if ($LASTEXITCODE -ne 0) { throw "Sync bridge artifact upload failed." }

# Preserve the currently active signing material before CloudFormation runs.
# The template carries only an unconfigured placeholder; credential values are
# never CloudFormation parameters, outputs, command text, or logs.
$preservedSecret = $null
try {
  $raw = aws secretsmanager get-secret-value --secret-id "ai-clinical-core/synthetic-staging/patient-sync" --profile $Profile --region $Region --query SecretString --output text
  if ($LASTEXITCODE -eq 0 -and $raw) { $preservedSecret = $raw | ConvertFrom-Json }
} catch { $preservedSecret = $null }

aws cloudformation deploy --stack-name $StackName --template-file "infra/aws-clinical-core/sync-bridge-extension.json" --region $Region --profile $Profile --capabilities CAPABILITY_IAM --no-fail-on-empty-changeset --parameter-overrides `
  "ClinicalApiId=$(Output 'ClinicalApiId')" `
  "ClinicalCoreKeyArn=$kmsKey" `
  "LambdaCodeBucket=$ArtifactBucket" `
  "LambdaCodeKey=$codeKey" `
  "SupabaseUrl=https://$SupabaseProjectRef.supabase.co" `
  "OrganizationId=$OrganizationId" `
  "V2BaseUrl=$V2BaseUrl"
if ($LASTEXITCODE -ne 0) { throw "Patient sync stack deployment failed." }

$stackOutputs = aws cloudformation describe-stacks --stack-name $StackName --region $Region --profile $Profile --query "Stacks[0].Outputs" --output json | ConvertFrom-Json
function StackOutput([string]$key) { $entry = $stackOutputs | Where-Object OutputKey -eq $key; if (-not $entry) { throw "Missing stack output $key." }; return $entry.OutputValue }
$secretArn = StackOutput "SyncBridgeSecretArn"
$callbackBaseUrl = StackOutput "CallbackBaseUrl"

$existing = $preservedSecret
if (-not $existing) {
  try {
    $raw = aws secretsmanager get-secret-value --secret-id $secretArn --profile $Profile --region $Region --query SecretString --output text
    if ($LASTEXITCODE -eq 0 -and $raw) { $existing = $raw | ConvertFrom-Json }
  } catch { $existing = $null }
}

function NewSecretValue {
  $bytes = New-Object byte[] 48
  [System.Security.Cryptography.RandomNumberGenerator]::Fill($bytes)
  return [Convert]::ToBase64String($bytes)
}
$desktopToV2 = if ($existing -and $existing.desktopToV2Secret) { $existing.desktopToV2Secret } else { NewSecretValue }
$v2ToDesktop = if ($existing -and $existing.v2ToDesktopSecret) { $existing.v2ToDesktopSecret } else { NewSecretValue }

$keys = supabase projects api-keys --project-ref $SupabaseProjectRef --reveal --output json | ConvertFrom-Json
$serviceRole = ($keys | Where-Object { $_.name -eq "service_role" -or $_.type -eq "service_role" } | Select-Object -First 1).api_key
if (-not $serviceRole) { $serviceRole = ($keys | Where-Object { $_.secret -eq $true } | Select-Object -First 1).api_key }
if (-not $serviceRole) { throw "Supabase service-role lookup failed." }

$secretPayload = @{
  configured = $true
  supabaseServiceRoleKey = $serviceRole
  desktopToV2Secret = $desktopToV2
  v2ToDesktopSecret = $v2ToDesktop
} | ConvertTo-Json -Compress
aws secretsmanager put-secret-value --secret-id $secretArn --secret-string $secretPayload --profile $Profile --region $Region | Out-Null
if ($LASTEXITCODE -ne 0) { throw "Sync bridge secret update failed." }

Write-Host "Synthetic AWS patient-sync bridge deployed."
Write-Host "CallbackBaseUrl=$callbackBaseUrl"
Write-Host "No credential value was printed."
