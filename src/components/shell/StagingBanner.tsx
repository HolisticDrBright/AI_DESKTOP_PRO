/**
 * Persistent staging indicator (server component — reads server env only).
 *
 * The Supabase project `urcjiehlxoehievobezf` is the PERMANENT STAGING
 * project: synthetic users and seed data only, never real patient care.
 * Whenever the desktop is connected to a staging project, this banner is
 * pinned above the shell on every page — words, not color alone. A future
 * production deployment uses a different Supabase project and never
 * matches this list.
 */
const STAGING_PROJECT_REFS = ["urcjiehlxoehievobezf"];

export function StagingBanner() {
  const url = process.env.CLINICAL_SUPABASE_URL ?? "";
  const isStaging = STAGING_PROJECT_REFS.some((ref) => url.includes(ref));
  if (!isStaging) return null;
  return (
    <div
      role="status"
      data-testid="staging-banner"
      className="sticky top-0 z-[200] border-b border-line bg-panel px-3 py-[5px] text-center text-[11.5px] font-bold tracking-[0.04em] text-body uppercase"
    >
      Staging environment — synthetic data only. Not for real patient care.
    </div>
  );
}
