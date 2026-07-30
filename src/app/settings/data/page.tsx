import type { Metadata } from "next";
import { DataSourceCard } from "@/components/settings/DataSourceCard";
import { SegTabs } from "@/components/ui/SegTabs";
import { PageHeader } from "@/components/ui/PageHeader";
import { ClinicalEmpty } from "@/components/ui/ClinicalStates";

export const metadata: Metadata = { title: "Data & imports — AI Longevity Pro" };

/** Settings → Data: data-source boundaries; imports await a real pipeline. */
export default async function DataSettingsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const sp = await searchParams;
  const tab = sp.tab === "sources" ? "sources" : "imports";
  return (
    <section data-screen-label="Data & imports" className="mx-auto max-w-[1180px] px-6 pt-[18px] pb-8">
      <PageHeader crumb="Settings / Data" title="Data & imports" />
      <SegTabs
        basePath="/settings/data"
        param="tab"
        value={tab}
        ariaLabel="Data sections"
        options={[
          { id: "imports", label: "Imports" },
          { id: "sources", label: "Sources" },
        ]}
      />
      {tab === "imports" ? (
        <div className="mt-4">
          <ClinicalEmpty
            title="Record imports aren't configured yet"
            message="Importing external records needs a real parse-and-match pipeline with practitioner review. Lab PDF ingestion is live on each patient's Labs tab; bulk imports stay off rather than simulating a migration."
          />
        </div>
      ) : (
        <DataSourceCard />
      )}
    </section>
  );
}
