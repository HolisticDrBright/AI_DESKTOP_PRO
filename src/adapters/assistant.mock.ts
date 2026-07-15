import type { AssistantSession } from "./types";

/**
 * Demo assistant session from the design handoff. With a real backend this
 * becomes contextual to the open patient; Phase 1 ships the designed example.
 * Every AI output must show fact-vs-inference labels, sources used, date
 * range, missing information, and review status.
 */
export function getAssistantSession(): AssistantSession {
  return {
    patientName: "Alexandra Morgan",
    dataThrough: "Jul 12, 2026",
    chips: [
      "Why is her sleep score declining?",
      "Summarize labs since April",
      "Draft a follow-up note",
    ],
    question: "Why is her sleep score declining?",
    facts: [
      { text: "Sleep efficiency fell from 81% to 72% over the past 14 nights.", badge: "Measured", tone: "navy" },
      { text: "Sleep onset moved ~40 min later after Jun 28.", badge: "Measured", tone: "navy" },
      { text: "She reports increased evening work stress since late June.", badge: "Patient-reported", tone: "teal" },
      { text: "The pattern is consistent with stress-related sleep-onset delay rather than a sleep-maintenance problem.", badge: "AI inference", tone: "ai" },
    ],
    sources: ["Oura wearable · 30 d", "Labs · May 13", "Daily check-ins · 14 d", "Visit notes · 2"],
    missingInfo:
      "No evening cortisol data · check-ins missing 4 of last 14 days · room-temperature data unavailable.",
    reviewNotice: "Not reviewed — assistant output requires practitioner review.",
  };
}
