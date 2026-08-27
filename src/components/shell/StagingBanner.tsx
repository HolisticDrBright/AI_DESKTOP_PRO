/**
 * Persistent staging indicator (server component — reads server env only).
 *
 * Uses server-owned AWS runtime posture, never a client-visible data URL.
 * Synthetic/staging environments always show the synthetic warning. A
 * production-readiness deployment with PHI disabled shows a separate refusal
 * message so operators cannot mistake infrastructure testing for patient use.
 */
export function StagingBanner() {
  const runtime = String(process.env.APP_RUNTIME_ENV ?? "").toLowerCase();
  const environment = String(process.env.CLINICAL_AWS_ENVIRONMENT ?? "").toLowerCase();
  const isSynthetic = runtime.includes("staging") || environment.includes("synthetic");
  const isPhiBlockedProduction = runtime === "production-clinical" && process.env.PHI_ALLOWED !== "true";
  if (!isSynthetic && !isPhiBlockedProduction) return null;
  return (
    <div
      role="status"
      data-testid="staging-banner"
      className="sticky top-0 z-[200] border-b border-line bg-panel px-3 py-[5px] text-center text-[11.5px] font-bold tracking-[0.04em] text-body uppercase"
    >
      {isSynthetic
        ? "Staging environment — synthetic data only. Not for real patient care."
        : "Production readiness environment — PHI is disabled. Not for real patient care."}
    </div>
  );
}
