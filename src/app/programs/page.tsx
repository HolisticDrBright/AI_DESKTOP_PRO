import type { Metadata } from "next";
import { PageHeader } from "@/components/ui/PageHeader";
import { ProgramsWorkspace } from "@/components/programs/ProgramsWorkspace";

export const metadata: Metadata = { title: "Programs — AI Longevity Pro" };

// Live, org-scoped data — never prerender at build time.
export const dynamic = "force-dynamic";

/**
 * Programs & Education (phase 3): real org-owned programs with versioned
 * curricula, read and written exclusively through the Desktop-owned RPC
 * boundary. Enrollment counts are persisted rows; engagement/revenue metrics
 * are absent because no honest source computes them.
 */
export default function ProgramsPage() {
  return (
    <section data-screen-label="Programs" className="mx-auto max-w-[1100px] px-[22px] pt-[18px] pb-6">
      <PageHeader
        crumb="Workspace / Programs"
        title="Programs"
        sub="Versioned education programs — drafts, review, publication, enrollments"
      />
      <ProgramsWorkspace />
    </section>
  );
}
