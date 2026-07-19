import type { Metadata } from "next";
import { USE_LIVE_API } from "@/adapters/mode";
import { ProgramsStudio } from "@/components/programs/ProgramsStudio";
import { ClinicalEmpty } from "@/components/ui/ClinicalStates";

export const metadata: Metadata = { title: "Programs — AI Longevity Pro" };

export default async function ProgramsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const sp = await searchParams;
  const program = typeof sp.program === "string" ? sp.program : undefined;

  if (USE_LIVE_API) {
    return (
      <section data-screen-label="Programs" className="mx-auto max-w-[900px] px-6 pt-[22px] pb-6">
        <ClinicalEmpty
          title="Programs aren't live yet"
          message="The Programs Studio is demo-only until a live catalog backend exists — it stays hidden in live mode rather than pretending to publish."
        />
      </section>
    );
  }
  return <ProgramsStudio initialProgramId={program} />;
}
