"use client";

import { ClinicalError } from "@/components/ui/ClinicalStates";

/**
 * Patient-chart error boundary. Catches failures thrown while loading a
 * patient (e.g. the live backend being unavailable or the session expiring)
 * and renders a clinician-safe, retryable state — never a raw exception,
 * stack, or a misleading "not found". `reset` re-attempts the render.
 */
export default function PatientChartError({
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
