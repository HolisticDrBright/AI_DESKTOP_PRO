"use client";

import { createSessionStore } from "./session-kv";
import { importKnowledgePathwayDraft } from "./clinical-knowledge.mock";
import type {
  ImportedPathwayPayload,
  KnowledgeImportBatch,
  KnowledgeImportBundle,
  KnowledgeImportSourceItem,
} from "./clinical-import.types";

const store = createSessionStore<{ batches: KnowledgeImportBatch[] }>(
  "aidp:demo:clinical-knowledge-imports",
  { batches: [] },
);
const memoryPayloads = new Map<string, KnowledgeImportSourceItem[]>();

function savePayload(batchId: string, items: KnowledgeImportSourceItem[]) {
  memoryPayloads.set(batchId, items);
  if (typeof window === "undefined") return;
  try {
    window.sessionStorage.setItem(
      `aidp:demo:clinical-import-payload:${batchId}`,
      JSON.stringify(items),
    );
  } catch {
    /* Keep the in-memory copy when browser session storage is unavailable. */
  }
}

function readPayload(batchId: string) {
  const memory = memoryPayloads.get(batchId);
  if (memory) return memory;
  if (typeof window === "undefined") return [];
  try {
    return JSON.parse(
      window.sessionStorage.getItem(`aidp:demo:clinical-import-payload:${batchId}`) ?? "[]",
    ) as KnowledgeImportSourceItem[];
  } catch {
    return [];
  }
}

function validate(item: KnowledgeImportSourceItem): string[] {
  const payload = item.payload;
  const errors: string[] = [];
  if (item.entityType === "pathway") {
    const content = payload.content as Record<string, unknown> | undefined;
    if (!String(payload.code ?? "").trim()) errors.push("Pathway code is required");
    if (!String(payload.name ?? "").trim()) errors.push("Pathway name is required");
    if (!String(payload.domainCode ?? "").trim()) errors.push("Pathway domain is required");
    if (!content || typeof content !== "object") errors.push("Pathway content must be an object");
    for (const key of ["differentiatingQuestions", "labStrategy", "productCandidates", "safetyStops"]) {
      if (!Array.isArray(content?.[key])) errors.push(`${key} must be an array`);
    }
  } else {
    const label = payload.exactLabel as Record<string, unknown> | undefined;
    if (!String(payload.productCode ?? "").trim()) errors.push("Product code is required");
    if (!String(payload.productName ?? "").trim()) errors.push("Product name is required");
    if (!String(payload.brand ?? "").trim()) errors.push("Product brand is required");
    if (!label || typeof label !== "object") errors.push("Exact product label must be an object");
    if (!String(label?.ingredients ?? "").trim()) errors.push("Ingredient amounts and units are required");
    if (!String(label?.servingSize ?? "").trim()) errors.push("Serving size is required");
    if (!String(payload.sourceUrl ?? "").trim()) errors.push("Current manufacturer label URL is required");
  }
  return errors;
}

function mockHash(value: string) {
  return value.padEnd(64, "0").slice(0, 64);
}

export function useMockKnowledgeImports() {
  return store.use().batches;
}

export function getMockKnowledgeImports() {
  return store.get().batches;
}

export function stageMockKnowledgeImport(bundle: KnowledgeImportBundle) {
  const now = new Date().toISOString();
  const batchId = `kb-${Date.now()}`;
  const batch: KnowledgeImportBatch = {
    id: batchId,
    sourceName: bundle.sourceName,
    sourceRevision: bundle.sourceRevision ?? null,
    schemaVersion: bundle.schemaVersion,
    sourceSha256: mockHash(batchId),
    status: "in_review",
    itemCount: bundle.items.length,
    noPhiAttestedAt: now,
    createdAt: now,
    items: bundle.items.map((item, index) => ({
      id: `${batchId}-item-${index + 1}`,
      entityType: item.entityType,
      externalKey: item.externalKey,
      displayName: item.displayName,
      sourceSheet: item.sourceSheet ?? null,
      payloadSha256: mockHash(`${batchId}-${index}`),
      warnings: item.warnings.filter(Boolean),
      validationErrors: validate(item),
      status: "needs_review",
      createdAt: now,
    })),
  };
  savePayload(batchId, bundle.items);
  store.update((state) => ({ batches: [batch, ...state.batches] }));
  return batch;
}

export function reviewMockKnowledgeImportItem(
  batchId: string,
  itemId: string,
  decision: "accept" | "reject",
) {
  const batch = store.get().batches.find((item) => item.id === batchId);
  const item = batch?.items.find((entry) => entry.id === itemId);
  if (!batch || !item || item.status !== "needs_review") throw new Error("Import item is no longer reviewable.");
  if (decision === "accept" && item.validationErrors.length) {
    throw new Error("Resolve validation errors in the source and re-import before accepting this item.");
  }
  if (decision === "accept" && item.entityType === "pathway") {
    const source = readPayload(batchId);
    const sourceItem = source.find((entry) => entry.externalKey === item.externalKey);
    if (sourceItem) importKnowledgePathwayDraft(sourceItem.payload as unknown as ImportedPathwayPayload);
  }
  store.update((state) => ({
    batches: state.batches.map((currentBatch) => {
      if (currentBatch.id !== batchId) return currentBatch;
      const items = currentBatch.items.map((entry) => entry.id !== itemId ? entry : {
        ...entry,
        status: decision === "accept" ? "applied" as const : "rejected" as const,
        reviewedAt: new Date().toISOString(),
        appliedRefType: decision === "accept"
          ? (entry.entityType === "pathway" ? "clinical_pathway_version" : "product_label_version")
          : null,
      });
      return {
        ...currentBatch,
        items,
        status: items.some((entry) => entry.status === "needs_review") ? "in_review" : "completed",
        completedAt: items.some((entry) => entry.status === "needs_review")
          ? null
          : new Date().toISOString(),
      };
    }),
  }));
}

export function resetMockKnowledgeImports() {
  for (const batch of store.get().batches) {
    memoryPayloads.delete(batch.id);
    if (typeof window !== "undefined") {
      try {
        window.sessionStorage.removeItem(`aidp:demo:clinical-import-payload:${batch.id}`);
      } catch {
        /* Session storage is optional in the demo. */
      }
    }
  }
  store.set({ batches: [] });
}
