"use client";

import { useState } from "react";
import { Card } from "@/components/ui/bits";
import {
  PRH_FILTERS,
  PRH_STATUS_LABELS,
  type FilterKey,
} from "./research-handoff-filters";

/**
 * Phase 9E-B — Product Research Handoff filters + upload panel.
 *
 * The panel offers a bounded four-file upload (manifest + 3 JSONLs) that
 * hits the /api/live/knowledge/research-handoff route under the caller's
 * signed-in practitioner session. The no-PHI attestation is a required
 * checkbox — never defaulted, never synthesized.
 *
 * On success the panel displays the three batch identifiers + safe
 * aggregate counts. On refusal (any category returned by the server) the
 * panel shows an honest error with the PHI-safe category and no raw
 * content.
 *
 * Nothing here mutates a governed row; the /research-handoff endpoint
 * only calls `preview_research_handoff` which returns preview batches.
 * Bulk verification / approval / restriction clearance / commercial
 * matching / conflict resolution are structurally refused elsewhere.
 */
export function ResearchHandoffFiltersPanel() {
  const [activeFilters, setActiveFilters] = useState<Set<FilterKey>>(new Set());
  const [manifestFile, setManifestFile] = useState<File | null>(null);
  const [clinicalFile, setClinicalFile] = useState<File | null>(null);
  const [commercialFile, setCommercialFile] = useState<File | null>(null);
  const [evidenceFile, setEvidenceFile] = useState<File | null>(null);
  const [attest, setAttest] = useState(false);
  const [state, setState] = useState<"idle" | "submitting" | "success" | "failed">("idle");
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<null | PreviewResult>(null);

  const canSubmit =
    !!manifestFile && !!clinicalFile && !!commercialFile && !!evidenceFile && attest && state !== "submitting";

  const submit = async () => {
    setState("submitting");
    setError(null);
    try {
      const form = new FormData();
      form.set("attestNoPhi", "true");
      form.set("manifest", manifestFile!);
      form.set("clinical", clinicalFile!);
      form.set("commercial", commercialFile!);
      form.set("evidence", evidenceFile!);
      const res = await fetch("/api/live/knowledge/research-handoff", {
        method: "POST",
        body: form,
      });
      const text = await res.text();
      if (!res.ok) {
        // The server returns a PHI-safe category string in a wrapped
        // envelope. Show it verbatim; it never carries raw content.
        let category = "preview_failed";
        try {
          const parsed = JSON.parse(text);
          category = parsed?.error?.message ?? parsed?.message ?? "preview_failed";
        } catch {
          /* keep default */
        }
        setError(category);
        setState("failed");
        return;
      }
      const parsed = JSON.parse(text) as PreviewResult;
      setResult(parsed);
      setState("success");
    } catch (e) {
      setError(e instanceof Error ? e.message : "preview_failed");
      setState("failed");
    }
  };

  return (
    <div className="flex flex-col gap-3" data-testid="prh-filters-panel">
      <Card className="px-4 py-3">
        <h2 className="m-0 text-[14.5px] font-bold text-ink">Product Research Handoff</h2>
        <p className="mt-1 text-[11.5px] text-subtle">
          Preview a Product Research Handoff package (manifest + three authoritative JSONL files).
          The upload validates the package against the manifest before any batch is created, and
          the three previews are atomic — either all three are created or none.
        </p>
      </Card>

      <Card className="px-4 py-3">
        <h3 className="m-0 text-[12.5px] font-bold text-ink">1. Select the four files</h3>
        <p className="mt-1 text-[10.5px] text-subtle">
          Only the files you explicitly pick here are read. Nothing else on your disk is inspected.
        </p>
        <div className="mt-2 flex flex-col gap-2">
          <PrhFileField
            id="prh-manifest"
            label="handoff-manifest.json"
            accept="application/json,.json"
            file={manifestFile}
            onChange={setManifestFile}
          />
          <PrhFileField
            id="prh-clinical"
            label="product-label-enrichment.jsonl"
            accept=".jsonl,application/jsonl,application/x-ndjson"
            file={clinicalFile}
            onChange={setClinicalFile}
          />
          <PrhFileField
            id="prh-commercial"
            label="commercial-links.jsonl"
            accept=".jsonl,application/jsonl,application/x-ndjson"
            file={commercialFile}
            onChange={setCommercialFile}
          />
          <PrhFileField
            id="prh-evidence"
            label="evidence-sources.jsonl"
            accept=".jsonl,application/jsonl,application/x-ndjson"
            file={evidenceFile}
            onChange={setEvidenceFile}
          />
        </div>
      </Card>

      <Card className="px-4 py-3">
        <h3 className="m-0 text-[12.5px] font-bold text-ink">2. Practitioner attestation</h3>
        <label className="mt-2 flex items-start gap-2 text-[11.5px] leading-[1.5] text-body">
          <input
            type="checkbox"
            data-testid="prh-attest-checkbox"
            checked={attest}
            onChange={(e) => setAttest(e.target.checked)}
          />
          <span>
            I attest that the Product Research Handoff package I am about to preview contains no
            patient health information, no patient identifiers, and no data that could re-identify
            a patient. It contains only public product-label research and public commercial-link
            data.
          </span>
        </label>
      </Card>

      <Card className="px-4 py-3">
        <h3 className="m-0 text-[12.5px] font-bold text-ink">3. Preview</h3>
        <div className="mt-2 flex flex-wrap items-center gap-2">
          <button
            type="button"
            data-testid="prh-submit"
            onClick={submit}
            disabled={!canSubmit}
            className={
              "h-8 rounded-lg px-3 text-[12.5px] font-semibold " +
              (canSubmit
                ? "bg-action text-white hover:bg-action-strong"
                : "border border-line bg-card text-faint")
            }
          >
            {state === "submitting" ? "Previewing…" : "Preview package"}
          </button>
          <span className="text-[10.5px] text-subtle">
            Preview only. Nothing is verified, approved, activated, or attached.
          </span>
        </div>
        {state === "failed" && (
          <div
            data-testid="prh-preview-failed"
            role="alert"
            className="mt-2 rounded border border-critical/25 bg-critical-tint px-3 py-2 text-[11.5px] text-critical-deep"
          >
            {error ?? "preview_failed"}
          </div>
        )}
        {state === "success" && result && (
          <div
            data-testid="prh-preview-success"
            className="mt-2 rounded border border-ok/25 bg-ok-tint px-3 py-2 text-[11.5px] leading-[1.5] text-ok-deep"
          >
            <div className="font-bold">Preview created. No governed content changed.</div>
            <ul className="mt-1 flex flex-col gap-0.5 pl-4">
              <li>
                Clinical batch: <code data-testid="prh-batch-clinical">{result.clinical.batchId}</code> —{" "}
                {result.clinical.itemCount} items{" "}
                {result.clinical.idempotent && "(existing — idempotent retry)"}
              </li>
              <li>
                Evidence batch: <code data-testid="prh-batch-evidence">{result.evidence.batchId}</code> —{" "}
                {result.evidence.itemCount} items{" "}
                {result.evidence.idempotent && "(existing — idempotent retry)"}
              </li>
              <li>
                Commercial batch: <code data-testid="prh-batch-commercial">{result.commercial.batchId}</code> —{" "}
                {result.commercial.itemCount} items (commercial_only=true){" "}
                {result.commercial.idempotent && "(existing — idempotent retry)"}
              </li>
              <li>
                Manifest sha256: <code>{result.manifestSha256.slice(0, 12)}…</code>
              </li>
            </ul>
            <div className="mt-1 text-[10.5px] text-subtle">
              Identity: exact {result.aggregates.identityCounts.exact ?? 0} / probable{" "}
              {result.aggregates.identityCounts.probable ?? 0} / ambiguous{" "}
              {result.aggregates.identityCounts.ambiguous ?? 0} / unmatched{" "}
              {result.aggregates.identityCounts.unmatched ?? 0}. Candidates{" "}
              {result.aggregates.labelVerificationCandidateCount}. Supplement-Facts complete{" "}
              {result.aggregates.supplementFactsCompleteCount}. Unresolved{" "}
              {result.aggregates.unresolvedTotal}.
            </div>
          </div>
        )}
      </Card>

      <Card className="px-4 py-3">
        <h3 className="m-0 text-[12.5px] font-bold text-ink">Practitioner status legend</h3>
        <ul className="mt-2 flex flex-wrap gap-1.5 text-[11px]">
          {(["previewed", "unresolved", "candidate", "verified", "approved", "matched"] as const).map((k) => (
            <li
              key={k}
              data-testid={`prh-status-legend-${k}`}
              className="rounded border border-line px-2 py-1 text-subtle"
            >
              {PRH_STATUS_LABELS[k]}
            </li>
          ))}
        </ul>
      </Card>

      <Card className="px-4 py-3">
        <h3 className="m-0 text-[12.5px] font-bold text-ink">Filters</h3>
        <div
          className="mt-2 flex flex-wrap gap-1.5"
          role="group"
          aria-label="Product Research Handoff filters"
          data-testid="prh-filter-group"
        >
          {PRH_FILTERS.map((f) => {
            const active = activeFilters.has(f.key);
            return (
              <button
                key={f.key}
                type="button"
                data-testid={`prh-filter-${f.key}`}
                aria-pressed={active}
                onClick={() => {
                  const next = new Set(activeFilters);
                  if (next.has(f.key)) next.delete(f.key);
                  else next.add(f.key);
                  setActiveFilters(next);
                }}
                className={
                  "h-7 cursor-pointer rounded-full border px-3 text-[11px] font-semibold " +
                  (active
                    ? "border-transparent bg-action text-white"
                    : "border-line bg-card text-body hover:border-line-hover")
                }
              >
                {f.label}
              </button>
            );
          })}
        </div>
      </Card>

      <Card className="px-4 py-3">
        <h3 className="m-0 text-[12.5px] font-bold text-ink">Bulk operations are refused</h3>
        <ul
          className="mt-2 flex flex-col gap-1 pl-4 text-[11px] leading-[1.5] text-subtle"
          data-testid="prh-bulk-refusals"
        >
          <li>Bulk label verification — refused.</li>
          <li>Bulk restriction clearance — refused.</li>
          <li>Bulk clinical approval — refused.</li>
          <li>Bulk commercial attachment — refused.</li>
          <li>Bulk conflict resolution — refused.</li>
        </ul>
      </Card>
    </div>
  );
}

type PreviewResult = {
  ok: true;
  manifestSha256: string;
  clinical: { batchId: string; itemCount: number; idempotent: boolean };
  evidence: { batchId: string; itemCount: number; idempotent: boolean };
  commercial: { batchId: string; itemCount: number; idempotent: boolean };
  aggregates: {
    clinicalCount: number;
    commercialCount: number;
    evidenceCount: number;
    identityCounts: Record<string, number>;
    supplementFactsCompleteCount: number;
    labelVerificationCandidateCount: number;
    unresolvedResearched: number;
    unresolvedTotal: number;
  };
};

function PrhFileField(props: {
  id: string;
  label: string;
  accept: string;
  file: File | null;
  onChange: (f: File | null) => void;
}) {
  return (
    <div className="flex items-center gap-2 text-[11.5px] text-body">
      <label
        htmlFor={props.id}
        className="min-w-[230px] font-semibold"
        data-testid={`${props.id}-label`}
      >
        {props.label}
      </label>
      <input
        type="file"
        id={props.id}
        data-testid={props.id}
        accept={props.accept}
        onChange={(e) => props.onChange(e.target.files?.[0] ?? null)}
      />
      {props.file && (
        <span className="text-subtle" data-testid={`${props.id}-status`}>
          {props.file.name} ({props.file.size} B)
        </span>
      )}
    </div>
  );
}
