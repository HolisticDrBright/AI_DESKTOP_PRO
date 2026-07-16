import type { PracticeDashboardData, RightRailData } from "./types";

/** Practice-level mock data — exact values from the design handoff. */

export function getPracticeDashboard(): PracticeDashboardData {
  return {
    dateLine: "Tuesday, July 14, 2026 · 6 appointments today",
    statusLine: "All integrations connected · synced 2 min ago",
    stats: [
      { label: "Active clients", value: "48", sub: "+3 this month", subTone: "positive", icon: "users", tone: "action", href: "/practice" },
      { label: "Needing review", value: "7", sub: "2 urgent", subTone: "critical", icon: "tasks", tone: "warning", href: "/tasks" },
      { label: "New lab results", value: "5", sub: "3 abnormal", subTone: "warning", icon: "flask", tone: "critical", href: "/patients/p-78435/labs" },
      { label: "Active programs", value: "12", sub: "86% engaged", subTone: "slate", icon: "layers", tone: "teal", href: "/programs" },
      { label: "Overdue tasks", value: "4", sub: "oldest 6 d", subTone: "critical", icon: "clock", tone: "critical", href: "/tasks" },
      { label: "Appointments", value: "6", sub: "today", subTone: "slate", icon: "calendar", tone: "action", href: "/calendar" },
    ],
    queue: [
      { type: "Safety alert", title: "Ferritin 9 ng/mL — below lab range, iron protocol active", patient: "Priya Sharma", when: "35 min ago", priority: "High", href: "/patients/p-59318/summary" },
      { type: "Lab extraction", title: "Quest panel extracted — 2 markers low confidence", patient: "Alexandra Morgan", when: "1 h ago", priority: "High", href: "/patients/p-78435/labs" },
      { type: "Reasoning update", title: "New hypothesis: HPA-axis dysregulation (strength 74)", patient: "Alexandra Morgan", when: "2 h ago", priority: "Medium", href: "/patients/p-78435/reasoning" },
      { type: "Protocol approval", title: "Metabolic Reset Phase 3 awaiting sign-off", patient: "Michael Johnson", when: "Yesterday", priority: "Medium", href: "/tasks" },
      { type: "Experiment approval", title: "Berberine 500 mg experiment design ready for approval", patient: "Marcus Webb", when: "Yesterday", priority: "Low", href: "/patients/p-52984/nof1-lab" },
    ],
    queueOpenCount: 12,
    abnormal: [
      { marker: "Ferritin", value: "9 ng/mL", range: "16–154", tone: "critical", patient: "Priya Sharma", when: "Today" },
      { marker: "hs-CRP", value: "4.1 mg/L", range: "< 3.0", tone: "critical", patient: "Michael Johnson", when: "Today" },
      { marker: "HbA1c", value: "5.9 %", range: "4.0–5.6", tone: "warning", patient: "Marcus Webb", when: "Jul 12" },
      { marker: "Vitamin D", value: "24 ng/mL", range: "30–100", tone: "warning", patient: "Alexandra Morgan", when: "Jul 11" },
    ],
    experimentsDone: [
      { name: "Magnesium glycinate 300 mg", patient: "Jessica Parker", outcome: "Deep sleep +21 min avg", conclusion: "Likely beneficial", tone: "positive" },
      { name: "Late-caffeine withdrawal", patient: "Michael Johnson", outcome: "HRV +4 ms, within noise", conclusion: "Inconclusive", tone: "slate" },
      { name: "Cold exposure 3×/wk", patient: "Marcus Webb", outcome: "Energy score unchanged", conclusion: "No measurable effect", tone: "slate" },
    ],
    riskChanges: [
      { name: "Priya Sharma", initials: "PS", avatarColor: "#B45309", from: "Moderate", fromTone: "warning", to: "High", toTone: "critical", href: "/patients/p-59318/summary" },
      { name: "Alexandra Morgan", initials: "AM", avatarColor: "#0E8388", from: "High", fromTone: "critical", to: "Moderate", toTone: "warning", href: "/patients/p-78435/summary" },
      { name: "Jessica Parker", initials: "JP", avatarColor: "#5D4BB5", from: "Moderate", fromTone: "warning", to: "Low", toTone: "positive", href: "/patients/p-71126/summary" },
    ],
    lowAdherence: [
      { name: "Michael Johnson", pct: 46, tone: "critical", detail: "Supplements missed 8 of last 14 days" },
      { name: "Marcus Webb", pct: 58, tone: "warning", detail: "Check-ins stopped Jul 6" },
      { name: "Dana Whitfield", pct: 63, tone: "warning", detail: "Habit tracking incomplete" },
    ],
    teamWorkload: [
      { name: "Dr. Mitchell", initials: "SM", color: "#2563C7", pct: 78, open: 14 },
      { name: "K. Reyes, HC", initials: "KR", color: "#0E8388", pct: 52, open: 9 },
      { name: "T. Okafor, RD", initials: "TO", color: "#7461C9", pct: 34, open: 6 },
    ],
  };
}

export function getRightRail(): RightRailData {
  return {
    alerts: [
      { title: "New lab results available", sub: "Jul 11, 2026", icon: "flask", tone: "ai" },
      { title: "3 items await your review", sub: "Clinical reasoning updated", icon: "clipboard", tone: "critical" },
      { title: "Sleep experiment ready for review", sub: "7-day analysis complete", icon: "moon", tone: "action" },
      { title: "Vitamin D recheck recommended", sub: "Based on last labs", icon: "sun", tone: "warning" },
    ],
    tasks: [
      { title: "Review new lab results", who: "Alexandra Morgan", priority: "High" },
      { title: "Approve sleep protocol", who: "Alexandra Morgan", priority: "High" },
      { title: "Update supplement plan", who: "Michael Johnson", priority: "Medium" },
      { title: "Review assessment", who: "Jessica Parker", priority: "Low" },
    ],
    // Matches the base review-queue size (tasks.mock) so counts agree across surfaces.
    openTaskCount: 12,
    appointments: [
      { name: "Alexandra Morgan", when: "Jul 21, 2026 · 10:00 AM", initials: "AM", color: "#0E8388" },
      { name: "Michael Johnson", when: "Jul 21, 2026 · 11:00 AM", initials: "MJ", color: "#2563C7" },
      { name: "Jessica Parker", when: "Jul 21, 2026 · 2:00 PM", initials: "JP", color: "#7461C9" },
    ],
  };
}
