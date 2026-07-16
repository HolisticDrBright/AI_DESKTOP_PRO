import Link from "next/link";
import { PanelsTopLeft } from "lucide-react";
import { DEFAULT_PATIENT_ID } from "@/adapters";
import { USE_LIVE_API } from "@/adapters/mode";
import { patientPath } from "@/lib/routes";

/** Designed full-screen placeholder for sections queued in later phases. */
export function PlaceholderScreen({ label }: { label: string }) {
  return (
    <section
      data-screen-label="Placeholder"
      className="relative flex flex-col items-center gap-[10px] px-6 py-[120px]"
    >
      <span className="flex h-12 w-12 items-center justify-center rounded-[14px] bg-[rgba(37,99,199,0.08)]">
        <PanelsTopLeft size={22} strokeWidth={1.75} className="text-action" aria-hidden />
      </span>
      <h1 className="m-0 text-[16px] font-bold">{label} — queued for the next phase</h1>
      <p className="m-0 max-w-[420px] text-center text-[13px] leading-normal text-subtle">
        The Overview and the practice dashboard are live. This screen is on the
        build list and will follow the same shell and design language.
      </p>
      <Link
        href={USE_LIVE_API ? "/clients" : patientPath(DEFAULT_PATIENT_ID)}
        className="mt-[6px] flex h-8 items-center rounded-lg border border-line-btn bg-card px-[14px] text-[12.5px] font-semibold text-action hover:border-line-hover-2 focus-visible:outline-2 focus-visible:outline-action"
      >
        {USE_LIVE_API ? "Back to directory" : "Back to Overview"}
      </Link>
    </section>
  );
}
