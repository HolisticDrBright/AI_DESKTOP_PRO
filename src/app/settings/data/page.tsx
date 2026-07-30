import type { Metadata } from "next";
import { ImportWizard } from "@/components/imports/ImportWizard";
import { DataSourceCard } from "@/components/settings/DataSourceCard";
import { SegTabs } from "@/components/ui/SegTabs";
import { PageHeader } from "@/components/ui/PageHeader";

export const metadata: Metadata = { title: "Data & imports — AI Longevity Pro" };

/** Settings → Data: the import wizard + data-source boundaries. */
export default async function SettingsDataPage({
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
        value={tab}
        ariaLabel="Data sections"
        options={[
          { id: "imports", label: "Imports" },
          { id: "sources", label: "Data sources" },
        ]}
      />
      {tab === "imports" ? <ImportWizard /> : <DataSourceCard />}
    </section>
  );
}
