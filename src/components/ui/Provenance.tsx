"use client";

import { ExternalLink, TriangleAlert } from "lucide-react";
import type {
  ProvenanceData,
  ProvenanceSourceType,
  ReviewState,
  Tone,
} from "@/adapters/types";
import { cn } from "@/lib/cn";
import { toneText, toneTint } from "@/lib/tones";

/**
 * Provenance & confidence chip/panel — reusable across patient summary,
 * clinical reasoning, labs, Health Twin, supplements, N-of-1 and assistant
 * output. Every field is text-labelled; color is a reinforcement, never the
 * sole signal (accessibility + clinical-safety requirement).
 */

export type { ProvenanceData, ProvenanceSourceType, ReviewState };

/** Source type → binding semantic tone + human label. */
export const SOURCE_META: Record<ProvenanceSourceType, { tone: Tone; label: string }> = {
  measured: { tone: "navy", label: "Measured" },
  "patient-reported": { tone: "teal", label: "Patient-reported" },
  "practitioner-confirmed": { tone: "action", label: "Practitioner-confirmed" },
  "ai-inference": { tone: "ai", label: "AI inference" },
  "published-evidence": { tone: "slate", label: "Published evidence" },
  "imported-record": { tone: "warning", label: "Imported record" },
};

const REVIEW_META: Record<ReviewState, { tone: Tone; label: string }> = {
  reviewed: { tone: "positive", label: "Reviewed" },
  "awaiting-review": { tone: "warning", label: "Awaiting review" },
  "not-reviewed": { tone: "warning", label: "Not reviewed" },
};

/** Small inline provenance badge (source type only). */
export function ProvenanceBadge({ sourceType }: { sourceType: ProvenanceSourceType }) {
  const m = SOURCE_META[sourceType];
  return (
    <span
      className="inline-flex items-center rounded-[4px] px-[5px] py-px text-[9.5px] font-bold"
      style={{ color: toneText[m.tone], background: toneTint[m.tone] }}
    >
      {m.label}
    </span>
  );
}

/** Full provenance row — a compact, wrap-friendly strip of labelled facts. */
export function Provenance({
  data,
  onOpenSource,
  className,
}: {
  data: ProvenanceData;
  /** When set, an "Open source" affordance is shown. */
  onOpenSource?: () => void;
  className?: string;
}) {
  const src = SOURCE_META[data.sourceType];
  const review = data.review ? REVIEW_META[data.review] : null;

  return (
    <div
      className={cn(
        "flex flex-wrap items-center gap-x-3 gap-y-[6px] text-[11px] text-subtle",
        className,
      )}
    >
      <span className="flex items-center gap-[6px]">
        <span className="text-faint">Source</span>
        <span
          className="rounded-[4px] px-[5px] py-px text-[10px] font-bold"
          style={{ color: toneText[src.tone], background: toneTint[src.tone] }}
        >
          {src.label}
        </span>
        {data.sourceName && <span className="font-semibold text-body">{data.sourceName}</span>}
      </span>

      {data.dateRange && (
        <span>
          <span className="text-faint">Range</span> {data.dateRange}
        </span>
      )}
      {data.lastUpdated && (
        <span>
          <span className="text-faint">Updated</span> {data.lastUpdated}
        </span>
      )}

      {typeof data.confidence === "number" && (
        <span className="flex items-center gap-[5px]">
          <span className="text-faint">Completeness</span>
          <span className="font-semibold text-body">{data.confidence}%</span>
          <span
            className="h-[4px] w-[36px] overflow-hidden rounded-full bg-track"
            role="img"
            aria-label={`Data completeness ${data.confidence} percent`}
          >
            <span
              className="block h-full rounded-full"
              style={{
                width: `${data.confidence}%`,
                background:
                  data.confidence >= 70 ? toneText.positive : data.confidence >= 40 ? toneText.warning : toneText.critical,
              }}
            />
          </span>
        </span>
      )}

      {typeof data.conflicts === "number" && data.conflicts > 0 && (
        <span className="flex items-center gap-[4px] font-semibold text-critical">
          <TriangleAlert size={11} strokeWidth={2} aria-hidden />
          {data.conflicts} {data.conflicts === 1 ? "conflict" : "conflicts"}
        </span>
      )}

      {review && (
        <span
          className="rounded-full px-[7px] py-px text-[10px] font-semibold"
          style={{ color: toneText[review.tone], background: toneTint[review.tone] }}
        >
          {review.label}
        </span>
      )}

      {onOpenSource && (
        <button
          onClick={onOpenSource}
          className="flex items-center gap-[4px] font-semibold text-action hover:text-action-deep focus-visible:outline-2 focus-visible:outline-action"
        >
          <ExternalLink size={11} strokeWidth={2} aria-hidden />
          Open source
        </button>
      )}
    </div>
  );
}
