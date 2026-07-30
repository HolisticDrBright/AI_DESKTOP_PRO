import type { Metadata } from "next";
import { PageHeader } from "@/components/ui/PageHeader";
import { ProgramStudio } from "@/components/programs/ProgramStudio";

export const metadata: Metadata = { title: "Program studio — AI Longevity Pro" };

// Live, org-scoped data — never prerender at build time.
export const dynamic = "force-dynamic";

/**
 * One program's studio: curriculum builder with autosave, the
 * draft → in review → approved → published lifecycle with separate confirmed
 * approve and publish steps, offers (terms only), the enrollment roster, and
 * the append-only version history.
 */
export default async function ProgramStudioPage({
  params,
}: {
  params: Promise<{ programId: string }>;
}) {
  const { programId } = await params;
  return (
    <section
      data-screen-label="Program studio"
      className="mx-auto max-w-[1100px] px-[22px] pt-[18px] pb-6"
    >
      <PageHeader crumb="Workspace / Programs / Studio" title="Program studio" sub="" />
      <ProgramStudio programId={programId} />
    </section>
  );
}
