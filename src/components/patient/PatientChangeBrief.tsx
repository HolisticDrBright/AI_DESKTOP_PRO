"use client";

import { FilePlus2 } from "lucide-react";
import { buildPatientChangeBrief } from "@/adapters/ai-assistance.mock";
import { useComposerOptional } from "@/lib/composer";
import { useFeedback } from "@/lib/feedback";
import { AiAssistancePanel } from "@/components/ai/AiAssistancePanel";
import { Btn } from "@/components/ui/Btn";

export function PatientChangeBrief({
  patientId,
  patientName,
}: {
  patientId: string;
  patientName: string;
}) {
  const brief = buildPatientChangeBrief(patientId, patientName);
  const composer = useComposerOptional();
  const { announce } = useFeedback();

  return (
    <AiAssistancePanel
      brief={brief}
      actions={
        brief.status === "fixture" ? (
          <Btn
            size="sm"
            variant="ai"
            onClick={() => {
              if (!composer) {
                announce("The note composer is unavailable on this screen.");
                return;
              }
              composer.openComposer("reasoning-summary", {
                patientName,
                subjectType: "longitudinal chart brief",
                subjectLabel: brief.title,
                seeds: [
                  brief.summary,
                  ...brief.items.map((item) => `${item.title}: ${item.detail}`),
                  ...brief.missingInformation.map((item) => `Confirm: ${item}`),
                ],
              });
            }}
          >
            <FilePlus2 size={12} aria-hidden /> Add to note draft
          </Btn>
        ) : undefined
      }
    />
  );
}
