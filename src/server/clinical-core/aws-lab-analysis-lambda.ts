if (typeof window !== "undefined") throw new Error("aws-lab-analysis-lambda is server-only");
import { createAwsLabAnalysisApiHandler } from "./aws-lab-analysis-api";
import { syntheticSupabaseAuthorizer } from "./aws-synthetic-supabase-authorizer";
export const handler = createAwsLabAnalysisApiHandler;
export const authorizer = syntheticSupabaseAuthorizer;
