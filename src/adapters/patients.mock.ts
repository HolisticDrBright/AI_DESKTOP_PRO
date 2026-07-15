import type {
  PatientDirectoryEntry,
  PatientSummary,
} from "./types";

/**
 * Synthetic patient records only — no real health information.
 * Alexandra Morgan carries the exact flagship dataset from the design
 * handoff; the other records are derived from the practice-dashboard
 * mock data so cross-links stay coherent.
 */

const directory: PatientDirectoryEntry[] = [
  {
    id: "p-78435",
    mrn: "P-78435",
    name: "Alexandra Morgan",
    initials: "AM",
    sex: "Female",
    age: 34,
    dob: "04/12/1992",
    avatarGradient: ["#0E8388", "#3BA5A5"],
    primaryGoals:
      "Improve energy, sleep quality, hormone balance, reduce inflammation",
    careTeam: ["Dr. Sarah Mitchell (You)", "Holistic Health Coach · Registered Dietitian"],
    lastVisit: "May 10, 2026",
    nextVisit: "Jul 21, 2026",
  },
  {
    id: "p-64201",
    mrn: "P-64201",
    name: "Michael Johnson",
    initials: "MJ",
    sex: "Male",
    age: 52,
    dob: "03/08/1974",
    avatarGradient: ["#2563C7", "#5B8AD9"],
    primaryGoals:
      "Improve insulin sensitivity, cardiovascular fitness, sustainable energy",
    careTeam: ["Dr. Sarah Mitchell (You)", "Strength Coach · Registered Dietitian"],
    lastVisit: "Jun 30, 2026",
    nextVisit: "Jul 24, 2026",
  },
  {
    id: "p-59318",
    mrn: "P-59318",
    name: "Priya Sharma",
    initials: "PS",
    sex: "Female",
    age: 47,
    dob: "09/21/1978",
    avatarGradient: ["#B45309", "#D98E3B"],
    primaryGoals: "Resolve fatigue, restore iron stores, protect training capacity",
    careTeam: ["Dr. Sarah Mitchell (You)", "Holistic Health Coach"],
    lastVisit: "Jul 8, 2026",
    nextVisit: "Jul 17, 2026",
  },
  {
    id: "p-71126",
    mrn: "P-71126",
    name: "Jessica Parker",
    initials: "JP",
    sex: "Female",
    age: 39,
    dob: "11/02/1986",
    avatarGradient: ["#7461C9", "#9D8DE8"],
    primaryGoals: "Maintain sleep gains, build strength, long-term bone health",
    careTeam: ["Dr. Sarah Mitchell (You)", "Registered Dietitian"],
    lastVisit: "Jul 2, 2026",
    nextVisit: "Aug 12, 2026",
  },
  {
    id: "p-52984",
    mrn: "P-52984",
    name: "Marcus Webb",
    initials: "MW",
    sex: "Male",
    age: 55,
    dob: "01/17/1971",
    avatarGradient: ["#3D5A80", "#6483AC"],
    primaryGoals: "Glycemic control, re-engage daily habits, metabolic longevity",
    careTeam: ["Dr. Sarah Mitchell (You)", "Health Coach"],
    lastVisit: "Jun 24, 2026",
    nextVisit: "Jul 29, 2026",
  },
  {
    id: "p-66473",
    mrn: "P-66473",
    name: "Dana Whitfield",
    initials: "DW",
    sex: "Female",
    age: 44,
    dob: "06/05/1982",
    avatarGradient: ["#0D5C63", "#1A7A82"],
    primaryGoals: "Steady energy, stress resilience, simplified daily routine",
    careTeam: ["Dr. Sarah Mitchell (You)", "Holistic Health Coach"],
    lastVisit: "Jul 1, 2026",
    nextVisit: "Aug 5, 2026",
  },
];

const summaries: Record<string, PatientSummary> = {
  /* Flagship dataset — exact values from the design handoff. */
  "p-78435": {
    healthScore: {
      value: 78,
      band: "Good",
      tone: "positive",
      delta: { direction: "up", text: "6 pts vs last month", tone: "positive" },
    },
    systems: [
      { label: "Metabolic", value: 0.78 },
      { label: "Hormonal", value: 0.55 },
      { label: "Inflammation", value: 0.45 },
      { label: "Detox", value: 0.7 },
      { label: "Sleep & Recovery", value: 0.6 },
      { label: "Energy", value: 0.5 },
      { label: "Gut Health", value: 0.72 },
      { label: "Stress", value: 0.52 },
    ],
    priorities: [
      "Support sleep quality",
      "Reduce systemic inflammation",
      "Balance cortisol rhythm",
      "Optimize mitochondrial function",
    ],
    riskFlags: [
      { label: "Low Vitamin D (24 ng/mL)", action: "Monitor", tone: "warning" },
      { label: "Elevated hs-CRP (2.8 mg/L)", action: "Review", tone: "warning" },
      { label: "High Cortisol (AM)", action: "Monitor", tone: "critical" },
    ],
    biomarkers: [
      { name: "hs-CRP", unit: "mg/L", value: "2.8", status: "High", tone: "critical", series: [3.6, 3.4, 3.5, 3.1, 3.0, 2.9, 2.8], trendWord: "improving" },
      { name: "Vitamin D", unit: "ng/mL", value: "24", status: "Low", tone: "warning", series: [18, 19, 20, 21, 22, 23, 24], trendWord: "rising" },
      { name: "Ferritin", unit: "ng/mL", value: "45", status: "Optimal", tone: "positive", series: [42, 44, 43, 45, 44, 46, 45], trendWord: "stable" },
      { name: "Cortisol (AM)", unit: "µg/dL", value: "21.3", status: "High", tone: "critical", series: [18, 19, 20.5, 20, 21, 21.5, 21.3], trendWord: "elevated" },
      { name: "Omega-3 Index", unit: "%", value: "6.2", status: "Optimal", tone: "positive", series: [4.8, 5.1, 5.4, 5.7, 5.9, 6.1, 6.2], trendWord: "rising" },
    ],
    sleep: {
      score: 72,
      band: "Good",
      tone: "positive",
      series: [64, 66, 63, 67, 65, 69, 68, 70, 72, 69, 71, 73, 72, 74],
      stats: [
        { label: "Avg Sleep", value: "7h 12m" },
        { label: "HRV (Avg)", value: "68 ms" },
        { label: "Resting HR", value: "54 bpm" },
        { label: "Recovery", value: "78%" },
      ],
    },
    experiments: [
      { name: "Morning Light + 10 min", goalLine: "Goal: Improve sleep quality", dayText: "7 of 14", pct: 50, outcomeLabel: "Deep Sleep", direction: "↑ 18%", directionTone: "positive" },
      { name: "Magnesium Glycinate", goalLine: "Goal: Reduce muscle tension", dayText: "5 of 21", pct: 24, outcomeLabel: "Muscle Tension", direction: "↓ 22%", directionTone: "positive" },
    ],
    reasoning: {
      updatedOn: "Jul 12, 2026",
      review: { status: "awaiting" },
      provenance: {
        sourceType: "ai-inference",
        sourceName: "Reasoning engine",
        dateRange: "Labs May 13 · wearables 30 d",
        lastUpdated: "Jul 12, 2026",
        confidence: 74,
        conflicts: 1,
        review: "awaiting-review",
      },
      hypotheses: [
        {
          name: "Inflammatory burden",
          sub: "Contributing to fatigue, poor sleep",
          strength: 82,
          provenance: {
            sourceType: "measured",
            sourceName: "Quest panel · May 13",
            dateRange: "Last 90 days",
            confidence: 86,
            review: "reviewed",
          },
        },
        {
          name: "Cortisol dysregulation",
          sub: "Contributing to sleep disruption",
          strength: 74,
          provenance: {
            sourceType: "measured",
            sourceName: "Salivary cortisol · May 13",
            dateRange: "Single collection",
            confidence: 62,
            conflicts: 1,
            review: "awaiting-review",
          },
        },
        {
          name: "Mitochondrial dysfunction",
          sub: "Contributing to low energy",
          strength: 68,
          provenance: {
            sourceType: "ai-inference",
            sourceName: "Inferred from symptom pattern",
            confidence: 41,
            review: "not-reviewed",
          },
        },
      ],
      evidenceFor: [
        "Elevated hs-CRP (2.8 mg/L)",
        "High AM cortisol (21.3 µg/dL)",
        "Poor sleep efficiency (72%)",
        "Low vitamin D (24 ng/mL)",
      ],
      evidenceAgainst: [
        "Normal TSH, Free T3, Free T4",
        "No anemia or iron deficiency",
        "Normal fasting glucose",
        "Good HRV trend",
      ],
      nextSteps: [
        "Optimize sleep environment",
        "Support cortisol rhythm",
        "Reduce inflammatory triggers",
        "Recheck Vitamin D in 8 weeks",
      ],
      missingInformation: [
        "Repeat AM cortisol — single collection limits confidence",
        "Sleep-study data to separate cortisol vs. environmental causes",
        "Dietary inflammation log for the last 2 weeks",
      ],
      whatChanged: [
        { text: "hs-CRP improved 3.0 → 2.8 mg/L", direction: "weakened" },
        { text: "Vitamin D rose 22 → 24 ng/mL on repletion", direction: "weakened" },
        { text: "New: patient reports evening wakefulness", direction: "new" },
      ],
      safetyConsiderations: [
        "No red-flag symptoms reported; routine follow-up appropriate",
        "Confirm no drug interactions before adding supplements",
        "Cortisol result is a single sample — do not treat as a trend",
      ],
    },
    dataUpdated: "2 min ago",
  },

  "p-64201": {
    healthScore: {
      value: 64,
      band: "Fair",
      tone: "warning",
      delta: { direction: "down", text: "3 pts vs last month", tone: "critical" },
    },
    systems: [
      { label: "Metabolic", value: 0.42 },
      { label: "Hormonal", value: 0.6 },
      { label: "Inflammation", value: 0.4 },
      { label: "Detox", value: 0.62 },
      { label: "Sleep & Recovery", value: 0.55 },
      { label: "Energy", value: 0.48 },
      { label: "Gut Health", value: 0.66 },
      { label: "Stress", value: 0.5 },
    ],
    priorities: [
      "Improve insulin sensitivity",
      "Lower inflammatory burden",
      "Rebuild supplement adherence",
      "Increase aerobic base",
    ],
    riskFlags: [
      { label: "Elevated hs-CRP (4.1 mg/L)", action: "Review", tone: "critical" },
      { label: "Fasting insulin 14.2 µIU/mL", action: "Review", tone: "warning" },
      { label: "Supplement adherence 46%", action: "Review", tone: "warning" },
    ],
    biomarkers: [
      { name: "hs-CRP", unit: "mg/L", value: "4.1", status: "High", tone: "critical", series: [3.2, 3.4, 3.3, 3.6, 3.8, 3.9, 4.1], trendWord: "rising" },
      { name: "Fasting insulin", unit: "µIU/mL", value: "14.2", status: "High", tone: "warning", series: [11.8, 12.1, 12.6, 13.0, 13.4, 13.9, 14.2], trendWord: "rising" },
      { name: "HbA1c", unit: "%", value: "5.7", status: "High", tone: "warning", series: [5.4, 5.4, 5.5, 5.5, 5.6, 5.6, 5.7], trendWord: "rising" },
      { name: "ApoB", unit: "mg/dL", value: "112", status: "High", tone: "critical", series: [124, 122, 120, 118, 116, 114, 112], trendWord: "improving" },
      { name: "Omega-3 Index", unit: "%", value: "4.9", status: "Low", tone: "warning", series: [4.1, 4.2, 4.3, 4.5, 4.6, 4.8, 4.9], trendWord: "rising" },
    ],
    sleep: {
      score: 66,
      band: "Fair",
      tone: "warning",
      series: [62, 60, 64, 61, 63, 66, 64, 62, 65, 67, 66, 68, 66, 67],
      stats: [
        { label: "Avg Sleep", value: "6h 40m" },
        { label: "HRV (Avg)", value: "42 ms" },
        { label: "Resting HR", value: "61 bpm" },
        { label: "Recovery", value: "64%" },
      ],
    },
    experiments: [
      { name: "Post-dinner walk 20 min", goalLine: "Goal: Blunt evening glucose", dayText: "6 of 14", pct: 43, outcomeLabel: "Fasting Glucose", direction: "↓ 6%", directionTone: "positive" },
      { name: "Omega-3 3 g/day", goalLine: "Goal: Lower ApoB and hs-CRP", dayText: "12 of 28", pct: 43, outcomeLabel: "ApoB", direction: "↓ 4%", directionTone: "positive" },
    ],
    reasoning: {
      updatedOn: "Jul 13, 2026",
      review: { status: "awaiting" },
      hypotheses: [
        { name: "Insulin resistance progression", sub: "Contributing to afternoon energy dips", strength: 78 },
        { name: "Chronic low-grade inflammation", sub: "Contributing to slow recovery", strength: 71 },
        { name: "Sympathetic overdrive", sub: "Contributing to low HRV", strength: 60 },
      ],
      evidenceFor: [
        "Elevated hs-CRP (4.1 mg/L)",
        "Fasting insulin 14.2 µIU/mL",
        "HbA1c trending up (5.7%)",
        "Waist circumference +3 cm since Jan",
      ],
      evidenceAgainst: [
        "ApoB trending down since May",
        "Normal TSH and Free T4",
        "Negative sleep-apnea screening",
        "Liver enzymes within range",
      ],
      nextSteps: [
        "Simplify and restart supplement stack",
        "Add zone-2 sessions 3×/wk",
        "Recheck fasting insulin + HbA1c in 12 weeks",
        "Review caffeine timing",
      ],
      missingInformation: [
        "CGM data to characterize glucose excursions",
        "Current supplement adherence log",
      ],
      whatChanged: [
        { text: "hs-CRP rose 3.9 → 4.1 mg/L", direction: "strengthened" },
        { text: "Fasting insulin climbing (13.9 → 14.2 µIU/mL)", direction: "strengthened" },
      ],
      safetyConsiderations: [
        "ApoB elevated — coordinate with cardiology if it persists",
        "Confirm statin status before lipid-focused changes",
      ],
      provenance: {
        sourceType: "ai-inference",
        sourceName: "Reasoning engine",
        dateRange: "Labs Jun 30 · wearables 30 d",
        lastUpdated: "Jul 13, 2026",
        confidence: 69,
        review: "awaiting-review",
      },
    },
    dataUpdated: "14 min ago",
  },

  "p-59318": {
    healthScore: {
      value: 58,
      band: "Fair",
      tone: "warning",
      delta: { direction: "down", text: "5 pts vs last month", tone: "critical" },
    },
    systems: [
      { label: "Metabolic", value: 0.66 },
      { label: "Hormonal", value: 0.58 },
      { label: "Inflammation", value: 0.72 },
      { label: "Detox", value: 0.6 },
      { label: "Sleep & Recovery", value: 0.62 },
      { label: "Energy", value: 0.34 },
      { label: "Gut Health", value: 0.55 },
      { label: "Stress", value: 0.57 },
    ],
    priorities: [
      "Restore iron stores",
      "Investigate ongoing losses",
      "Protect energy while correcting anemia",
      "Recheck CBC in 4 weeks",
    ],
    riskFlags: [
      { label: "Ferritin 9 ng/mL — below lab range", action: "Review", tone: "critical" },
      { label: "Hemoglobin 11.2 g/dL", action: "Monitor", tone: "warning" },
      { label: "Fatigue score rising", action: "Review", tone: "warning" },
    ],
    biomarkers: [
      { name: "Ferritin", unit: "ng/mL", value: "9", status: "Low", tone: "critical", series: [18, 16, 15, 13, 12, 10, 9], trendWord: "declining" },
      { name: "Hemoglobin", unit: "g/dL", value: "11.2", status: "Low", tone: "warning", series: [12.4, 12.2, 12.0, 11.8, 11.6, 11.4, 11.2], trendWord: "declining" },
      { name: "hs-CRP", unit: "mg/L", value: "1.1", status: "Optimal", tone: "positive", series: [1.3, 1.2, 1.3, 1.1, 1.2, 1.1, 1.1], trendWord: "stable" },
      { name: "Vitamin B12", unit: "pg/mL", value: "210", status: "Low", tone: "warning", series: [265, 255, 248, 240, 228, 218, 210], trendWord: "declining" },
      { name: "TSH", unit: "µIU/mL", value: "3.8", status: "Optimal", tone: "positive", series: [3.5, 3.6, 3.7, 3.6, 3.8, 3.7, 3.8], trendWord: "stable" },
    ],
    sleep: {
      score: 74,
      band: "Good",
      tone: "positive",
      series: [70, 72, 71, 73, 72, 74, 73, 75, 74, 76, 74, 75, 73, 74],
      stats: [
        { label: "Avg Sleep", value: "7h 30m" },
        { label: "HRV (Avg)", value: "55 ms" },
        { label: "Resting HR", value: "62 bpm" },
        { label: "Recovery", value: "71%" },
      ],
    },
    experiments: [
      { name: "Iron protocol phase 1", goalLine: "Goal: Restore ferritin", dayText: "10 of 28", pct: 36, outcomeLabel: "Energy Score", direction: "↑ 9%", directionTone: "positive" },
      { name: "Earlier dinner window", goalLine: "Goal: Improve sleep onset", dayText: "3 of 14", pct: 21, outcomeLabel: "Sleep Onset", direction: "↓ 8 min", directionTone: "positive" },
    ],
    reasoning: {
      updatedOn: "Jul 14, 2026",
      review: { status: "awaiting" },
      hypotheses: [
        { name: "Iron-deficiency anemia", sub: "Driving fatigue and low capacity", strength: 88 },
        { name: "Iron loss exceeding intake", sub: "Menstrual losses likely dominant", strength: 76 },
        { name: "Suboptimal B12 status", sub: "Possible co-contributor to fatigue", strength: 64 },
      ],
      evidenceFor: [
        "Ferritin 9 ng/mL (lab range 16–154)",
        "Hemoglobin trending down (11.2 g/dL)",
        "Elevated RDW on last CBC",
        "Fatigue tracks with cycle timing",
      ],
      evidenceAgainst: [
        "Normal folate",
        "No GI symptoms reported",
        "hs-CRP low — not inflammation-driven",
        "Thyroid panel normal",
      ],
      nextSteps: [
        "Start practitioner-approved iron protocol",
        "GI evaluation if no response in 8 weeks",
        "Recheck CBC + ferritin in 4 weeks",
        "Track fatigue daily",
      ],
      missingInformation: [
        "Menstrual-loss history to quantify iron loss",
        "Recent dietary iron intake",
        "GI symptom screen to rule out occult loss",
      ],
      whatChanged: [
        { text: "Ferritin fell 10 → 9 ng/mL", direction: "strengthened" },
        { text: "Hemoglobin down 11.4 → 11.2 g/dL", direction: "strengthened" },
        { text: "B12 now flagged low (210 pg/mL)", direction: "new" },
      ],
      safetyConsiderations: [
        "Ferritin below lab range — practitioner-approved iron protocol only",
        "Rule out active GI bleeding before attributing to menses",
      ],
      provenance: {
        sourceType: "measured",
        sourceName: "CBC + ferritin · Jul 8",
        dateRange: "Last 60 days",
        lastUpdated: "Jul 14, 2026",
        confidence: 81,
        review: "awaiting-review",
      },
    },
    dataUpdated: "35 min ago",
  },

  "p-71126": {
    healthScore: {
      value: 81,
      band: "Good",
      tone: "positive",
      delta: { direction: "up", text: "4 pts vs last month", tone: "positive" },
    },
    systems: [
      { label: "Metabolic", value: 0.8 },
      { label: "Hormonal", value: 0.72 },
      { label: "Inflammation", value: 0.82 },
      { label: "Detox", value: 0.74 },
      { label: "Sleep & Recovery", value: 0.84 },
      { label: "Energy", value: 0.76 },
      { label: "Gut Health", value: 0.78 },
      { label: "Stress", value: 0.7 },
    ],
    priorities: [
      "Maintain sleep gains",
      "Fold magnesium trial into routine",
      "Build strength 2×/wk",
      "Recheck HbA1c in 6 months",
    ],
    riskFlags: [
      { label: "HbA1c 5.5% — upper normal", action: "Monitor", tone: "warning" },
      { label: "Family history: osteoporosis", action: "Review", tone: "warning" },
    ],
    biomarkers: [
      { name: "Vitamin D", unit: "ng/mL", value: "41", status: "Optimal", tone: "positive", series: [33, 34, 36, 37, 39, 40, 41], trendWord: "rising" },
      { name: "hs-CRP", unit: "mg/L", value: "0.8", status: "Optimal", tone: "positive", series: [1.1, 1.0, 1.0, 0.9, 0.9, 0.8, 0.8], trendWord: "improving" },
      { name: "Ferritin", unit: "ng/mL", value: "62", status: "Optimal", tone: "positive", series: [55, 57, 58, 60, 59, 61, 62], trendWord: "stable" },
      { name: "Cortisol (AM)", unit: "µg/dL", value: "14.2", status: "Optimal", tone: "positive", series: [19.5, 18.8, 17.9, 16.8, 15.9, 14.8, 14.2], trendWord: "normalizing" },
      { name: "HbA1c", unit: "%", value: "5.5", status: "High", tone: "warning", series: [5.3, 5.3, 5.4, 5.4, 5.4, 5.5, 5.5], trendWord: "creeping" },
    ],
    sleep: {
      score: 84,
      band: "Good",
      tone: "positive",
      series: [74, 76, 75, 78, 77, 80, 79, 81, 82, 81, 83, 84, 83, 84],
      stats: [
        { label: "Avg Sleep", value: "7h 48m" },
        { label: "HRV (Avg)", value: "74 ms" },
        { label: "Resting HR", value: "52 bpm" },
        { label: "Recovery", value: "85%" },
      ],
    },
    experiments: [
      { name: "Evening screen curfew", goalLine: "Goal: Shorten sleep latency", dayText: "9 of 14", pct: 64, outcomeLabel: "Sleep Latency", direction: "↓ 15%", directionTone: "positive" },
      { name: "Creatine 5 g/day", goalLine: "Goal: Support training output", dayText: "18 of 30", pct: 60, outcomeLabel: "Training Volume", direction: "↑ 11%", directionTone: "positive" },
    ],
    reasoning: {
      updatedOn: "Jul 10, 2026",
      review: { status: "approved", label: "Approved by Dr. Mitchell" },
      hypotheses: [
        { name: "Magnesium responder", sub: "Improved sleep depth on glycinate", strength: 79 },
        { name: "Cortisol normalization", sub: "Following job change in April", strength: 66 },
        { name: "Vitamin D repletion effect", sub: "Contributing to mood and energy", strength: 58 },
      ],
      evidenceFor: [
        "Deep sleep +21 min average",
        "Sleep score 84 — 30-day high",
        "AM cortisol normalized (14.2 µg/dL)",
        "Self-reported energy improving",
      ],
      evidenceAgainst: [
        "Improvement began before magnesium start",
        "Seasonal daylight increase is a confounder",
        "Screen-curfew adherence imperfect (71%)",
      ],
      nextSteps: [
        "Continue magnesium 8 more weeks",
        "Re-test cortisol rhythm in fall",
        "Convert screen curfew into standing habit",
        "Schedule baseline DEXA",
      ],
      missingInformation: [
        "Follow-up cortisol rhythm to confirm normalization",
        "DEXA baseline for bone-health tracking",
      ],
      whatChanged: [
        { text: "Sleep score reached 30-day high (84)", direction: "strengthened" },
        { text: "AM cortisol normalized (14.2 µg/dL)", direction: "resolved" },
      ],
      safetyConsiderations: [
        "Family history of osteoporosis — prioritize DEXA scheduling",
        "Effect began before magnesium — avoid over-attributing benefit",
      ],
      provenance: {
        sourceType: "practitioner-confirmed",
        sourceName: "Reviewed by Dr. Mitchell",
        dateRange: "Labs Jul 2 · wearables 30 d",
        lastUpdated: "Jul 10, 2026",
        confidence: 79,
        review: "reviewed",
      },
    },
    dataUpdated: "1 h ago",
  },

  "p-52984": {
    healthScore: {
      value: 62,
      band: "Fair",
      tone: "warning",
      delta: { direction: "down", text: "2 pts vs last month", tone: "critical" },
    },
    systems: [
      { label: "Metabolic", value: 0.38 },
      { label: "Hormonal", value: 0.6 },
      { label: "Inflammation", value: 0.68 },
      { label: "Detox", value: 0.58 },
      { label: "Sleep & Recovery", value: 0.46 },
      { label: "Energy", value: 0.44 },
      { label: "Gut Health", value: 0.62 },
      { label: "Stress", value: 0.48 },
    ],
    priorities: [
      "Re-engage daily check-ins",
      "Agree glycemic control plan",
      "Approve berberine N-of-1 design",
      "Stabilize sleep schedule",
    ],
    riskFlags: [
      { label: "HbA1c 5.9% — above lab range", action: "Review", tone: "warning" },
      { label: "Check-ins stopped Jul 6", action: "Review", tone: "warning" },
      { label: "Fasting glucose trending up", action: "Monitor", tone: "warning" },
    ],
    biomarkers: [
      { name: "HbA1c", unit: "%", value: "5.9", status: "High", tone: "warning", series: [5.5, 5.6, 5.6, 5.7, 5.8, 5.8, 5.9], trendWord: "rising" },
      { name: "Fasting glucose", unit: "mg/dL", value: "104", status: "High", tone: "warning", series: [94, 96, 97, 99, 100, 102, 104], trendWord: "rising" },
      { name: "Triglycerides", unit: "mg/dL", value: "168", status: "High", tone: "warning", series: [150, 154, 157, 160, 162, 165, 168], trendWord: "rising" },
      { name: "Vitamin D", unit: "ng/mL", value: "28", status: "Low", tone: "warning", series: [24, 25, 25, 26, 27, 27, 28], trendWord: "rising" },
      { name: "hs-CRP", unit: "mg/L", value: "1.9", status: "Optimal", tone: "positive", series: [2.3, 2.2, 2.1, 2.1, 2.0, 1.9, 1.9], trendWord: "improving" },
    ],
    sleep: {
      score: 61,
      band: "Fair",
      tone: "warning",
      series: [58, 60, 56, 59, 62, 60, 63, 61, 59, 62, 60, 63, 61, 62],
      stats: [
        { label: "Avg Sleep", value: "6h 20m" },
        { label: "HRV (Avg)", value: "38 ms" },
        { label: "Resting HR", value: "66 bpm" },
        { label: "Recovery", value: "58%" },
      ],
    },
    experiments: [
      { name: "10k steps target", goalLine: "Goal: Lower fasting glucose", dayText: "4 of 21", pct: 19, outcomeLabel: "Fasting Glucose", direction: "↓ 3%", directionTone: "positive" },
      { name: "Sauna 4×/wk", goalLine: "Goal: Improve evening recovery", dayText: "8 of 21", pct: 38, outcomeLabel: "Evening HRV", direction: "↑ 6%", directionTone: "positive" },
    ],
    reasoning: {
      updatedOn: "Jul 12, 2026",
      review: { status: "awaiting" },
      hypotheses: [
        { name: "Early insulin resistance", sub: "Driving glucose and triglyceride trends", strength: 81 },
        { name: "Low daily activity", sub: "Average 4.2k steps sustaining glycemia", strength: 69 },
        { name: "Vitamin D insufficiency", sub: "Possible metabolic co-factor", strength: 57 },
      ],
      evidenceFor: [
        "HbA1c 5.9% (lab range 4.0–5.6)",
        "Fasting glucose 104 mg/dL",
        "Triglycerides 168 mg/dL",
        "Average steps 4.2k/day",
      ],
      evidenceAgainst: [
        "Fasting insulin normal (8.1 µIU/mL)",
        "Weight stable since March",
        "hs-CRP within optimal range",
      ],
      nextSteps: [
        "Approve berberine 500 mg experiment",
        "Re-engage daily check-ins",
        "Two-week CGM trial",
        "Recheck HbA1c in October",
      ],
      missingInformation: [
        "Reason for stopped check-ins (Jul 6)",
        "Fasting insulin repeat to stage insulin resistance",
        "Current medication list",
      ],
      whatChanged: [
        { text: "HbA1c rose 5.8 → 5.9% (above range)", direction: "strengthened" },
        { text: "Fasting glucose trending up (102 → 104 mg/dL)", direction: "strengthened" },
        { text: "Daily check-ins stopped Jul 6", direction: "new" },
      ],
      safetyConsiderations: [
        "Re-engage before intensifying plan — adherence gap is a safety signal",
        "Confirm berberine has no interaction with current meds before trial",
      ],
      provenance: {
        sourceType: "ai-inference",
        sourceName: "Reasoning engine",
        dateRange: "Labs Jun 24 · wearables 21 d",
        lastUpdated: "Jul 12, 2026",
        confidence: 66,
        review: "awaiting-review",
      },
    },
    dataUpdated: "3 h ago",
  },

  "p-66473": {
    healthScore: {
      value: 71,
      band: "Good",
      tone: "positive",
      delta: { direction: "up", text: "2 pts vs last month", tone: "positive" },
    },
    systems: [
      { label: "Metabolic", value: 0.7 },
      { label: "Hormonal", value: 0.52 },
      { label: "Inflammation", value: 0.74 },
      { label: "Detox", value: 0.64 },
      { label: "Sleep & Recovery", value: 0.66 },
      { label: "Energy", value: 0.54 },
      { label: "Gut Health", value: 0.7 },
      { label: "Stress", value: 0.44 },
    ],
    priorities: [
      "Rebuild evening wind-down",
      "Morning light exposure",
      "Simplify habit list to 3 anchors",
      "Restart breath practice",
    ],
    riskFlags: [
      { label: "Flattened cortisol slope", action: "Review", tone: "warning" },
      { label: "Habit tracking incomplete", action: "Monitor", tone: "warning" },
    ],
    biomarkers: [
      { name: "Cortisol (PM)", unit: "µg/dL", value: "8.1", status: "High", tone: "warning", series: [6.2, 6.5, 6.8, 7.2, 7.5, 7.9, 8.1], trendWord: "rising" },
      { name: "DHEA-S", unit: "µg/dL", value: "96", status: "Low", tone: "warning", series: [118, 114, 110, 106, 102, 99, 96], trendWord: "declining" },
      { name: "Vitamin D", unit: "ng/mL", value: "33", status: "Optimal", tone: "positive", series: [29, 30, 30, 31, 32, 32, 33], trendWord: "rising" },
      { name: "hs-CRP", unit: "mg/L", value: "1.4", status: "Optimal", tone: "positive", series: [1.6, 1.5, 1.6, 1.5, 1.4, 1.5, 1.4], trendWord: "stable" },
      { name: "Ferritin", unit: "ng/mL", value: "58", status: "Optimal", tone: "positive", series: [52, 54, 53, 55, 56, 57, 58], trendWord: "stable" },
    ],
    sleep: {
      score: 70,
      band: "Good",
      tone: "positive",
      series: [66, 68, 65, 69, 67, 70, 68, 71, 69, 72, 70, 71, 69, 70],
      stats: [
        { label: "Avg Sleep", value: "7h 05m" },
        { label: "HRV (Avg)", value: "61 ms" },
        { label: "Resting HR", value: "58 bpm" },
        { label: "Recovery", value: "73%" },
      ],
    },
    experiments: [
      { name: "Evening breathwork 10 min", goalLine: "Goal: Lower evening cortisol", dayText: "5 of 14", pct: 36, outcomeLabel: "Evening Cortisol", direction: "↓ 11%", directionTone: "positive" },
      { name: "Sunrise walk", goalLine: "Goal: Anchor circadian rhythm", dayText: "11 of 21", pct: 52, outcomeLabel: "Morning Energy", direction: "↑ 8%", directionTone: "positive" },
    ],
    reasoning: {
      updatedOn: "Jul 9, 2026",
      review: { status: "awaiting" },
      hypotheses: [
        { name: "HPA-axis flattening", sub: "Blunted diurnal cortisol slope", strength: 72 },
        { name: "Behavioral overload", sub: "Too many concurrent habits reducing adherence", strength: 61 },
        { name: "Subclinical DHEA decline", sub: "Possible resilience co-factor", strength: 55 },
      ],
      evidenceFor: [
        "Evening cortisol 8.1 µg/dL",
        "DHEA-S trending down (96 µg/dL)",
        "Habit completion 63%",
        "Reports feeling wired in the evening",
      ],
      evidenceAgainst: [
        "AM cortisol within range",
        "Sleep duration adequate (7h+)",
        "No mood-screen flags",
      ],
      nextSteps: [
        "Reduce habit list to 3 anchors",
        "Retest evening cortisol in 6 weeks",
        "Review adaptogen options with practitioner",
        "Suggest Quantum Mind stress session",
      ],
      missingInformation: [
        "Repeat evening cortisol to confirm the flattened slope",
        "Complete habit-tracking data (currently 63%)",
      ],
      whatChanged: [
        { text: "Evening cortisol rose 7.9 → 8.1 µg/dL", direction: "strengthened" },
        { text: "DHEA-S declining (99 → 96 µg/dL)", direction: "strengthened" },
      ],
      safetyConsiderations: [
        "Review adaptogens with practitioner before recommending",
        "Screen mood before attributing symptoms to HPA axis alone",
      ],
      provenance: {
        sourceType: "ai-inference",
        sourceName: "Reasoning engine",
        dateRange: "Labs Jul 1 · wearables 30 d",
        lastUpdated: "Jul 9, 2026",
        confidence: 64,
        review: "awaiting-review",
      },
    },
    dataUpdated: "5 h ago",
  },
};

export function listPatients(): PatientDirectoryEntry[] {
  return directory;
}

export function getPatient(id: string): PatientDirectoryEntry | undefined {
  return directory.find((p) => p.id === id);
}

export function getPatientSummary(id: string): PatientSummary | undefined {
  return summaries[id];
}

/** The patient the shell opens by default (flagship demo record). */
export const DEFAULT_PATIENT_ID = "p-78435";
