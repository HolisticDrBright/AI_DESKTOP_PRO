param(
  [string]$FoundationStackName = "ai-clinical-core-synthetic-staging",
  [string]$ExtensionStackName = "ai-clinical-core-synthetic-staging-consumer-account",
  [string]$Region = "us-east-2",
  [switch]$ConfirmSyntheticOnly
)
$ErrorActionPreference = "Stop"
if (-not $ConfirmSyntheticOnly) { throw "Refusing deployment without explicit synthetic-only confirmation." }
$root = Split-Path -Parent $PSScriptRoot; Set-Location $root
$outputs = aws cloudformation describe-stacks --region $Region --stack-name $FoundationStackName --query "Stacks[0].Outputs" --output json | ConvertFrom-Json
function Output([string]$key) { $item=$outputs|Where-Object OutputKey -eq $key; if(-not $item){throw "Missing foundation output $key"}; $item.OutputValue }
if ((Output "PhiAllowed") -ne "false" -or (Output "Environment") -ne "synthetic-staging") { throw "Foundation is not synthetic-only." }

npm run build:aws-consumer-account
if ($LASTEXITCODE -ne 0) { throw "Consumer account build failed." }
$zip = Join-Path $root "dist\aws-clinical-core\consumer-account.zip"
Compress-Archive -Path "dist\aws-clinical-core\consumer-account\*" -DestinationPath $zip -Force
$hash=(Get-FileHash -Algorithm SHA256 -LiteralPath $zip).Hash.ToLowerInvariant()
$bucket=(aws cloudformation describe-stack-resource --region $Region --stack-name $FoundationStackName --logical-resource-id ClinicalDocumentsBucket --query "StackResourceDetail.PhysicalResourceId" --output text)
$key="clinical-core/consumer-account/$hash.zip"
$kmsKey=Output "ClinicalCoreKeyArn"
aws s3 cp $zip "s3://$bucket/$key" --region $Region --only-show-errors --sse aws:kms --sse-kms-key-id $kmsKey
if ($LASTEXITCODE -ne 0) { throw "Consumer account artifact upload failed." }
aws cloudformation deploy --region $Region --stack-name $ExtensionStackName --template-file infra/aws-clinical-core/consumer-account-extension.json --capabilities CAPABILITY_NAMED_IAM --no-fail-on-empty-changeset --parameter-overrides `
  EnvironmentName=synthetic-staging Boundary=synthetic ClinicalApiId=$(Output "ClinicalApiId") ConsumerUserPoolId=$(Output "ConsumerUserPoolId") ConsumerUserPoolClientId=$(Output "ConsumerUserPoolClientId") `
  DatabaseClusterArn=$(Output "DatabaseClusterArn") DatabaseSecretArn=$(Output "DatabaseSecretArn") DatabaseName=$(Output "DatabaseName") ClinicalCoreKeyArn=$(Output "ClinicalCoreKeyArn") LambdaCodeBucket=$bucket LambdaCodeKey=$key
if ($LASTEXITCODE -ne 0) { throw "Consumer account stack deployment failed." }
Write-Host "Synthetic consumer account API deployed with PHI disabled. Artifact SHA-256: $hash"
