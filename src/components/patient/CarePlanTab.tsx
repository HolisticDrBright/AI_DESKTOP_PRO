import Link from "next/link";
import { ClipboardList } from "lucide-react";
import { getCarePlan } from "@/adapters/careplan.mock";
import { SupplementsWorkspace } from "@/components/supplements/SupplementsWorkspace";
import { NutritionWorkspace } from "@/components/nutrition/NutritionWorkspace";
import { SegTabs } from "@/components/ui/SegTabs";
import { Card, CardTitle, ProgressBar } from "@/components/ui/bits";
import { Pill } from "@/components/ui/Pill";
import { BtnLink } from "@/components/ui/Btn";
import { DemoNote } from "@/components/ui/DemoNote";
import { toneColor } from "@/lib/tones";
import { patientPath } from "@/lib/routes";

function ProtocolsView({ patientId }: { patientId: string }) {
  const plans = getCarePlan(patientId);
  return (
    <div className="flex flex-col gap-4">
      {plans.length === 0 && (
        <Card className="px-4 py-8 text-center text-[12.5px] text-faint">
          No protocols yet — start one from a template.
        </Card>
      )}
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        {plans.map((p) => (
          <Card key={p.id} className="px-4 py-[14px]">
            <div className="mb-1 flex items-center gap-2">
              <ClipboardList size={14} strokeWidth={1.75} style={{ color: toneColor[p.tone] }} aria-hidden />
              <CardTitle className="flex-1">{p.name}</CardTitle>
              <Pill tone={p.status === "active" ? "positive" : p.status === "pending-approval" ? "warning" : "slate"}>
                {p.status === "pending-approval" ? "Pending approval" : p.status === "active" ? "Active" : "Completed"}
              </Pill>
            </div>
            <p className="m-0 text-[11.5px] text-subtle">
              {p.phase} · started {p.startedLabel} · next review {p.nextReviewLabel}
            </p>
            {p.adherencePct != null && (
              <div className="mt-2 flex items-center gap-2">
                <ProgressBar pct={p.adherencePct} color={toneColor[p.adherencePct >= 70 ? "positive" : "warning"]} className="flex-1" label={`Adherence ${p.adherencePct}%`} />
                <span className="text-[11.5px] font-semibold text-muted">{p.adherencePct}%</span>
              </div>
            )}
            <ul className="mt-3 mb-0 flex list-none flex-col gap-[6px] p-0">
              {p.items.map((it) => (
                <li key={it.label} className="rounded-lg border border-hairline bg-sunken px-3 py-[7px]">
                  <span className="block text-[12.5px] font-medium text-ink">{it.label}</span>
                  <span className="block text-[11.5px] text-subtle">{it.detail}</span>
                </li>
              ))}
            </ul>
            {p.status === "pending-approval" && (
              <p className="mt-3 mb-0 rounded-lg bg-warning-tint px-3 py-[7px] text-[11.5px] font-medium text-warning-deep">
                Drafted from the review queue — approve or modify it in{" "}
                <Link href="/tasks?filter=protocol-approval" className="font-bold underline">
                  Review Queue → Protocol approvals
                </Link>
                . Approval safeguards unchanged.
              </p>
            )}
            {p.linkedTemplate && (
              <p className="mt-2 mb-0 text-[11px] text-faint">
                Template: <Link href="/templates?type=protocol" className="font-semibold text-action">{p.linkedTemplate}</Link>
              </p>
            )}
          </Card>
        ))}
      </div>
      <DemoNote>
        Protocols are demo fixtures; approval and review flows run through the same review queue
        and audit layer as the rest of the demo. Nothing is prescribed or sent from here.
      </DemoNote>
    </div>
  );
}

/** Care Plan: protocols · supplements (dispensary) · nutrition (Passio-bounded). */
export function CarePlanTab({
  patientId,
  patientName,
  view,
}: {
  patientId: string;
  patientName: string;
  view?: string;
}) {
  const active = view === "supplements" || view === "nutrition" ? view : "plan";
  return (
    <div data-screen-label="Care Plan">
      <div className="flex items-center justify-between gap-3">
        <SegTabs
          basePath={patientPath(patientId, "care-plan")}
          param="view"
          value={active}
          ariaLabel="Care plan sections"
          className="flex-1"
          options={[
            { id: "plan", label: "Protocols" },
            { id: "supplements", label: "Supplements & dispensary" },
            { id: "nutrition", label: "Nutrition & meal plans" },
          ]}
        />
        <BtnLink size="sm" href="/templates?type=protocol" className="mb-4 shrink-0">
          Template library
        </BtnLink>
      </div>
      {active === "plan" && <ProtocolsView patientId={patientId} />}
      {active === "supplements" && <SupplementsWorkspace patientId={patientId} patientName={patientName} />}
      {active === "nutrition" && <NutritionWorkspace patientId={patientId} patientName={patientName} />}
    </div>
  );
}
