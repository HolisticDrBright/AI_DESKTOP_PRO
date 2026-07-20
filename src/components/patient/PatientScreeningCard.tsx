"use client";

import Link from "next/link";
import { ClipboardList } from "lucide-react";
import { useAssessmentsState } from "@/adapters/assessments.mock";
import type { Tone } from "@/adapters/types";
import { Card, CardTitle } from "@/components/ui/bits";
import type { CategoryScreeningScore } from "@/lib/registry";
import { toneText, toneTint } from "@/lib/tones";

const BAND_TONE: Record<CategoryScreeningScore["band"], Tone> = {
  elevated: "critical",
  moderate: "warning",
  "below-threshold": "positive",
  insufficient_data: "slate",
};

const BAND_LABEL: Record<CategoryScreeningScore["band"], string> = {
  elevated: "Elevated",
  moderate: "Moderate",
  "below-threshold": "Below threshold",
  insufficient_data: "Needs more answers",
};

/**
 * Latest screening submission on the patient chart (demo session). Shows the
 * top symptom-pattern bands with provenance; links into the review workspace.
 * Renders nothing until this patient has a submission this session.
 */
export function PatientScreeningCard({ patientId }: { patientId: string }) {
  const { submissions } = useAssessmentsState();
  const latest = submissions.find((s) => s.patientId === patientId);
  if (!latest) return null;

  const top = [...latest.categories]
    .sort((a, b) => {
      const rank = { elevated: 0, moderate: 1, insufficient_data: 2, "below-threshold": 3 } as const;
      return rank[a.band] - rank[b.band] || (b.percent ?? 0) - (a.percent ?? 0);
    })
    .slice(0, 6);

  return (
    <div data-testid="patient-screening-card">
    <Card className="p-4">
      <CardTitle className="mb-2">
        <ClipboardList size={15} strokeWidth={1.75} className="text-ink-3" aria-hidden />
        Symptom-pattern screening (latest submission)
      </CardTitle>
      <p className="mb-2 text-[11.5px] text-ink-3">
        Submitted {new Date(latest.submittedAt).toLocaleString()} ·{" "}
        {latest.reviewState === "reviewed" ? "reviewed" : "pending practitioner review"} · scoring{" "}
        {latest.scoringVersion} · content {latest.contentHash.slice(0, 8)}…
      </p>
      <ul className="grid gap-1 sm:grid-cols-2">
        {top.map((c) => (
          <li key={c.categoryId} className="flex items-center justify-between gap-2 text-[12px]">
            <span className="truncate text-ink-1">{c.categoryName}</span>
            <span className="flex items-center gap-1.5">
              <span className="font-bold tabular-nums text-ink-1">
                {c.rounded === null ? "—" : c.rounded}
              </span>
              <span
                className="rounded-full px-[7px] py-px text-[10px] font-semibold whitespace-nowrap"
                style={{ color: toneText[BAND_TONE[c.band]], background: toneTint[BAND_TONE[c.band]] }}
              >
                {BAND_LABEL[c.band]}
              </span>
            </span>
          </li>
        ))}
      </ul>
      <p className="mt-2 text-[11.5px]">
        <Link href="/assessments" className="font-semibold text-action hover:underline">
          Open assessments workspace →
        </Link>
      </p>
    </Card>
    </div>
  );
}
