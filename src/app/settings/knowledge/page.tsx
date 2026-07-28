import type { Metadata } from "next";
import { ClinicalKnowledgeCenter } from "@/components/settings/ClinicalKnowledgeCenter";
import { PageHeader } from "@/components/ui/PageHeader";

export const metadata: Metadata = { title: "Clinical knowledge — AI Longevity Pro" };

export default function ClinicalKnowledgePage() {
  return (
    <section data-screen-label="Clinical knowledge" className="mx-auto max-w-[1380px] px-6 pt-[18px] pb-8">
      <PageHeader
        crumb="Settings / Clinical governance"
        title="Clinical Knowledge Center"
        sub="Version practitioner-authored pathways, differentiating questions, lab logic, exact product candidates, nutrition guidance, and safety stops. Only approved versions can power the clinical copilot."
      />
      <div className="mb-4 rounded border border-warning/25 bg-warning-tint px-3 py-2 text-[11.5px] leading-[1.5] text-warning-deep">
        Local preview · Changes are stored for this browser session only. The persistent database and API contracts are ready but remain inactive until the migration is reviewed and deployed.
      </div>
      <ClinicalKnowledgeCenter />
    </section>
  );
}
