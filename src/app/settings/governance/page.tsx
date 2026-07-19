import type { Metadata } from "next";
import { AiSafetyScreen } from "@/components/ai-safety/AiSafetyScreen";
import { AuditLogScreen } from "@/components/audit/AuditLogScreen";
import { SegTabs } from "@/components/ui/SegTabs";
import { PageHeader } from "@/components/ui/PageHeader";

export const metadata: Metadata = { title: "Security & Governance — AI Longevity Pro" };

/**
 * Settings → Security & Governance. The AI governance registry
 * (provider/model/prompt/schema versions, intended role, risk, review
 * requirements, patient-facing status, enablement posture) and the audit
 * log — removed from primary navigation, NOT deleted. /ai-safety and
 * /audit-log redirect here.
 */
export default async function GovernancePage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const sp = await searchParams;
  const tab = sp.tab === "audit" ? "audit" : "ai";
  return (
    <section data-screen-label="Security & Governance" className="mx-auto max-w-[1180px] px-6 pt-[18px] pb-8">
      <PageHeader
        crumb="Settings / Security & Governance"
        title="Security & Governance"
        sub="AI registry and the append-only activity record. Audit covers access, chart changes, signatures & addenda, consent & recording, exports, payments & refunds, integrations, and administrative changes."
      />
      <SegTabs
        basePath="/settings/governance"
        value={tab}
        ariaLabel="Governance sections"
        options={[
          { id: "ai", label: "AI governance" },
          { id: "audit", label: "Audit log" },
        ]}
      />
      {tab === "ai" ? <AiSafetyScreen /> : <AuditLogScreen />}
    </section>
  );
}
