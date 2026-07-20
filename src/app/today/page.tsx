import type { Metadata } from "next";
import Link from "next/link";
import { USE_LIVE_API } from "@/adapters/mode";
import { effectiveWeekday } from "@/adapters/today-shared";
import { TodayWorkspace } from "@/components/today/TodayWorkspace";
import { PageHeader } from "@/components/ui/PageHeader";
import { Metric } from "@/components/ui/Metric";
import { DemoNote } from "@/components/ui/DemoNote";

export const metadata: Metadata = { title: "Today — AI Longevity Pro" };

// "Today" is request-time state — never prerender it at build time (a baked
// weekday/date would mismatch hydration the next day).
export const dynamic = "force-dynamic";

function dateLine(): string {
  return new Intl.DateTimeFormat("en-US", {
    weekday: "long",
    month: "long",
    day: "numeric",
    year: "numeric",
  }).format(new Date());
}

export default function TodayPage() {
  if (USE_LIVE_API) {
    // Live mode: the brief's demo sections would misrepresent the record.
    // Offer the live surfaces directly and say so — no fake aggregation.
    return (
      <section data-screen-label="Today" className="mx-auto max-w-[1100px] px-[22px] pt-[18px] pb-6">
        <PageHeader
          crumb="Workspace / Today"
          title="Today"
          sub={dateLine()}
        />
        <div className="mb-4 grid grid-cols-1 gap-3 lg:grid-cols-3">
          <Metric label="Schedule" value="Calendar" sub="Live appointments (RLS-scoped)" href="/calendar" />
          <Metric label="Review queue" value="Tasks" sub="Live review_queue_items" href="/tasks" />
          <Metric label="Patients" value="Directory" sub="Live patient_profiles" href="/patients" />
        </div>
        <DemoNote>
          Live mode shows real, org-scoped surfaces only. The aggregated daily brief (arrivals,
          messages, approvals, wearable alerts) is demo-only until those domains have live
          backends — nothing here pretends otherwise.{" "}
          <Link href="/calendar" className="font-semibold text-action">
            Open the live calendar
          </Link>
          .
        </DemoNote>
      </section>
    );
  }
  const { weekday, isWeekendFallback } = effectiveWeekday();
  return (
    <TodayWorkspace
      dateLine={dateLine()}
      weekday={weekday}
      isWeekendFallback={isWeekendFallback}
    />
  );
}
