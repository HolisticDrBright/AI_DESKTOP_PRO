"use client";

import { useCallback, useEffect, useState } from "react";
import { api } from "@/adapters";
import { AdapterError } from "@/adapters/errors";
import { Card, CardTitle } from "@/components/ui/bits";
import { Btn } from "@/components/ui/Btn";
import type { EducationCurriculumRead } from "@/contracts/programEducationAccess";
import { purchaseCounts, purchaseRows, type PurchaseRow } from "@/lib/programs/purchaseStatus";

/**
 * The Studio's purchases panel: the commercial facts about one program (orders, entitlements,
 * claims, enrollments) under their own commercial boundary, with the states the handoff names kept
 * distinct: paid-but-not-fulfilled, pending-account, provider-unavailable, refunded/disputed held,
 * and held clinical delivery. A failed or disabled read is shown as that, never as "no purchases",
 * and a payment is never shown as a clinical enrollment. The exact purchased version can be opened
 * read-only, as what the learner was sold.
 */
export type PurchasesRead =
  | { state: "loading" }
  | { state: "disabled" }
  | { state: "failed"; message: string }
  | { state: "read"; rows: PurchaseRow[]; readAt: string };

export function ProgramPurchasesPanel({ programId, session }: { programId: string; session: string }) {
  const [read, setRead] = useState<PurchasesRead>({ state: "loading" });
  const [curriculum, setCurriculum] = useState<{ entitlementId: string; read: EducationCurriculumRead | "loading" | "failed" } | null>(null);
  const load = useCallback(async () => {
    setRead({ state: "loading" });
    try {
      const status = await api.programs.purchaseStatus(programId);
      setRead({ state: "read", rows: purchaseRows(status, new Date()), readAt: status.readAt });
    } catch (error) {
      if (error instanceof AdapterError && error.message === "commerce_disabled") setRead({ state: "disabled" });
      else setRead({ state: "failed", message: error instanceof AdapterError ? error.message : "service_unavailable" });
    }
  }, [programId]);
  useEffect(() => { setCurriculum(null); void load(); }, [load, session]);
  const open = async (entitlementId: string) => {
    setCurriculum({ entitlementId, read: "loading" });
    try { setCurriculum({ entitlementId, read: await api.programs.purchasedCurriculum(entitlementId) }); }
    catch { setCurriculum({ entitlementId, read: "failed" }); }
  };
  return <ProgramPurchasesView read={read} curriculum={curriculum} onRetry={() => void load()} onOpen={entitlementId => void open(entitlementId)} />;
}

export function ProgramPurchasesView({ read, curriculum, onRetry, onOpen }: { read: PurchasesRead; curriculum: { entitlementId: string; read: EducationCurriculumRead | "loading" | "failed" } | null; onRetry: () => void; onOpen: (entitlementId: string) => void }) {
  return (
    <Card className="px-4 py-3" data-testid="program-purchases" data-state={read.state}>
      <CardTitle className="mb-1">Purchases</CardTitle>
      <p className="m-0 mb-2 text-[12px] text-subtle">
        Commercial facts only: who bought what, on which terms, and whether access was claimed. A purchase is education access; it is not clinic membership, a chart, a consent or a protocol step, and clinical delivery stays a separate, reviewed decision.
      </p>
      {read.state === "loading" && <p className="m-0 text-[12.5px] text-subtle" data-testid="purchases-loading">Reading purchases…</p>}
      {read.state === "disabled" && <p role="status" className="m-0 text-[12.5px] text-body" data-testid="purchases-disabled">Program commerce is not connected for this deployment, so nothing can be said about purchases here. This is not the same as having none.</p>}
      {read.state === "failed" && (
        <p role="alert" className="m-0 text-[12.5px] text-critical" data-testid="purchases-failed">
          The purchase record could not be read ({read.message}). This is not the same as having no purchases. <button type="button" className="underline" onClick={onRetry}>Read again</button>
        </p>
      )}
      {read.state === "read" && read.rows.length === 0 && <p className="m-0 text-[12.5px] text-faint" data-testid="purchases-empty">No purchases have been started for this program.</p>}
      {read.state === "read" && read.rows.length > 0 && (
        <>
          <p className="m-0 mb-2 text-[12px] text-subtle" data-testid="purchases-counts">
            {Object.entries(purchaseCounts(read.rows)).map(([kind, count]) => `${count} ${kind.replaceAll("_", " ")}`).join(" · ")}
          </p>
          <ul className="m-0 flex list-none flex-col gap-2 p-0" data-testid="purchases-list">
            {read.rows.map(row => (
              <li key={row.orderId} className="rounded-lg border border-line p-2 text-[12.5px]" data-testid={`purchase-${row.orderId}`} data-kind={row.kind} data-clinical-delivery={row.clinicalDelivery}>
                <p className="m-0 font-semibold text-body">{row.kind.replaceAll("_", " ")}</p>
                <p className="m-0 mt-1 text-body">{row.summary}</p>
                <p className="m-0 mt-1 text-subtle">{row.terms}; sold as version {row.curriculumVersion}.</p>
                {row.clinicalDelivery === "pending_review" && <p className="m-0 mt-1 text-subtle" data-testid="purchase-clinical-pending">Clinical delivery: not started. Adding program steps to this person&apos;s protocol needs the existing review and acceptance; a purchase does not do it.</p>}
                {row.entitlementId && <div className="mt-2"><Btn type="button" size="sm" onClick={() => onOpen(row.entitlementId!)} data-testid="purchase-open-curriculum">Show the exact version sold</Btn></div>}
                {curriculum && curriculum.entitlementId === row.entitlementId && (
                  <div className="mt-2 rounded-lg bg-card p-2" data-testid="purchased-curriculum">
                    {curriculum.read === "loading" && <p className="m-0 text-subtle">Reading the purchased version…</p>}
                    {curriculum.read === "failed" && <p role="alert" className="m-0 text-critical">The purchased version could not be read. This does not mean it is missing.</p>}
                    {typeof curriculum.read === "object" && curriculum.read.outcome === "withheld" && <p className="m-0 text-critical" data-reason={curriculum.read.reason}>Withheld: {curriculum.read.reason.replaceAll("_", " ")}. What the learner was sold cannot be shown from the current store.</p>}
                    {typeof curriculum.read === "object" && curriculum.read.outcome === "served" && (
                      <>
                        <p className="m-0 font-semibold text-body">{curriculum.read.title} (version {curriculum.read.curriculum.version})</p>
                        <ol className="m-0 mt-1 list-decimal pl-5 text-body">{curriculum.read.phases.map((phase, index) => <li key={index}>{phaseTitle(phase)}</li>)}</ol>
                      </>
                    )}
                  </div>
                )}
              </li>
            ))}
          </ul>
        </>
      )}
    </Card>
  );
}

function phaseTitle(phase: unknown): string {
  if (phase && typeof phase === "object" && typeof (phase as { title?: unknown }).title === "string") return (phase as { title: string }).title;
  return "Phase";
}

