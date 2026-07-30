import type { Metadata } from "next";
import Link from "next/link";
import { PageHeader } from "@/components/ui/PageHeader";
import { Metric } from "@/components/ui/Metric";
import { ClinicalNote } from "@/components/ui/ClinicalStates";

export const metadata: Metadata = { title: "Today — AI Longevity Pro" };

// "Today" is request-time state — never prerender it at build time.
export const dynamic = "force-dynamic";

function dateLine(): string {
  return new Intl.DateTimeFormat("en-US", {
    weekday: "long",
    month: "long",
    day: "numeric",
    year: "numeric",
  }).format(new Date());
}

/**
 * The daily entry point offers the real, org-scoped surfaces directly. The
 * aggregated daily brief (arrivals, messages, approvals, wearable alerts)
 * needs live backends for those domains first — until then this page links to
 * what IS real and says so, rather than fabricating a morning summary.
 */
export default function TodayPage() {
  return (
    <section data-screen-label="Today" className="mx-auto max-w-[1100px] px-[22px] pt-[18px] pb-6">
      <PageHeader crumb="Workspace / Today" title="Today" sub={dateLine()} />
      <div className="mb-4 grid grid-cols-1 gap-3 lg:grid-cols-3">
        <Metric label="Schedule" value="Calendar" sub="Live appointments (RLS-scoped)" href="/calendar" />
        <Metric label="Review queue" value="Tasks" sub="Live review_queue_items" href="/tasks" />
        <Metric label="Patients" value="Directory" sub="Live patient_profiles" href="/patients" />
      </div>
      <ClinicalNote>
        The aggregated daily brief (arrivals, unread messages, approvals, wearable alerts) is not
        configured yet — those domains have no live backend. This page shows real surfaces only.{" "}
        <Link href="/calendar" className="font-semibold text-action">
          Open the live calendar
        </Link>
        .
      </ClinicalNote>
    </section>
  );
}
