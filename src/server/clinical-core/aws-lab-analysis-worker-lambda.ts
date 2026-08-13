if (typeof window !== "undefined") throw new Error("aws-lab-analysis-worker-lambda is server-only");
import { createAwsLabAnalysisWorker } from "./aws-lab-analysis-worker";
export const handler = createAwsLabAnalysisWorker;
