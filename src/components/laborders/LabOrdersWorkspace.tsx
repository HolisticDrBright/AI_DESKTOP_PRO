"use client";

import { useEffect, useMemo, useState } from "react";
import {
  CircleCheck,
  CircleDashed,
  FlaskConical,
  Info,
  Plus,
  TriangleAlert,
  X,
} from "lucide-react";
import { api } from "@/adapters";
import {
  getOrderContext,
  money,
  type LabPanel,
  type RecommendedPanel,
} from "@/adapters/labOrders.mock";
import { useLabOrderDraft } from "@/adapters/session-store";
import type { Tone } from "@/adapters/types";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { Provenance } from "@/components/ui/Provenance";
import { Card } from "@/components/ui/bits";
import { ClinicalLoading } from "@/components/ui/ClinicalStates";
import { cn } from "@/lib/cn";
import { useFeedback } from "@/lib/feedback";
import { toneText, toneTint } from "@/lib/tones";

const SOURCE_TONE: Record<RecommendedPanel["source"], Tone> = {
  Reasoning: "ai",
  Labs: "action",
  Goals: "teal",
  Protocol: "positive",
};

function Pill({ tone, children }: { tone: Tone; children: React.ReactNode }) {
  return (
    <span
      className="w-fit rounded-full px-[8px] py-px text-[10px] font-semibold whitespace-nowrap"
      style={{ color: toneText[tone], background: toneTint[tone] }}
    >
      {children}
    </span>
  );
}

type CatTab = "recommended" | "common" | "custom";

export function LabOrdersWorkspace({ patientId, patientName }: { patientId: string; patientName: string }) {
  const { announce } = useFeedback();
  const [catalog, setCatalog] = useState<LabPanel[] | null>(null);
  const [recommended, setRecommended] = useState<RecommendedPanel[]>([]);
  const [tab, setTab] = useState<CatTab>("recommended");
  const [preparing, setPreparing] = useState(false);
  const draft = useLabOrderDraft(patientId);

  useEffect(() => {
    let alive = true;
    Promise.all([api.labOrders.listCatalogPanels(patientId), api.labOrders.listRecommendedPanels(patientId)]).then(
      ([c, r]) => {
        if (!alive) return;
        setCatalog(c);
        setRecommended(r);
      },
    );
    return () => {
      alive = false;
    };
  }, [patientId]);

  const byId = useMemo(() => new Map((catalog ?? []).map((p) => [p.id, p])), [catalog]);
  const draftPanels = draft.panelIds.map((id) => byId.get(id)).filter(Boolean) as LabPanel[];
  const inDraft = (id: string) => draft.panelIds.includes(id);

  const add = (id: string) =>
    void api.labOrders.addPanelToDraft(patientId, id).then((r) => announce(r.message));
  const remove = (id: string) =>
    void api.labOrders.removePanelFromDraft(patientId, id).then((r) => announce(r.message));
  const prepare = () => {
    setPreparing(false);
    void api.labOrders.prepareOrderDraft(patientId).then((r) => announce(r.message));
  };
  const markReviewed = () =>
    void api.labOrders.markOrderReviewed(patientId).then((r) => announce(r.message));

  if (!catalog) {
    return (
      <section data-screen-label="Lab Orders" className="px-6 pt-[22px] pb-8">
        <ClinicalLoading label="Loading lab catalog…" />
      </section>
    );
  }

  const listed = tab === "common" ? catalog.filter((p) => p.group === "common") : tab === "custom" ? catalog.filter((p) => p.group === "custom") : [];

  return (
    <section data-screen-label="Lab Orders" className="relative pb-8">
      <div className="mb-3 flex flex-wrap items-start justify-between gap-2">
        <div>
          <div className="flex items-center gap-[7px]">
            <FlaskConical size={17} strokeWidth={2} className="text-brand" aria-hidden />
            <h1 className="m-0 text-[19px] font-bold tracking-[-0.015em]">Lab orders</h1>
          </div>
          <p className="mt-[3px] mb-0 text-[11.5px] text-subtle">
            Build an order draft for {patientName} from recommended, commonly ordered, and custom panels.
          </p>
        </div>
        <span className="flex items-center gap-[6px] rounded-lg border border-[rgba(199,126,20,0.28)] bg-warning-tint px-[10px] py-[6px] text-[11px] font-semibold text-warning-deep">
          <TriangleAlert size={13} strokeWidth={2} aria-hidden />
          Demo only — no lab order is submitted
        </span>
      </div>

      <div className="grid grid-cols-[minmax(0,1fr)_360px] items-start gap-4">
        {/* catalog */}
        <div>
          <div role="tablist" aria-label="Panel sources" className="mb-3 flex w-fit items-center gap-[2px] rounded-lg border border-line bg-card p-[3px]">
            {([
              ["recommended", "Recommended"],
              ["common", "Commonly ordered"],
              ["custom", "Custom / advanced"],
            ] as [CatTab, string][]).map(([id, label]) => (
              <button
                key={id}
                role="tab"
                aria-selected={tab === id}
                onClick={() => setTab(id)}
                className={cn(
                  "h-[30px] rounded-md px-[12px] text-[12.5px] font-semibold focus-visible:outline-2 focus-visible:outline-action",
                  tab === id ? "bg-action text-white" : "text-muted hover:text-ink",
                )}
              >
                {label}
              </button>
            ))}
          </div>

          {tab === "recommended" ? (
            <div className="flex flex-col gap-3">
              {recommended.map((rec) => {
                const panel = byId.get(rec.panelId);
                if (!panel) return null;
                return (
                  <Card key={rec.panelId} className="p-[13px]">
                    <div className="flex items-start justify-between gap-2">
                      <div className="min-w-0">
                        <div className="flex flex-wrap items-center gap-[7px]">
                          <h3 className="m-0 text-[13.5px] font-bold text-ink">{panel.name}</h3>
                          <Pill tone={SOURCE_TONE[rec.source]}>{rec.source}</Pill>
                        </div>
                        <p className="mt-[4px] mb-0 text-[12px] leading-[1.5] text-body">{rec.reason}</p>
                      </div>
                      <AddButton inDraft={inDraft(rec.panelId)} onAdd={() => add(rec.panelId)} />
                    </div>
                    <div className="mt-[9px]">
                      <Provenance data={rec.provenance} onOpenSource={() => announce("Opened source (demo — no document).")} />
                    </div>
                    <PanelMeta panel={panel} />
                    {rec.missingInfo.length > 0 && <MissingInfo items={rec.missingInfo} />}
                  </Card>
                );
              })}
            </div>
          ) : (
            <Card className="overflow-hidden">
              <ul className="m-0 list-none p-0">
                {listed.map((panel) => (
                  <li key={panel.id} className="border-b border-[#F3F7FA] px-[13px] py-[11px] last:border-b-0">
                    <div className="flex items-start justify-between gap-2">
                      <div className="min-w-0">
                        <h3 className="m-0 text-[13px] font-bold text-ink">{panel.name}</h3>
                        <p className="mt-[2px] mb-0 text-[11px] text-subtle">{panel.description}</p>
                      </div>
                      <AddButton inDraft={inDraft(panel.id)} onAdd={() => add(panel.id)} />
                    </div>
                    <PanelMeta panel={panel} />
                  </li>
                ))}
              </ul>
            </Card>
          )}
        </div>

        {/* order draft */}
        <div className="sticky top-[6px] flex flex-col gap-3">
          <DraftCard
            patientName={patientName}
            panels={draftPanels}
            draftStatus={draft.status}
            reviewed={draft.reviewed}
            onRemove={remove}
            onPrepare={() => setPreparing(true)}
            onMarkReviewed={markReviewed}
          />
          {draft.events.length > 0 && (
            <Card className="p-[11px]">
              <h3 className="m-0 mb-[7px] text-[11.5px] font-bold">Order activity</h3>
              <ul className="m-0 flex list-none flex-col gap-[6px] p-0">
                {draft.events.slice(0, 8).map((e) => (
                  <li key={e.id} className="flex items-start gap-[7px] text-[11.5px]">
                    <span className="mt-[5px] h-[6px] w-[6px] shrink-0 rounded-full bg-action" aria-hidden />
                    <span className="text-body">{e.label}</span>
                  </li>
                ))}
              </ul>
            </Card>
          )}
        </div>
      </div>

      {preparing && (
        <ConfirmDialog
          open
          title="Prepare this order draft?"
          body={`${draftPanels.length} panel${draftPanels.length === 1 ? "" : "s"} will be assembled into a draft requisition for your review. Demo boundary: no order is submitted to any lab and no requisition is generated.`}
          confirmLabel="Prepare order draft"
          onCancel={() => setPreparing(false)}
          onConfirm={prepare}
        />
      )}
    </section>
  );
}

function AddButton({ inDraft, onAdd }: { inDraft: boolean; onAdd: () => void }) {
  return (
    <button
      onClick={onAdd}
      disabled={inDraft}
      className="flex h-[30px] shrink-0 items-center gap-[5px] rounded-lg border border-line bg-card px-[11px] text-[12px] font-semibold text-action hover:border-action focus-visible:outline-2 focus-visible:outline-action disabled:cursor-not-allowed disabled:text-faint disabled:opacity-60"
    >
      {inDraft ? <CircleCheck size={13} strokeWidth={2} aria-hidden /> : <Plus size={13} strokeWidth={2.5} aria-hidden />}
      {inDraft ? "In draft" : "Add to order"}
    </button>
  );
}

function PanelMeta({ panel }: { panel: LabPanel }) {
  return (
    <div className="mt-[8px] flex flex-wrap items-center gap-x-3 gap-y-[4px] text-[10.5px] text-faint">
      <span>{panel.vendor}</span>
      <span aria-hidden>·</span>
      <span>{panel.specimenType}</span>
      <span aria-hidden>·</span>
      <span className={panel.fasting ? "font-semibold text-warning-deep" : ""}>
        {panel.fasting ? "Fasting required" : "No fasting"}
      </span>
      <span aria-hidden>·</span>
      <span>{panel.turnaround}</span>
      <span aria-hidden>·</span>
      <span className="font-semibold text-body">est. {money(panel.estPriceMinor)} (placeholder)</span>
      <span className="mt-[2px] block w-full text-muted">{panel.markers.join(" · ")}</span>
    </div>
  );
}

function MissingInfo({ items }: { items: string[] }) {
  return (
    <div className="mt-[8px] flex flex-wrap items-center gap-[6px] rounded-[8px] bg-warning-tint px-[9px] py-[6px]">
      <Info size={12} strokeWidth={2} className="text-warning-deep" aria-hidden />
      <span className="text-[10.5px] font-semibold text-warning-deep">Missing before ordering:</span>
      {items.map((m) => (
        <span key={m} className="text-[10.5px] text-warning-deep">
          {m}
        </span>
      ))}
    </div>
  );
}

function DraftCard({
  patientName,
  panels,
  draftStatus,
  reviewed,
  onRemove,
  onPrepare,
  onMarkReviewed,
}: {
  patientName: string;
  panels: LabPanel[];
  draftStatus: "draft" | "prepared";
  reviewed: boolean;
  onRemove: (id: string) => void;
  onPrepare: () => void;
  onMarkReviewed: () => void;
}) {
  const total = panels.reduce((n, p) => n + p.estPriceMinor, 0);
  const context = getOrderContext({ panelIds: panels.map((p) => p.id), status: draftStatus, reviewed, events: [] });
  const statusTone: Tone = reviewed ? "positive" : draftStatus === "prepared" ? "action" : "slate";
  const statusLabel = reviewed ? "Reviewed" : draftStatus === "prepared" ? "Prepared" : "Draft";

  return (
    <Card className="overflow-hidden">
      <div className="flex items-center justify-between border-b border-hairline px-4 py-[11px]">
        <div>
          <h3 className="m-0 text-[13px] font-bold">Order draft · {patientName}</h3>
          <p className="m-0 text-[11px] text-subtle">{panels.length} panel{panels.length === 1 ? "" : "s"}</p>
        </div>
        <Pill tone={statusTone}>{statusLabel}</Pill>
      </div>

      {panels.length === 0 ? (
        <div className="flex flex-col items-center gap-[7px] px-4 py-[30px] text-center">
          <FlaskConical size={19} strokeWidth={1.6} className="text-ghost" aria-hidden />
          <p className="m-0 text-[12px] text-subtle">No panels yet. Add from the recommended or catalog lists.</p>
        </div>
      ) : (
        <ul className="m-0 max-h-[220px] list-none overflow-y-auto p-0">
          {panels.map((p) => (
            <li key={p.id} className="flex items-center gap-2 border-b border-[#F3F7FA] px-3 py-[8px]">
              <div className="min-w-0 flex-1">
                <div className="truncate text-[12px] font-semibold text-ink">{p.name}</div>
                <div className="text-[10.5px] text-faint">{p.vendor} · {p.specimenType}</div>
              </div>
              <span className="shrink-0 text-[11.5px] font-semibold tabular-nums text-body">{money(p.estPriceMinor)}</span>
              <button
                onClick={() => onRemove(p.id)}
                aria-label={`Remove ${p.name}`}
                className="flex h-[24px] w-[24px] items-center justify-center rounded-lg text-faint hover:text-critical focus-visible:outline-2 focus-visible:outline-action"
              >
                <X size={13} strokeWidth={2} aria-hidden />
              </button>
            </li>
          ))}
        </ul>
      )}

      {/* required context */}
      <div className="border-t border-hairline px-4 py-[10px]">
        <h4 className="m-0 mb-[6px] text-[10px] font-bold tracking-[0.04em] text-faint uppercase">Required before ordering</h4>
        <ul className="m-0 flex list-none flex-col gap-[4px] p-0">
          {context.map((c) => (
            <li key={c.label} className="flex items-start gap-[7px] text-[11px]">
              {c.satisfied ? (
                <CircleCheck size={13} strokeWidth={2} className="mt-[1px] shrink-0 text-positive" aria-hidden />
              ) : (
                <CircleDashed size={13} strokeWidth={2} className="mt-[1px] shrink-0 text-faint" aria-hidden />
              )}
              <span className="text-body">
                <span className="font-semibold">{c.label}:</span>{" "}
                <span className={c.satisfied ? "text-muted" : "text-faint"}>{c.value}</span>
              </span>
            </li>
          ))}
        </ul>

        {panels.length > 0 && (
          <div className="mt-[9px] flex items-baseline justify-between border-t border-hairline-2 pt-[8px]">
            <span className="text-[12px] font-bold">Est. total (placeholder)</span>
            <span className="text-[15px] font-bold tabular-nums text-ink">{money(total)}</span>
          </div>
        )}

        <div className="mt-[10px] flex flex-col gap-2">
          <button
            onClick={onPrepare}
            disabled={panels.length === 0 || draftStatus === "prepared"}
            className="flex h-9 items-center justify-center gap-[6px] rounded-lg border-none bg-action text-[12.5px] font-semibold text-white hover:bg-action-deep focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ink disabled:cursor-not-allowed disabled:opacity-50"
          >
            {draftStatus === "prepared" ? "Draft prepared" : "Prepare order draft"}
          </button>
          <button
            onClick={onMarkReviewed}
            disabled={draftStatus !== "prepared" || reviewed}
            className="flex h-8 items-center justify-center rounded-lg border border-line bg-card text-[12px] font-semibold text-body hover:border-line-hover focus-visible:outline-2 focus-visible:outline-action disabled:cursor-not-allowed disabled:opacity-50"
          >
            {reviewed ? "Order reviewed ✓" : "Mark order reviewed"}
          </button>
        </div>
      </div>
    </Card>
  );
}
