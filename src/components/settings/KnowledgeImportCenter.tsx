"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  AlertTriangle,
  Check,
  FileJson,
  FileSpreadsheet,
  PackageSearch,
  RefreshCw,
  Search,
  ShieldCheck,
  X,
} from "lucide-react";
import {
  resetMockKnowledgeImports,
  reviewMockKnowledgeImportItem,
  stageMockKnowledgeImport,
  useMockKnowledgeImports,
} from "@/adapters/clinical-import.mock";
import type {
  KnowledgeImportBatch,
  KnowledgeImportBundle,
  KnowledgeImportItem,
} from "@/adapters/clinical-import.types";
import { liveClient } from "@/adapters/live-client";
import { USE_LIVE_API } from "@/adapters/mode";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { cn } from "@/lib/cn";

type ReviewAction = { batchId: string; item: KnowledgeImportItem; decision: "accept" | "reject" };

function isBundle(value: unknown): value is KnowledgeImportBundle {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<KnowledgeImportBundle>;
  return candidate.schemaVersion === "clinical-knowledge-import-v1"
    && typeof candidate.sourceName === "string"
    && Array.isArray(candidate.items)
    && candidate.items.length > 0
    && candidate.items.length <= 250;
}

function statusLabel(item: KnowledgeImportItem) {
  if (item.status === "applied") return "Applied as draft";
  if (item.status === "rejected") return "Rejected";
  if (item.validationErrors.length) return "Source correction needed";
  return "Ready for review";
}

function statusClass(item: KnowledgeImportItem) {
  if (item.status === "applied") return "border-ok/25 bg-ok-tint text-ok";
  if (item.status === "rejected") return "border-line bg-sunken text-subtle";
  if (item.validationErrors.length) return "border-danger/25 bg-danger-tint text-danger";
  return "border-warning/25 bg-warning-tint text-warning-deep";
}

export function KnowledgeImportCenter() {
  const mockBatches = useMockKnowledgeImports();
  const [liveBatches, setLiveBatches] = useState<KnowledgeImportBatch[]>([]);
  const batches = USE_LIVE_API ? liveBatches : mockBatches;
  const [bundle, setBundle] = useState<KnowledgeImportBundle | null>(null);
  const [attested, setAttested] = useState(false);
  const [busy, setBusy] = useState(false);
  const [loadState, setLoadState] = useState<"ready" | "loading" | "error">(
    USE_LIVE_API ? "loading" : "ready",
  );
  const [message, setMessage] = useState("");
  const [query, setQuery] = useState("");
  const [entityFilter, setEntityFilter] = useState<"all" | "pathway" | "product_label">("all");
  const [statusFilter, setStatusFilter] = useState<"all" | "needs_review" | "applied" | "rejected">("needs_review");
  const [action, setAction] = useState<ReviewAction | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  const refresh = useCallback(async () => {
    if (!USE_LIVE_API) return;
    setLoadState("loading");
    try {
      setLiveBatches(await liveClient.listKnowledgeImports());
      setLoadState("ready");
    } catch {
      setLoadState("error");
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const loadPack = async () => {
    setBusy(true);
    setMessage("");
    try {
      const response = await fetch("/api/knowledge/authoring-pack", { cache: "no-store" });
      if (!response.ok) throw new Error("The protected authoring pack could not be loaded.");
      const data: unknown = await response.json();
      if (!isBundle(data)) throw new Error("The authoring pack does not match the governed import format.");
      setBundle(data);
      setAttested(false);
      setMessage("Authoring pack loaded. Review the counts and confirm the no-PHI attestation before staging.");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "The authoring pack could not be loaded.");
    } finally {
      setBusy(false);
    }
  };

  const loadFile = async (file: File | undefined) => {
    if (!file) return;
    setMessage("");
    try {
      const data: unknown = JSON.parse(await file.text());
      if (!isBundle(data)) throw new Error("This JSON file is not a supported clinical knowledge bundle.");
      setBundle(data);
      setAttested(false);
      setMessage(`${file.name} loaded. Confirm it contains no patient-identifiable information before staging.`);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "The JSON file could not be read.");
    } finally {
      if (fileRef.current) fileRef.current.value = "";
    }
  };

  const stage = async () => {
    if (!bundle || !attested) return;
    setBusy(true);
    setMessage("");
    try {
      const cleanBundle = {
        ...bundle,
        items: bundle.items.map((item) => ({ ...item, warnings: item.warnings.filter(Boolean) })),
      };
      if (USE_LIVE_API) {
        await liveClient.stageKnowledgeImport({
          sourceName: cleanBundle.sourceName,
          sourceRevision: cleanBundle.sourceRevision,
          schemaVersion: cleanBundle.schemaVersion,
          items: cleanBundle.items,
          attestsNoPhi: true,
        });
        await refresh();
      } else {
        stageMockKnowledgeImport(cleanBundle);
      }
      setBundle(null);
      setAttested(false);
      setMessage("Import staged for practitioner review. Nothing was approved or verified.");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "The import could not be staged.");
    } finally {
      setBusy(false);
    }
  };

  const review = async () => {
    if (!action) return;
    setBusy(true);
    setMessage("");
    try {
      if (USE_LIVE_API) {
        await liveClient.reviewKnowledgeImportItem(
          action.item.id,
          action.decision,
          action.decision === "accept"
            ? "Practitioner accepted into the non-approved review workflow"
            : "Practitioner rejected source item",
        );
        await refresh();
      } else {
        reviewMockKnowledgeImportItem(action.batchId, action.item.id, action.decision);
      }
      setMessage(action.decision === "accept"
        ? "Item applied as a non-approved draft. Separate approval or label verification is still required."
        : "Item rejected. The immutable source record remains available for audit.");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "The review action failed.");
    } finally {
      setBusy(false);
      setAction(null);
    }
  };

  const activeBatch = batches[0];
  const filteredItems = useMemo(() => {
    const normalized = query.trim().toLowerCase();
    return (activeBatch?.items ?? []).filter((item) => {
      if (entityFilter !== "all" && item.entityType !== entityFilter) return false;
      if (statusFilter !== "all" && item.status !== statusFilter) return false;
      return !normalized
        || item.displayName.toLowerCase().includes(normalized)
        || item.externalKey.toLowerCase().includes(normalized)
        || (item.sourceSheet ?? "").toLowerCase().includes(normalized);
    });
  }, [activeBatch, entityFilter, query, statusFilter]);

  const counts = useMemo(() => {
    const items = activeBatch?.items ?? [];
    return {
      pathways: items.filter((item) => item.entityType === "pathway").length,
      products: items.filter((item) => item.entityType === "product_label").length,
      blocked: items.filter((item) => item.validationErrors.length > 0 && item.status === "needs_review").length,
      ready: items.filter((item) => item.validationErrors.length === 0 && item.status === "needs_review").length,
    };
  }, [activeBatch]);

  return (
    <>
      <div className="overflow-hidden rounded border border-line bg-card">
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-line px-5 py-4">
          <div>
            <h2 className="m-0 text-[15px] font-bold text-ink">Governed import review</h2>
            <p className="mt-1 mb-0 text-[11.5px] text-subtle">
              Stage practitioner-authored pathways and product-label candidates. Acceptance never equals clinical approval.
            </p>
          </div>
          <div className="flex items-center gap-2">
            <input
              ref={fileRef}
              type="file"
              accept="application/json,.json"
              className="sr-only"
              onChange={(event) => void loadFile(event.target.files?.[0])}
            />
            <button
              onClick={() => fileRef.current?.click()}
              className="inline-flex h-8 items-center gap-1.5 rounded border border-line bg-card px-3 text-[11.5px] font-semibold text-body hover:border-line-hover"
            >
              <FileJson size={14} aria-hidden /> Load JSON
            </button>
            <button
              onClick={() => void loadPack()}
              disabled={busy}
              className="inline-flex h-8 items-center gap-1.5 rounded border-0 bg-action px-3 text-[11.5px] font-semibold text-white hover:bg-action-deep disabled:opacity-60"
            >
              <FileSpreadsheet size={14} aria-hidden /> Load authoring pack
            </button>
          </div>
        </div>

        {bundle && (
          <section className="border-b border-line bg-sunken px-5 py-4" aria-label="Import staging">
            <div className="grid gap-3 md:grid-cols-[minmax(0,1fr)_110px_110px_110px]">
              <div>
                <div className="text-[12px] font-bold text-ink">{bundle.sourceName}</div>
                <div className="mt-1 text-[10.5px] text-subtle">
                  {bundle.sourceRevision ?? "Revision not supplied"} · {bundle.schemaVersion}
                </div>
              </div>
              <div><div className="text-[18px] font-bold text-ink">{bundle.summary?.pathways ?? bundle.items.filter((item) => item.entityType === "pathway").length}</div><div className="text-[10.5px] text-subtle">Pathways</div></div>
              <div><div className="text-[18px] font-bold text-ink">{bundle.summary?.productLabels ?? bundle.items.filter((item) => item.entityType === "product_label").length}</div><div className="text-[10.5px] text-subtle">Products</div></div>
              <div><div className="text-[18px] font-bold text-ink">{bundle.items.length}</div><div className="text-[10.5px] text-subtle">Total items</div></div>
            </div>
            <label className="mt-4 flex items-start gap-2.5 text-[11.5px] leading-[1.5] text-body">
              <input
                type="checkbox"
                checked={attested}
                onChange={(event) => setAttested(event.target.checked)}
                className="mt-0.5"
              />
              <span>
                I confirm this source contains no patient-identifiable information. It is practitioner-authored reference material and still requires item-level clinical review.
              </span>
            </label>
            <button
              onClick={() => void stage()}
              disabled={!attested || busy}
              className="mt-3 inline-flex h-8 items-center gap-1.5 rounded border-0 bg-action px-3 text-[11.5px] font-semibold text-white hover:bg-action-deep disabled:cursor-not-allowed disabled:opacity-50"
            >
              <ShieldCheck size={14} aria-hidden /> Stage for review
            </button>
          </section>
        )}

        {message && (
          <div className="border-b border-line px-5 py-2.5 text-[11.5px] text-body" role="status">
            {message}
          </div>
        )}

        {loadState === "loading" ? (
          <div className="px-5 py-12 text-center text-[12px] text-subtle">Loading import history...</div>
        ) : loadState === "error" ? (
          <div className="px-5 py-10 text-center text-[12px] text-danger">
            Import history could not be loaded. <button onClick={() => void refresh()} className="font-bold underline">Try again</button>
          </div>
        ) : !activeBatch ? (
          <div className="px-5 py-12 text-center">
            <PackageSearch size={28} className="mx-auto text-faint" aria-hidden />
            <div className="mt-2 text-[12.5px] font-bold text-ink">No staged imports</div>
            <div className="mt-1 text-[11.5px] text-subtle">Load the prepared authoring pack or a validated JSON bundle to begin.</div>
          </div>
        ) : (
          <>
            <div className="grid border-b border-line bg-sunken sm:grid-cols-4">
              {[
                ["Pathways", counts.pathways],
                ["Product labels", counts.products],
                ["Ready to review", counts.ready],
                ["Source corrections", counts.blocked],
              ].map(([label, value]) => (
                <div key={label} className="border-b border-line px-4 py-3 last:border-b-0 sm:border-r sm:border-b-0 sm:last:border-r-0">
                  <div className="text-[16px] font-bold text-ink">{value}</div>
                  <div className="text-[10.5px] text-subtle">{label}</div>
                </div>
              ))}
            </div>
            <div className="flex flex-wrap items-center gap-2 border-b border-line px-4 py-3">
              <label className="relative min-w-[220px] flex-1">
                <Search size={14} className="absolute left-2.5 top-2 text-faint" aria-hidden />
                <span className="sr-only">Search import items</span>
                <input
                  value={query}
                  onChange={(event) => setQuery(event.target.value)}
                  placeholder="Search name, key, or source sheet"
                  className="h-8 w-full rounded border border-line bg-card pl-8 pr-3 text-[11.5px] outline-none focus:border-action"
                />
              </label>
              <select aria-label="Import item type" value={entityFilter} onChange={(event) => setEntityFilter(event.target.value as typeof entityFilter)} className="h-8 rounded border border-line bg-card px-2 text-[11px] text-body">
                <option value="all">All types</option>
                <option value="pathway">Pathways</option>
                <option value="product_label">Product labels</option>
              </select>
              <select aria-label="Import review status" value={statusFilter} onChange={(event) => setStatusFilter(event.target.value as typeof statusFilter)} className="h-8 rounded border border-line bg-card px-2 text-[11px] text-body">
                <option value="needs_review">Needs review</option>
                <option value="applied">Applied</option>
                <option value="rejected">Rejected</option>
                <option value="all">All statuses</option>
              </select>
              {USE_LIVE_API ? (
                <button onClick={() => void refresh()} title="Refresh imports" className="grid h-8 w-8 place-items-center rounded border border-line bg-card text-subtle hover:text-ink">
                  <RefreshCw size={14} aria-hidden />
                </button>
              ) : (
                <button
                  onClick={resetMockKnowledgeImports}
                  className="inline-flex h-8 items-center gap-1.5 rounded border border-line bg-card px-3 text-[11px] font-semibold text-subtle hover:text-ink"
                >
                  <RefreshCw size={13} aria-hidden /> Reset demo
                </button>
              )}
            </div>
            <div className="max-h-[620px] overflow-auto">
              <table className="w-full min-w-[900px] border-collapse text-left">
                <thead className="sticky top-0 z-10 bg-sunken text-[10.5px] font-bold uppercase text-faint">
                  <tr><th className="px-4 py-2.5">Item</th><th className="px-3 py-2.5">Source</th><th className="px-3 py-2.5">Review state</th><th className="px-3 py-2.5">Warnings</th><th className="px-4 py-2.5 text-right">Actions</th></tr>
                </thead>
                <tbody>
                  {filteredItems.map((item) => (
                    <tr key={item.id} className="border-t border-line align-top">
                      <td className="px-4 py-3">
                        <div className="text-[12px] font-bold text-ink">{item.displayName}</div>
                        <div className="mt-0.5 text-[10.5px] text-subtle">{item.entityType === "pathway" ? "Clinical pathway" : "Product-label candidate"} · {item.externalKey}</div>
                      </td>
                      <td className="px-3 py-3 text-[11px] text-body">{item.sourceSheet ?? "Not supplied"}</td>
                      <td className="px-3 py-3">
                        <span className={cn("inline-flex rounded border px-2 py-1 text-[10px] font-bold", statusClass(item))}>{statusLabel(item)}</span>
                        {item.validationErrors.map((error) => <div key={error} className="mt-1.5 max-w-[270px] text-[10.5px] leading-[1.4] text-danger">{error}</div>)}
                      </td>
                      <td className="px-3 py-3">
                        {item.warnings.length ? item.warnings.slice(0, 2).map((warning) => (
                          <div key={warning} className="mb-1 flex max-w-[260px] gap-1.5 text-[10.5px] leading-[1.4] text-warning-deep">
                            <AlertTriangle size={12} className="mt-0.5 shrink-0" aria-hidden /> {warning}
                          </div>
                        )) : <span className="text-[10.5px] text-faint">None recorded</span>}
                      </td>
                      <td className="px-4 py-3">
                        {item.status === "needs_review" ? (
                          <div className="flex justify-end gap-1.5">
                            <button
                              title="Reject source item"
                              onClick={() => setAction({ batchId: activeBatch.id, item, decision: "reject" })}
                              className="grid h-8 w-8 place-items-center rounded border border-line bg-card text-subtle hover:text-danger"
                            >
                              <X size={14} aria-hidden />
                            </button>
                            <button
                              title={item.validationErrors.length ? "Resolve source errors before accepting" : "Accept into draft review"}
                              disabled={item.validationErrors.length > 0}
                              onClick={() => setAction({ batchId: activeBatch.id, item, decision: "accept" })}
                              className="grid h-8 w-8 place-items-center rounded border border-ok/30 bg-ok-tint text-ok hover:border-ok disabled:cursor-not-allowed disabled:opacity-35"
                            >
                              <Check size={14} aria-hidden />
                            </button>
                          </div>
                        ) : <div className="text-right text-[10.5px] text-subtle">{item.reviewedAt ? new Date(item.reviewedAt).toLocaleDateString() : "Reviewed"}</div>}
                      </td>
                    </tr>
                  ))}
                  {!filteredItems.length && (
                    <tr><td colSpan={5} className="px-5 py-10 text-center text-[11.5px] text-subtle">No items match these filters.</td></tr>
                  )}
                </tbody>
              </table>
            </div>
          </>
        )}
      </div>

      <ConfirmDialog
        open={Boolean(action)}
        title={action?.decision === "accept" ? "Accept into the draft workflow?" : "Reject this source item?"}
        body={action?.decision === "accept"
          ? "This creates a non-approved pathway draft or pending product-label version. It cannot power patient guidance until a separate administrator approval or exact-label verification."
          : "The item will not be applied. Its immutable source record remains in the import history."}
        confirmLabel={action?.decision === "accept" ? "Accept as draft" : "Reject item"}
        destructive={action?.decision === "reject"}
        onCancel={() => setAction(null)}
        onConfirm={() => void review()}
      />
    </>
  );
}
