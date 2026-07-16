import Link from "next/link";
import { CircleHelp } from "lucide-react";
import { DEFAULT_PATIENT_ID } from "@/adapters";
import { USE_LIVE_API } from "@/adapters/mode";
import { patientPath } from "@/lib/routes";

export default function NotFound() {
  return (
    <section className="relative flex flex-col items-center gap-[10px] px-6 py-[120px]">
      <span className="flex h-12 w-12 items-center justify-center rounded-[14px] bg-[rgba(37,99,199,0.08)]">
        <CircleHelp size={22} strokeWidth={1.75} className="text-action" aria-hidden />
      </span>
      <h1 className="m-0 text-[16px] font-bold">Page not found</h1>
      <p className="m-0 max-w-[420px] text-center text-[13px] leading-normal text-subtle">
        The page you are looking for doesn’t exist or the record isn’t
        available in this build.
      </p>
      <Link
        href={USE_LIVE_API ? "/clients" : patientPath(DEFAULT_PATIENT_ID)}
        className="mt-[6px] flex h-8 items-center rounded-lg border border-line-btn bg-card px-[14px] text-[12.5px] font-semibold text-action hover:border-line-hover-2 focus-visible:outline-2 focus-visible:outline-action"
      >
        Back to Overview
      </Link>
    </section>
  );
}
