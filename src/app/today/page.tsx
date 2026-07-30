import type { Metadata } from "next";
import Link from "next/link";
import { PageHeader } from "@/components/ui/PageHeader";
import { Metric } from "@/components/ui/Metric";
import { ClinicalNote } from "@/components/ui/ClinicalStates";
import { TodayScheduleLive } from "@/components/today/TodayScheduleLive";
import { TodayProgramsLive } from "@/components/today/TodayProgramsLive";
import { TodayInboxLive } from "@/components/today/TodayInboxLive";

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
 * The daily entry point offers the real, org-scoped surfaces directly.
 *
 * Real aggregations only: today's appointments with their real front-desk
 * statuses (phase 2), program enrollment counts (phase 3), and inbox counts —
 * open threads, unread inbound, urgent flags, due follow-ups (phase 4) — all
 * straight from Desktop-owned RPCs. The parts of a "daily brief" that still
 * have no live backend (notes awaiting signature, wearable alerts, outstanding
 * balances) are named as not configured instead of fabricated.
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
      <div className="mb-4">
        <TodayScheduleLive />
      </div>
      <div className="mb-4">
        <TodayInboxLive />
      </div>
      <div className="mb-4">
        <TodayProgramsLive />
      </div>
      <ClinicalNote>
        Notes awaiting signature, wearable alerts, and outstanding balances are{" "}
        <strong>not configured</strong> — those domains have no live backend yet, so no count is
        shown for them. Today&apos;s appointment statuses and inbox counts above are real records.{" "}
        <Link href="/calendar" className="font-semibold text-action">
          Open the live calendar
        </Link>
        .
      </ClinicalNote>
    </section>
  );
}
