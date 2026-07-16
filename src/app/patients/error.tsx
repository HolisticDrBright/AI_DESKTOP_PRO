"use client";

import { ClinicalError } from "@/components/ui/ClinicalStates";

/**
 * Error boundary for the patients area. Catches failures thrown while loading a
 * patient — including in `[patientId]/layout.tsx` (e.g. the live backend being
 * unavailable or the session expiring) — and renders a clinician-safe,
 * retryable state. A same-segment error.tsx cannot catch its own layout's
 * throw, so this boundary lives one level up. `reset` re-attempts the render.
 */
export default function PatientsError({
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <section className="relative mx-auto max-w-[1560px] px-[22px] pt-[40px] pb-5">
      <ClinicalError
        message="We couldn't load this patient's chart right now. The clinical service may be temporarily unavailable — please try again."
        onRetry={reset}
      />
    </section>
  );
}
