if (typeof window !== "undefined") throw new Error("aws-lab-analysis-lambda is server-only");
import { createAwsLabAnalysisApiHandler } from "./aws-lab-analysis-api";
export const handler = createAwsLabAnalysisApiHandler;
