/** Health-score ring — r=52, stroke 10, track #EDF2F6 (from the handoff). */
export function ScoreRing({
  value,
  band,
  color,
}: {
  value: number;
  band: string;
  color: string;
}) {
  const circumference = 2 * Math.PI * 52; // ≈ 326.7
  const dash = `${((value / 100) * circumference).toFixed(1)} ${circumference.toFixed(1)}`;
  return (
    <svg
      width="122"
      height="122"
      viewBox="0 0 128 128"
      role="img"
      aria-label={`Health score ${value} of 100, ${band.toLowerCase()}`}
      className="my-[6px] mb-[2px]"
    >
      <circle cx="64" cy="64" r="52" fill="none" stroke="#EDF2F6" strokeWidth="10" />
      <circle
        cx="64"
        cy="64"
        r="52"
        fill="none"
        stroke={color}
        strokeWidth="10"
        strokeLinecap="round"
        strokeDasharray={dash}
        transform="rotate(-90 64 64)"
      />
      <text
        x="64"
        y="64"
        textAnchor="middle"
        fontSize="32"
        fontWeight="700"
        fill="#182A3D"
        fontFamily="inherit"
      >
        {value}
      </text>
      <text
        x="64"
        y="84"
        textAnchor="middle"
        fontSize="12.5"
        fontWeight="600"
        fill="#5C6F82"
        fontFamily="inherit"
      >
        {band}
      </text>
    </svg>
  );
}
