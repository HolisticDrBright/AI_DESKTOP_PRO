import type { Metadata } from "next";
import { ClinicalKnowledgeWorkspace } from "@/components/settings/ClinicalKnowledgeWorkspace";
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
        Live registry · Changes use the authenticated organization and are audited. Imports remain
        non-approved until separate clinical review.
      </div>
      <ClinicalKnowledgeWorkspace />
    </section>
  );
}
