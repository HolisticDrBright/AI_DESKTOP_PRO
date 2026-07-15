import { CircleCheck, CircleX } from "lucide-react";
import type { ReasoningSnapshot } from "@/adapters/types";
import { Card, CardLink } from "@/components/ui/bits";
import { patientPath } from "@/lib/routes";

export function ReasoningSnapshotCard({
  reasoning,
  patientId,
}: {
  reasoning: ReasoningSnapshot;
  patientId: string;
}) {
  return (
    <Card>
      <div className="flex items-center gap-[10px] px-[18px] pt-[14px]">
        <h2 className="m-0 text-[14px] font-bold">Clinical Reasoning Snapshot</h2>
        <span className="rounded-full bg-sunken-2 px-[9px] py-[3px] text-[10.5px] font-semibold text-muted">
          Updated {reasoning.updatedOn}
        </span>
        <div className="flex-1" />
        {reasoning.review.status === "awaiting" ? (
          <span className="flex items-center gap-[5px] rounded-full border border-[rgba(199,126,20,0.22)] bg-warning-tint px-[10px] py-[3px] text-[11px] font-semibold text-warning-deep">
            Awaiting practitioner review
          </span>
        ) : (
          <span className="flex items-center gap-[5px] rounded-full border border-[rgba(31,157,99,0.22)] bg-positive-tint px-[10px] py-[3px] text-[11px] font-semibold text-positive">
            {reasoning.review.label}
          </span>
        )}
      </div>

      <div className="grid grid-cols-[1.15fr_1fr_1fr_1fr] px-1 pt-[6px] pb-1">
        <div className="border-r border-hairline-2 px-[14px] py-3">
          <h3 className="m-0 mb-[10px] text-[12px] font-bold text-body-2">Top Hypotheses</h3>
          <div className="flex flex-col gap-3">
            {reasoning.hypotheses.map((h, i) => (
              <div key={h.name} className="flex items-start gap-[9px]">
                <span className="mt-px flex h-[18px] w-[18px] shrink-0 items-center justify-center rounded-full bg-number-tint text-[10px] font-semibold text-muted">
                  {i + 1}
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block text-[12.5px] leading-[1.3] font-semibold">
                    {h.name}
                  </span>
                  <span className="mt-px block text-[11px] text-subtle">{h.sub}</span>
                </span>
                <span className="shrink-0 rounded-[7px] bg-ai-tint px-2 py-[2px] text-[11px] font-bold text-ai-deep">
                  {h.strength}
                </span>
              </div>
            ))}
          </div>
          <div className="mt-3 text-[9.5px] leading-[1.4] text-faint">
            Strength reflects internal evidence weighting — not a medical probability.
          </div>
        </div>

        <div className="border-r border-hairline-2 px-[14px] py-3">
          <h3 className="m-0 mb-[10px] text-[12px] font-bold text-body-2">
            Key Evidence For
          </h3>
          <div className="flex flex-col gap-[10px]">
            {reasoning.evidenceFor.map((text) => (
              <div key={text} className="flex items-start gap-2">
                <CircleCheck
                  size={14}
                  strokeWidth={2}
                  className="mt-px shrink-0 text-positive-bright"
                  aria-hidden
                />
                <span className="text-[12px] leading-[1.4] text-body">{text}</span>
              </div>
            ))}
          </div>
        </div>

        <div className="border-r border-hairline-2 px-[14px] py-3">
          <h3 className="m-0 mb-[10px] text-[12px] font-bold text-body-2">
            Key Evidence Against
          </h3>
          <div className="flex flex-col gap-[10px]">
            {reasoning.evidenceAgainst.map((text) => (
              <div key={text} className="flex items-start gap-2">
                <CircleX
                  size={14}
                  strokeWidth={2}
                  className="mt-px shrink-0 text-critical"
                  aria-hidden
                />
                <span className="text-[12px] leading-[1.4] text-body">{text}</span>
              </div>
            ))}
          </div>
        </div>

        <div className="flex flex-col px-[14px] py-3">
          <h3 className="m-0 mb-[10px] text-[12px] font-bold text-body-2">
            Recommended Next Steps
          </h3>
          <div className="flex flex-1 flex-col gap-[9px]">
            {reasoning.nextSteps.map((step) => (
              <span key={step} className="flex gap-2 text-[12px] leading-[1.4] text-body">
                <span className="text-faint" aria-hidden>
                  •
                </span>
                {step}
              </span>
            ))}
          </div>
          <CardLink href={patientPath(patientId, "reasoning")} className="mt-[10px]">
            View Full Analysis
          </CardLink>
        </div>
      </div>
    </Card>
  );
}
