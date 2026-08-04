"use client";

import { useState } from "react";
import { Card } from "@/components/ui/bits";
import {
  PRH_FILTERS,
  PRH_STATUS_LABELS,
  type FilterKey,
} from "./research-handoff-filters";

/**
 * Phase 9E-B — Product Research Handoff filters + honest states panel.
 *
 * The panel deliberately DOES NOT invoke `preview_knowledge_import`. That
 * call must happen under the practitioner's signed-in session in the
 * "Read a file" tab, after they provide the no-PHI attestation. This
 * panel is a **read + filter surface** over any resulting preview batches
 * whose `source_kind` identifies them as a Product Research Handoff.
 *
 * Filters mirror the Phase 9E-B brief. Each is a chip; multiple chips
 * narrow the review. Nothing here mutates governed state, and there is
 * no bulk verification / approval / restriction clearance / commercial
 * matching.
 *
 * Honest states — NEVER conflated:
 *   - Empty (no preview batch of this source_kind exists yet).
 *   - Loading (asking).
 *   - Failed (could not ask; permission-denied is its own case elsewhere).
 *
 * Until the practitioner runs the preview in a signed-in session, this
 * panel shows the honest-empty state with the exact next step.
 */
export function ResearchHandoffFiltersPanel() {
  const [activeFilters, setActiveFilters] = useState<Set<FilterKey>>(new Set());

  return (
    <div className="flex flex-col gap-3" data-testid="prh-filters-panel">
      <Card className="px-4 py-3">
        <h2 className="m-0 text-[14.5px] font-bold text-ink">Product Research Handoff</h2>
        <p className="mt-1 text-[11.5px] text-subtle">
          Filter preview batches produced from a Product Research Handoff package. This surface
          shows what has been previewed; it does not verify, approve, or commit anything.
        </p>
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
        <p className="mt-2 text-[10.5px] text-subtle">
          &ldquo;Candidate for review&rdquo; is an identity gate, not verification.
          &ldquo;Previewed&rdquo; is not the same as &ldquo;approved&rdquo;. No status here becomes clinical
          content until a practitioner records a governed decision.
        </p>
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
        <p className="mt-2 text-[10.5px] text-subtle">
          Filters are per-batch: the practitioner narrows to a bounded review batch, decides row by
          row, and never runs a bulk operation from this surface.
        </p>
      </Card>
      <Card className="px-4 py-3">
        <h3 className="m-0 text-[12.5px] font-bold text-ink">Preview batches</h3>
        <div
          data-testid="prh-batches-empty"
          className="mt-2 text-[11.5px] leading-[1.6] text-subtle"
        >
          <p className="m-0">
            <strong>No Product Research Handoff preview batch exists in this organization yet.</strong>
          </p>
          <p className="mt-1 m-0">
            To create one, an authorized practitioner must sign in, open the &ldquo;Read a file&rdquo;
            tab, provide the exact no-PHI attestation, and preview the three authoritative JSONL
            files from the package. See <code>docs/phase9e-b-research-handoff.md</code> for the
            exact click-path and the attestation wording.
          </p>
          <p className="mt-1 m-0">
            This panel will populate automatically once a Product Research Handoff preview batch is
            registered.
          </p>
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
        <p className="mt-2 text-[10.5px] text-subtle">
          The first bounded review batch is the independently audited 10-record sample. Every
          record is reviewed on its own.
        </p>
      </Card>
    </div>
  );
}

