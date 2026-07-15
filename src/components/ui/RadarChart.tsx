import type { SystemAxis } from "@/adapters/types";

/**
 * Octagonal system-balance radar. Geometry mirrors the design prototype:
 * viewBox 252×186 rendered at 238×176, center (126, 95), radius 62.
 */
export function RadarChart({ axes }: { axes: SystemAxis[] }) {
  const cx = 126;
  const cy = 95;
  const R = 62;

  const pt = (i: number, r: number): [number, number] => {
    const a = (Math.PI * 2 * i) / axes.length - Math.PI / 2;
    return [cx + Math.cos(a) * r, cy + Math.sin(a) * r];
  };
  const ring = (f: number) =>
    axes
      .map((_, i) =>
        pt(i, R * f)
          .map((n) => n.toFixed(1))
          .join(","),
      )
      .join(" ");
  const points = axes
    .map((a, i) =>
      pt(i, R * a.value)
        .map((n) => n.toFixed(1))
        .join(","),
    )
    .join(" ");

  const weakest = [...axes]
    .sort((a, b) => a.value - b.value)
    .slice(0, 2)
    .map((a) => a.label.toLowerCase());

  return (
    <svg
      width="238"
      height="176"
      viewBox="0 0 252 186"
      role="img"
      aria-label={`Systems balance radar across ${axes.length} health domains; ${weakest.join(" and ")} are the weakest.`}
    >
      <g>
        {[0.33, 0.66, 1].map((f) => (
          <polygon key={f} points={ring(f)} fill="none" stroke="#E4EAF1" strokeWidth="1" />
        ))}
      </g>
      <g>
        {axes.map((_, i) => {
          const [x, y] = pt(i, R);
          return <line key={i} x1={cx} y1={cy} x2={x} y2={y} stroke="#EDF2F6" strokeWidth="1" />;
        })}
      </g>
      <polygon
        points={points}
        fill="rgba(34,181,115,0.14)"
        stroke="#22B573"
        strokeWidth="1.75"
        strokeLinejoin="round"
      />
      <g>
        {axes.map((a, i) => {
          const [x, y] = pt(i, R * a.value);
          return <circle key={i} cx={x} cy={y} r="2.2" fill="#22B573" />;
        })}
      </g>
      <g>
        {axes.map((a, i) => {
          const [x, y] = pt(i, R + 14);
          return (
            <text
              key={i}
              x={x}
              y={y + 3}
              textAnchor="middle"
              fontSize="9.5"
              fontWeight="600"
              fill="#7288A1"
              fontFamily="inherit"
            >
              {a.label}
            </text>
          );
        })}
      </g>
    </svg>
  );
}
