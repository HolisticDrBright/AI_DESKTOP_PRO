export type ImportedLabRange = {
  value: number;
  referenceMin?: number | null;
  referenceMax?: number | null;
  functionalMin?: number | null;
  functionalMax?: number | null;
  sourceStatus?: string | null;
};

export type LabRangeStatus = "below" | "within" | "above" | "critical" | "unknown";

export function importedLabStatus(input: ImportedLabRange): {
  status: LabRangeStatus;
  label: string;
  basis: "functional" | "laboratory" | "source" | "none";
} {
  const functional = Number.isFinite(input.functionalMin) && Number.isFinite(input.functionalMax)
    && Number(input.functionalMax) >= Number(input.functionalMin);
  const low = functional ? Number(input.functionalMin) : input.referenceMin;
  const high = functional ? Number(input.functionalMax) : input.referenceMax;
  const basis = functional ? "functional" : (Number.isFinite(low) || Number.isFinite(high)) ? "laboratory" : "none";

  if (Number.isFinite(low) && input.value < Number(low)) {
    return { status: input.sourceStatus === "critical" ? "critical" : "below", label: functional ? "Below functional range" : "Below lab range", basis };
  }
  if (Number.isFinite(high) && input.value > Number(high)) {
    return { status: input.sourceStatus === "critical" ? "critical" : "above", label: functional ? "Above functional range" : "Above lab range", basis };
  }
  if (Number.isFinite(low) || Number.isFinite(high)) {
    return { status: "within", label: functional ? "Within functional range" : "Within lab range", basis };
  }

  const normalized = String(input.sourceStatus ?? "").toLowerCase();
  if (normalized === "critical") return { status: "critical", label: "Critical source flag", basis: "source" };
  if (normalized === "low") return { status: "below", label: "Low source flag", basis: "source" };
  if (normalized === "high") return { status: "above", label: "High source flag", basis: "source" };
  if (normalized === "normal" || normalized === "optimal") return { status: "within", label: "Within source range", basis: "source" };
  return { status: "unknown", label: "Range unavailable", basis: "none" };
}

export function rangeGeometry(input: ImportedLabRange): {
  resultPercent: number;
  referenceStartPercent: number | null;
  referenceWidthPercent: number | null;
  functionalStartPercent: number | null;
  functionalWidthPercent: number | null;
} {
  const bounds = [input.value, input.referenceMin, input.referenceMax, input.functionalMin, input.functionalMax]
    .filter((value): value is number => typeof value === "number" && Number.isFinite(value));
  if (bounds.length === 0) return { resultPercent: 50, referenceStartPercent: null, referenceWidthPercent: null, functionalStartPercent: null, functionalWidthPercent: null };
  let minimum = Math.min(...bounds);
  let maximum = Math.max(...bounds);
  const span = Math.max(maximum - minimum, Math.abs(maximum) * 0.2, 1);
  minimum -= span * 0.25;
  maximum += span * 0.25;
  const width = maximum - minimum;
  const position = (value: number) => Math.max(0, Math.min(100, ((value - minimum) / width) * 100));
  const segment = (low?: number | null, high?: number | null) => {
    if (!Number.isFinite(low) || !Number.isFinite(high) || Number(high) < Number(low)) return [null, null] as const;
    const start = position(Number(low));
    return [start, Math.max(position(Number(high)) - start, 1.5)] as const;
  };
  const [referenceStartPercent, referenceWidthPercent] = segment(input.referenceMin, input.referenceMax);
  const [functionalStartPercent, functionalWidthPercent] = segment(input.functionalMin, input.functionalMax);
  return { resultPercent: position(input.value), referenceStartPercent, referenceWidthPercent, functionalStartPercent, functionalWidthPercent };
}

export function rangeText(low?: number | null, high?: number | null): string {
  if (Number.isFinite(low) && Number.isFinite(high)) {
    return Number(low) === Number(high) ? `Target ${low}` : `${low}–${high}`;
  }
  if (Number.isFinite(low)) return `≥ ${low}`;
  if (Number.isFinite(high)) return `≤ ${high}`;
  return "Not provided";
}
