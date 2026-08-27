if (typeof window !== "undefined") {
  throw new Error("This module is server-only and must not run in the browser.");
}

/**
 * Server-side view of live data-source configuration — PRESENCE ONLY.
 *
 * Reports whether each server-only env var is set, never its value, so the
 * Settings status panel can show "configured / not configured" without any
 * secret ever reaching the client bundle.
 */
export interface LiveServerStatus {
  clinicalAwsConfigured: boolean;
  transitionTrpcConfigured: boolean;
  localFixtureSessionConfigured: boolean;
  orgConfigured: boolean;
}

export function getLiveServerStatus(): LiveServerStatus {
  return {
    clinicalAwsConfigured: Boolean(
      process.env.CLINICAL_AWS_REGION &&
        process.env.CLINICAL_AWS_API_ORIGIN &&
        process.env.CLINICAL_AWS_WORKFORCE_USER_POOL_ID &&
        process.env.CLINICAL_AWS_WORKFORCE_CLIENT_ID &&
        process.env.AWS_CLINICAL_ADAPTER_READY === "true",
    ),
    transitionTrpcConfigured: Boolean(process.env.TRPC_BASE_URL),
    localFixtureSessionConfigured: Boolean(
      process.env.CLINICAL_CONTRACT_FIXTURE === "1" &&
        process.env.CLINICAL_DEMO_EMAIL &&
        process.env.CLINICAL_DEMO_PASSWORD,
    ),
    orgConfigured: Boolean(process.env.CLINICAL_ORG_ID || process.env.NEXT_PUBLIC_DEV_ORG_ID),
  };
}
