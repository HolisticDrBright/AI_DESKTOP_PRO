if (typeof window !== "undefined") throw new Error("aws-ask-alp-lambda is server-only");
import { createAwsAskAlpApiHandler } from "./aws-ask-alp-api";

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error("ask_alp_configuration_missing");
  return value;
}

export const handler = createAwsAskAlpApiHandler({ configuration: {
  consumerIssuer: required("CLINICAL_CONSUMER_ISSUER"), consumerAudience: required("CLINICAL_CONSUMER_AUDIENCE"),
  runtimeMode: required("RUNTIME_MODE") === "production" ? "production" : "synthetic", phiAllowed: required("PHI_ALLOWED") === "true",
  model: required("ASK_ALP_OPENAI_MODEL"), openAiSecretArn: required("ASK_ALP_OPENAI_SECRET_ARN"),
  approvedPromptSha256: required("ASK_ALP_APPROVED_PROMPT_SHA256"),
} });
