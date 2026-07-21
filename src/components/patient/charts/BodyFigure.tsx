import type { BodyPose } from "@/adapters/charts.mock";

const POSE_LABEL: Record<BodyPose, string> = {
  left: "Left",
  back: "Posterior",
  front: "Anterior",
  right: "Right",
};

/** A single neutral humanoid silhouette in a 0–120 × 0–300 viewBox. */
function Figure() {
  return (
    <g fill="none" stroke="#33475c" strokeWidth={2.4} strokeLinejoin="round">
      {/* head + neck */}
      <ellipse cx={60} cy={24} rx={15} ry={18} />
      <path d="M53 40 v9 M67 40 v9" />
      {/* torso: shoulders tapering to waist */}
      <path d="M40 52 Q60 44 80 52 L74 120 Q60 126 46 120 Z" />
      {/* arms */}
      <path d="M40 54 Q28 60 27 96 Q27 116 32 124" />
      <path d="M80 54 Q92 60 93 96 Q93 116 88 124" />
      <ellipse cx={30} cy={131} rx={5} ry={7} />
      <ellipse cx={90} cy={131} rx={5} ry={7} />
      {/* pelvis */}
      <path d="M46 120 Q60 130 74 120 L72 150 Q60 156 48 150 Z" />
      {/* legs */}
      <path d="M49 150 Q46 210 50 262 Q52 274 58 274 L60 156" />
      <path d="M71 150 Q74 210 70 262 Q68 274 62 274 L60 156" />
      {/* feet */}
      <ellipse cx={54} cy={280} rx={8} ry={5} />
      <ellipse cx={66} cy={280} rx={8} ry={5} />
    </g>
  );
}

/** Row of body figures used as the non-interactive background for a diagram. */
export function BodyFigures({ poses }: { poses: BodyPose[] }) {
  return (
    <div className="pointer-events-none flex h-full w-full items-stretch justify-around gap-2 px-2">
      {poses.map((pose, i) => (
        <div key={`${pose}-${i}`} className="flex min-w-0 flex-1 flex-col items-center">
          <svg
            viewBox="0 0 120 300"
            className="h-full w-full"
            preserveAspectRatio="xMidYMid meet"
            aria-hidden
          >
            <Figure />
          </svg>
          <span className="mt-1 text-[10px] font-medium text-faint">{POSE_LABEL[pose]}</span>
        </div>
      ))}
    </div>
  );
}
