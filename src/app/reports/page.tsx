import type { Metadata } from "next";
import { USE_LIVE_API } from "@/adapters/mode";
import { ReportsWorkspace } from "@/components/reports/ReportsWorkspace";
import { ClinicalEmpty } from "@/components/ui/ClinicalStates";

export const metadata: Metadata = { title: "Reports — AI Longevity Pro" };

export default async function ReportsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const sp = await searchParams;
  const report = typeof sp.report === "string" ? sp.report : undefined;

  if (USE_LIVE_API) {
    return (
      <section data-screen-label="Reports" className="mx-auto max-w-[900px] px-6 pt-[22px] pb-6">
        <ClinicalEmpty
          title="Reports aren't live yet"
          message="The report catalog runs on synthetic demo data and stays hidden in live mode — practice aggregates need real, access-scoped queries first."
        />
      </section>
    );
  }
  return <ReportsWorkspace initialReport={report} />;
}
