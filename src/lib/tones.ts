import type { Tone } from "@/adapters/types";

/**
 * Semantic tone → exact handoff colors. Components use these for
 * data-driven color (SVG strokes, chips, icon tiles); static layout colors
 * live in Tailwind classes backed by the same tokens.
 */
export const toneColor: Record<Tone, string> = {
  action: "#2563C7",
  teal: "#0E8388",
  positive: "#1F9D63",
  warning: "#C77E14",
  critical: "#D6544A",
  ai: "#7461C9",
  slate: "#5C6F82",
  navy: "#3D5A80",
};

export const toneTint: Record<Tone, string> = {
  action: "rgba(37,99,199,0.1)",
  teal: "rgba(14,131,136,0.1)",
  positive: "#E9F6EF",
  warning: "#FBF3E4",
  critical: "#FBEDEC",
  ai: "rgba(116,97,201,0.1)",
  slate: "#EEF2F6",
  navy: "#E8EEF5",
};

/** Deep text variants used on tinted chips (amber + violet read too light). */
export const toneText: Record<Tone, string> = {
  ...toneColor,
  warning: "#B45309",
  ai: "#5D4BB5",
};

/** Bright chart variant (health ring, radar, sleep line). */
export const toneBright: Record<Tone, string> = {
  ...toneColor,
  positive: "#22B573",
};
