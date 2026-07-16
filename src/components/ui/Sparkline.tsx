/** Fluid sparkline. Multi-point math mirrors the design prototype exactly. */
export function sparklinePoints(vals: number[], w: number, h: number): string {
  if (vals.length === 0) return "";
  const min = Math.min(...vals);
  const max = Math.max(...vals);
  const rng = max - min || 1;
  const y = (v: number) => h - 3 - ((v - min) / rng) * (h - 6);
  // A single reading has no trend — a flat segment, not NaN from i/(len-1).
  if (vals.length === 1) return `2,${y(vals[0])} ${w - 2},${y(vals[0])}`;
  return vals
    .map((v, i) => `${(i / (vals.length - 1)) * (w - 4) + 2},${y(v)}`)
    .join(" ");
}

export function Sparkline({
  values,
  width,
  height,
  stroke,
  strokeWidth,
  label,
  className,
}: {
  values: number[];
  width: number;
  height: number;
  stroke: string;
  strokeWidth: number;
  label: string;
  className?: string;
}) {
  return (
    <svg
      width="100%"
      height={height}
      viewBox={`0 0 ${width} ${height}`}
      preserveAspectRatio="none"
      className={className}
      role="img"
      aria-label={label}
    >
      <polyline
        points={sparklinePoints(values, width, height)}
        fill="none"
        stroke={stroke}
        strokeWidth={strokeWidth}
        strokeLinecap="round"
        strokeLinejoin="round"
        vectorEffect="non-scaling-stroke"
      />
    </svg>
  );
}
