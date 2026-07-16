import { AlertTriangle, Inbox, Loader2 } from "lucide-react";
import { Card } from "@/components/ui/bits";

/**
 * Shared clinical-safe async states. Used wherever a screen loads through the
 * adapter façade so loading / empty / error look and behave consistently, and
 * so an error NEVER shows a raw exception, stack, backend payload, or PHI —
 * only a clinician-safe message plus a retry.
 */

export function ClinicalLoading({ label = "Loading…" }: { label?: string }) {
  return (
    <Card className="px-6 py-[56px]">
      <div
        className="flex flex-col items-center gap-[10px] text-center"
        role="status"
        aria-live="polite"
      >
        <Loader2 size={22} strokeWidth={2} className="animate-spin text-brand" aria-hidden />
        <p className="m-0 text-[12.5px] text-subtle">{label}</p>
      </div>
    </Card>
  );
}

export function ClinicalEmpty({
  title,
  message,
  icon,
}: {
  title: string;
  message: string;
  icon?: React.ReactNode;
}) {
  return (
    <Card className="px-6 py-[56px]">
      <div className="flex flex-col items-center gap-[10px] text-center">
        <span className="flex h-11 w-11 items-center justify-center rounded-[13px] bg-slate-tint">
          {icon ?? <Inbox size={20} strokeWidth={1.75} className="text-slate-badge" aria-hidden />}
        </span>
        <h2 className="m-0 text-[15px] font-bold">{title}</h2>
        <p className="m-0 max-w-[420px] text-[12.5px] leading-[1.5] text-subtle">{message}</p>
      </div>
    </Card>
  );
}

export function ClinicalError({
  message,
  onRetry,
  actionHref,
  actionLabel,
}: {
  message: string;
  onRetry?: () => void;
  /** Optional primary action (e.g. "/login" when the session is missing/expired). */
  actionHref?: string;
  actionLabel?: string;
}) {
  return (
    <Card className="px-6 py-[56px]">
      <div className="flex flex-col items-center gap-[10px] text-center" role="alert">
        <span className="flex h-11 w-11 items-center justify-center rounded-[13px] bg-warning-tint">
          <AlertTriangle size={20} strokeWidth={1.9} className="text-warning-deep" aria-hidden />
        </span>
        <h2 className="m-0 text-[15px] font-bold">This didn&apos;t load</h2>
        <p className="m-0 max-w-[440px] text-[12.5px] leading-[1.5] text-subtle">{message}</p>
        <div className="mt-[2px] flex items-center gap-2">
          {actionHref && actionLabel && (
            <a
              href={actionHref}
              className="flex h-8 items-center rounded-lg border-none bg-action px-4 text-[12.5px] font-semibold text-white hover:bg-action-deep focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ink"
            >
              {actionLabel}
            </a>
          )}
          {onRetry && (
            <button
              onClick={onRetry}
              className="h-8 cursor-pointer rounded-lg border border-line bg-card px-4 text-[12.5px] font-semibold text-body hover:border-line-hover focus-visible:outline-2 focus-visible:outline-action"
            >
              Try again
            </button>
          )}
        </div>
      </div>
    </Card>
  );
}
