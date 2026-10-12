if (typeof window !== "undefined") throw new Error("aws-ask-alp-lambda is server-only");
import { createAwsAskAlpApiHandler, parseAskAlpRuntimeMode } from "./aws-ask-alp-api";
import { createOwnedAskAlpContextLoader } from "./aws-ask-alp-trusted-context";
import { createProductionAskAlpCallerVerifier } from "./aws-ask-alp-private-caller";
import { createOwnedConsumerRecordsAdapter, type OwnedStorageScope } from "./owned-consumer-records";
import { createRdsDataClinicalCoreDatabase } from "./rds-data-database";
import { loadReviewedKnowledge } from "./aws-reviewed-knowledge";

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error("ask_alp_configuration_missing");
  return value;
}

const runtimeMode = parseAskAlpRuntimeMode(required("RUNTIME_MODE"));
const phiSetting = required("PHI_ALLOWED");
if (phiSetting !== "true" && phiSetting !== "false") throw new Error("ask_alp_configuration_invalid");
const phiAllowed = phiSetting === "true";
const productionActivation = runtimeMode === "production" && phiAllowed
  ? (() => {
    if (required("ASK_ALP_PRODUCTION_ACTIVATION") !== "approved") throw new Error("ask_alp_configuration_invalid");
    return { status: "approved" as const, evidenceSha256: required("ASK_ALP_PRODUCTION_EVIDENCE_SHA256") };
  })()
  : undefined;
const trustedContextLoader = runtimeMode === "production" && phiAllowed
  ? createOwnedAskAlpContextLoader({
    adapter: () => createOwnedConsumerRecordsAdapter(createRdsDataClinicalCoreDatabase({
      clusterArn: required("CLINICAL_DATABASE_CLUSTER_ARN"), secretArn: required("CLINICAL_DATABASE_SECRET_ARN"),
      databaseName: required("CLINICAL_DATABASE_NAME"), region: required("AWS_REGION"),
    })),
    allowedScopes: required("ASK_ALP_ALLOWED_SCOPES").split(",") as OwnedStorageScope[],
    knowledgeLoader: loadReviewedKnowledge,
  })
  : undefined;
const trustedCallerVerifier = runtimeMode === "production" && phiAllowed
  ? createProductionAskAlpCallerVerifier({
    apiId: required("ASK_ALP_API_ID"), accountId: required("ASK_ALP_ACCOUNT_ID"),
    backendRoleArn: required("ASK_ALP_BACKEND_ROLE_ARN"),
    consumerIssuer: required("CLINICAL_CONSUMER_ISSUER"), consumerAudience: required("CLINICAL_CONSUMER_AUDIENCE"),
  })
  : undefined;

export const handler = createAwsAskAlpApiHandler({ configuration: {
  consumerIssuer: required("CLINICAL_CONSUMER_ISSUER"), consumerAudience: required("CLINICAL_CONSUMER_AUDIENCE"),
  runtimeMode, phiAllowed, ...(productionActivation ? { productionActivation } : {}),
  model: required("ASK_ALP_OPENAI_MODEL"), openAiSecretArn: required("ASK_ALP_OPENAI_SECRET_ARN"),
  approvedPromptSha256: required("ASK_ALP_APPROVED_PROMPT_SHA256"),
}, ...(trustedContextLoader ? { trustedContextLoader } : {}),
  ...(trustedCallerVerifier ? { trustedCallerVerifier } : {}) });
