param(
  [string]$FoundationStackName = "ai-clinical-core-synthetic-staging",
  [string]$StackName = "ai-clinical-core-synthetic-staging-lab-analysis",
  [string]$ArtifactBucket = "ai-clinical-core-synthetic-clinicaldocumentsbucket-1wv5abdrcnn7",
  [string]$Region = "us-east-2",
  [string]$Profile = "ai-synthetic-member",
  [string]$SyntheticAllowedSubjects = "c1a00000-0000-4000-8000-000000000001,c1a00000-0000-4000-8000-000000000002,c1a00000-0000-4000-8000-000000000009",
  [switch]$ConfirmSyntheticOnly
)

$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
Set-Location $root
if (-not $ConfirmSyntheticOnly) { throw "Refusing deployment: explicitly confirm synthetic-only use." }

$outputs = aws cloudformation describe-stacks --stack-name $FoundationStackName --region $Region --profile $Profile --query "Stacks[0].Outputs" --output json | ConvertFrom-Json
if ($LASTEXITCODE -ne 0) { throw "Foundation lookup failed." }
function Output([string]$key) { $entry = $outputs | Where-Object OutputKey -eq $key; if (-not $entry) { throw "Missing output $key." }; return $entry.OutputValue }
if ((Output "PhiAllowed") -ne "false" -or (Output "DataClassification") -ne "synthetic_only" -or (Output "Environment") -ne "synthetic-staging") { throw "Foundation is not synthetic-only." }

npm run typecheck
npm run build:aws-lab-analysis

$apiZip = Join-Path $root "dist\aws-clinical-core\lab-api.zip"
$workerZip = Join-Path $root "dist\aws-clinical-core\lab-worker.zip"
foreach ($path in @($apiZip, $workerZip)) { Remove-Item -LiteralPath $path -Force -ErrorAction SilentlyContinue }
Compress-Archive -Path (Join-Path $root "dist\aws-clinical-core\lab-analysis\api\index.js") -DestinationPath $apiZip
Compress-Archive -Path (Join-Path $root "dist\aws-clinical-core\lab-analysis\worker\index.js") -DestinationPath $workerZip
$apiDigest = (Get-FileHash -Algorithm SHA256 -LiteralPath $apiZip).Hash.ToLowerInvariant()
$workerDigest = (Get-FileHash -Algorithm SHA256 -LiteralPath $workerZip).Hash.ToLowerInvariant()
$apiKey = "clinical-core/lab-analysis/api-$apiDigest.zip"
$workerKey = "clinical-core/lab-analysis/worker-$workerDigest.zip"
$kmsKey = Output "ClinicalCoreKeyArn"
$openAiSecretArn = aws secretsmanager describe-secret --secret-id "ai-longevity-pro/synthetic-staging/openai" --profile $Profile --region $Region --query ARN --output text
if ($LASTEXITCODE -ne 0 -or -not $openAiSecretArn -or $openAiSecretArn -eq "None") { throw "OpenAI secret lookup failed." }
aws s3 cp $apiZip "s3://$ArtifactBucket/$apiKey" --profile $Profile --region $Region --only-show-errors --sse aws:kms --sse-kms-key-id $kmsKey
if ($LASTEXITCODE -ne 0) { throw "API artifact upload failed." }
aws s3 cp $workerZip "s3://$ArtifactBucket/$workerKey" --profile $Profile --region $Region --only-show-errors --sse aws:kms --sse-kms-key-id $kmsKey
if ($LASTEXITCODE -ne 0) { throw "Worker artifact upload failed." }

aws cloudformation deploy --stack-name $StackName --template-file "infra/aws-clinical-core/lab-analysis-extension.json" --region $Region --profile $Profile --capabilities CAPABILITY_IAM --no-fail-on-empty-changeset --parameter-overrides `
  "ClinicalApiId=$(Output 'ClinicalApiId')" `
  "ConsumerUserPoolId=$(Output 'ConsumerUserPoolId')" `
  "ConsumerUserPoolClientId=$(Output 'ConsumerUserPoolClientId')" `
  "SyntheticSupabaseIssuer=https://urcjiehlxoehievobezf.supabase.co/auth/v1" `
  "SyntheticSupabaseAudience=authenticated" `
  "SyntheticEmailDomain=@brightlongevity.test" `
  "SyntheticOrganizationId=11111111-1111-4111-8111-111111111111" `
  "SyntheticAllowedSubjects=$SyntheticAllowedSubjects" `
  "ClinicalCoreKeyArn=$kmsKey" `
  "LambdaCodeBucket=$ArtifactBucket" `
  "ApiCodeKey=$apiKey" `
  "WorkerCodeKey=$workerKey" `
  "OpenAISecretArn=$openAiSecretArn" `
  "OpenAIModel=gpt-5.1-2025-11-13"
if ($LASTEXITCODE -ne 0) { throw "Lab analysis stack deployment failed." }

Write-Host "Synthetic AWS lab analysis deployed. No credential or document content was printed."
