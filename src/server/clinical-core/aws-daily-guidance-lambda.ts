if (typeof window !== "undefined") throw new Error("aws-daily-guidance-lambda is server-only");
import { createAwsDailyGuidanceApiHandler } from "./aws-daily-guidance-api";

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error("daily_guidance_configuration_missing");
  return value;
}

export const handler = createAwsDailyGuidanceApiHandler({
  configuration: {
    consumerIssuer: required("CLINICAL_CONSUMER_ISSUER"),
    consumerAudience: required("CLINICAL_CONSUMER_AUDIENCE"),
    runtimeMode: required("RUNTIME_MODE") === "production" ? "production" : "synthetic",
    phiAllowed: required("PHI_ALLOWED") === "true",
    model: required("DAILY_GUIDANCE_OPENAI_MODEL"),
    openAiSecretArn: required("DAILY_GUIDANCE_OPENAI_SECRET_ARN"),
  },
});
