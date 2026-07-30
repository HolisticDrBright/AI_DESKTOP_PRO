"use client";

/**
 * Report catalog (MOCK). Deterministic synthetic rows that respond to the
 * filter bar so the workflow is real even though the data is demo. Exports
 * are client-side CSVs of the visible mock rows, labeled as demo.
 *
 * Role-aware scope is enforced in BOTH the adapter types (each report
 * declares the roles that may see it) and the UI (catalog filtered; hidden
 * count shown). The demo role switcher is a preview — real enforcement is
 * the backend's job.
 */
import { createSessionStore } from "./session-kv";
import { billingSummary, listInvoices } from "./billing.mock";
import { formatMinor } from "@/lib/money";

export type ViewRole = "Owner" | "Practitioner" | "Front desk";

export interface ReportFiltersState {
  range: "30d" | "90d" | "qtd" | "ytd";
  location: "All locations" | "Main Studio" | "Telehealth";
  practitioner: "All practitioners" | "Dr. Sarah Mitchell" | "Dr. James Okafor" | "Rachel Nguyen, RD";
  status: "All statuses" | "Open" | "Settled";
}

export const DEFAULT_FILTERS: ReportFiltersState = {
  range: "30d",
  location: "All locations",
  practitioner: "All practitioners",
  status: "All statuses",
};

export type ReportGroup =
  | "Appointments & retention"
  | "Patients"
  | "Billing & sales"
  | "Labs & clinical"
  | "Programs"
  | "Research (de-identified)";

export interface ReportDef {
  id: string;
  title: string;
  group: ReportGroup;
  description: string;
  roles: ViewRole[];
  columns: string[];
  rows: (f: ReportFiltersState) => (string | number)[][];
  footnote?: string;
}

/** Deterministic range scaling so the filter bar visibly works. */
const FACTOR: Record<ReportFiltersState["range"], number> = {
  "30d": 1,
  "90d": 2.7,
  qtd: 2.2,
  ytd: 6.3,
};
const scale = (n: number, f: ReportFiltersState) => Math.round(n * FACTOR[f.range]);

const PRACTITIONER_SHARE: Record<string, number> = {
  "Dr. Sarah Mitchell": 0.52,
  "Dr. James Okafor": 0.31,
  "Rachel Nguyen, RD": 0.17,
};
const byPractitioner = (n: number, f: ReportFiltersState) =>
  f.practitioner === "All practitioners" ? n : Math.round(n * PRACTITIONER_SHARE[f.practitioner]);
const locShare = (n: number, f: ReportFiltersState) =>
  f.location === "All locations" ? n : Math.round(n * (f.location === "Main Studio" ? 0.78 : 0.22));

const apptRows = (f: ReportFiltersState): (string | number)[][] => {
  const types: [string, number, number][] = [
    ["Initial consult", 14, 2],
    ["Follow-up", 38, 3],
    ["Lab review", 21, 1],
    ["Supplement consult", 12, 0],
    ["Telehealth", 18, 2],
    ["Group session", 9, 0],
  ];
  return types
    .filter(([label]) => f.location !== "Telehealth" || label === "Telehealth")
    .map(([label, booked, noShows]) => {
      const b = locShare(byPractitioner(scale(booked, f), f), f);
      const n = Math.min(b, byPractitioner(scale(noShows, f), f));
      return [label, b, n, b ? `${Math.round(((b - n) / b) * 100)}%` : "—"];
    });
};

export const REPORTS: ReportDef[] = [
  {
    id: "appointments-by-type",
    title: "Appointments by type",
    group: "Appointments & retention",
    description: "Booked, no-shows, and completion rate per visit type.",
    roles: ["Owner", "Practitioner", "Front desk"],
    columns: ["Visit type", "Booked", "No-shows", "Completion"],
    rows: apptRows,
  },
  {
    id: "utilization",
    title: "Schedule utilization",
    group: "Appointments & retention",
    description: "Booked hours vs available hours per practitioner.",
    roles: ["Owner", "Front desk"],
    columns: ["Practitioner", "Available (h)", "Booked (h)", "Utilization"],
    rows: (f) =>
      (
        [
          ["Dr. Sarah Mitchell", 128, 104],
          ["Dr. James Okafor", 112, 78],
          ["Rachel Nguyen, RD", 64, 47],
        ] as [string, number, number][]
      )
        .filter(([p]) => f.practitioner === "All practitioners" || p === f.practitioner)
        .map(([p, avail, booked]) => [
          p,
          scale(avail, f),
          scale(booked, f),
          `${Math.round((booked / avail) * 100)}%`,
        ]),
  },
  {
    id: "no-shows",
    title: "No-shows & late cancellations",
    group: "Appointments & retention",
    description: "Patients with missed visits in the window.",
    roles: ["Owner", "Practitioner", "Front desk"],
    columns: ["Patient", "Visit", "When", "Type"],
    rows: () => [
      ["Michael Johnson", "Follow-up", "Jul 3", "No-show"],
      ["Tom Fletcher", "Supplement consult", "Jun 28", "Late cancellation"],
      ["Grace Park", "Telehealth", "Jun 24", "No-show"],
    ],
  },
  {
    id: "retention",
    title: "Retention cohorts",
    group: "Appointments & retention",
    description: "Return-visit rate by intake month.",
    roles: ["Owner"],
    columns: ["Intake month", "New patients", "Returned ≤ 60 d", "Retention"],
    rows: (f) =>
      (
        [
          ["Mar", 6, 5],
          ["Apr", 8, 6],
          ["May", 7, 6],
          ["Jun", 9, 7],
        ] as [string, number, number][]
      ).map(([m, n, r]) => [m, scale(n, f), scale(r, f), `${Math.round((r / n) * 100)}%`]),
  },
  {
    id: "new-patients",
    title: "New patients & referral sources",
    group: "Patients",
    description: "Where new patients came from.",
    roles: ["Owner", "Front desk"],
    columns: ["Source", "Patients", "Share"],
    rows: (f) => {
      const rows: [string, number][] = [
        ["Practitioner referral", 9],
        ["Patient referral", 7],
        ["Web search", 6],
        ["Programs / content", 4],
      ];
      const total = rows.reduce((n, [, v]) => n + v, 0);
      return rows.map(([s, v]) => [s, scale(v, f), `${Math.round((v / total) * 100)}%`]);
    },
  },
  {
    id: "inactive",
    title: "Inactive patients",
    group: "Patients",
    description: "No visit or message in 90+ days — re-engagement list.",
    roles: ["Owner", "Practitioner", "Front desk"],
    columns: ["Patient", "Last contact", "Last visit", "Suggested next step"],
    rows: () => [
      ["Dana Whitfield", "Jun 30", "Apr 30", "Program week-6 check-in"],
      ["Jessica Parker", "Jul 2", "May 22", "Book follow-up (open invoice)"],
    ],
  },
  {
    id: "billing-summary",
    title: "Billing summary",
    group: "Billing & sales",
    description: "Invoiced, collected, refunds, fees, and net (test-mode math).",
    roles: ["Owner"],
    columns: ["Measure", "Amount"],
    rows: () => {
      const s = billingSummary();
      return [
        ["Invoiced", formatMinor(s.invoicedMinor)],
        ["Collected", formatMinor(s.collectedMinor)],
        ["Refunded", formatMinor(s.refundedMinor)],
        ["Processor fees (test-mode)", formatMinor(s.feesMinor)],
        ["Net", formatMinor(s.netMinor)],
        ["Outstanding (A/R)", formatMinor(s.openMinor)],
      ];
    },
    footnote: "Live ledger of the demo session — checkout updates this report immediately.",
  },
  {
    id: "sales-by-item",
    title: "Sales by service / product / program",
    group: "Billing & sales",
    description: "Revenue mix across the catalog.",
    roles: ["Owner"],
    columns: ["Category", "Amount"],
    rows: () => billingSummary().byKind.map((k) => [k.label, formatMinor(k.amountMinor)]),
  },
  {
    id: "transactions",
    title: "Transactions",
    group: "Billing & sales",
    description: "Invoice-level activity in the window.",
    roles: ["Owner", "Front desk"],
    columns: ["Invoice", "Patient", "Date", "Total", "Status"],
    rows: (f) =>
      listInvoices()
        .filter((i) =>
          f.status === "All statuses"
            ? true
            : f.status === "Open"
              ? i.status === "open" || i.status === "partial"
              : i.status === "paid" || i.status === "refunded",
        )
        .slice(0, 12)
        .map((i) => [`#${i.number}`, i.patientName, i.atLabel, formatMinor(i.totalMinor), i.status]),
  },
  {
    id: "ar-aging",
    title: "A/R aging",
    group: "Billing & sales",
    description: "Outstanding balances by age bucket.",
    roles: ["Owner"],
    columns: ["Bucket", "Invoices", "Outstanding"],
    rows: () => billingSummary().arAging.map((b) => [b.bucket, b.count, formatMinor(b.amountMinor)]),
  },
  {
    id: "refunds-fees",
    title: "Refunds & fees",
    group: "Billing & sales",
    description: "Refund events and test-mode processor fees.",
    roles: ["Owner"],
    columns: ["Measure", "Amount"],
    rows: () => {
      const s = billingSummary();
      return [
        ["Refunded", formatMinor(s.refundedMinor)],
        ["Processor fees (test-mode)", formatMinor(s.feesMinor)],
      ];
    },
  },
  {
    id: "compensation",
    title: "Compensation by practitioner",
    group: "Billing & sales",
    description: "Collected revenue attributed to staff.",
    roles: ["Owner"],
    columns: ["Staff", "Collected"],
    rows: () => billingSummary().byStaff.map((r) => [r.staff, formatMinor(r.amountMinor)]),
  },
  {
    id: "product-performance",
    title: "Product performance",
    group: "Billing & sales",
    description: "Dispensary velocity + margin (demo inventory).",
    roles: ["Owner"],
    columns: ["Product", "Units (window)", "Revenue", "Margin"],
    rows: (f) =>
      (
        [
          ["Magnesium Glycinate 120 ct", 14, 47600, "58%"],
          ["Omega-3 Triglyceride 90 ct", 11, 46200, "52%"],
          ["Vitamin D3+K2 drops", 9, 25200, "61%"],
          ["Probiotic 50B", 6, 27000, "49%"],
        ] as [string, number, number, string][]
      ).map(([p, u, rev, m]) => [p, scale(u, f), formatMinor(scale(rev, f)), m]),
  },
  {
    id: "labs-turnaround",
    title: "Labs turnaround",
    group: "Labs & clinical",
    description: "Import → review time and pending extractions.",
    roles: ["Owner", "Practitioner"],
    columns: ["Measure", "Value"],
    rows: () => [
      ["Median import → review", "22 h"],
      ["Panels awaiting review", 2],
      ["Low-confidence markers pending", 3],
      ["Critical results this window", 1],
    ],
  },
  {
    id: "review-workload",
    title: "Review workload",
    group: "Labs & clinical",
    description: "Open review-queue items by category and assignee.",
    roles: ["Owner", "Practitioner"],
    columns: ["Category", "Open items"],
    rows: () => [
      ["Safety alerts", 1],
      ["Extraction review", 2],
      ["Clinical reasoning", 1],
      ["Protocol / experiment approvals", 2],
      ["Messages & refills", 3],
    ],
  },
  {
    id: "outcomes",
    title: "Clinical outcomes summary",
    group: "Labs & clinical",
    description: "Marker movement across active care plans (demo).",
    roles: ["Owner", "Practitioner"],
    columns: ["Marker", "Improved", "Stable", "Worsened"],
    rows: (f) =>
      (
        [
          ["hs-CRP", 6, 3, 1],
          ["Vitamin D", 8, 2, 0],
          ["Fasting insulin", 4, 4, 2],
          ["Ferritin", 3, 2, 1],
        ] as [string, number, number, number][]
      ).map(([m, a, b, c]) => [m, scale(a, f), scale(b, f), scale(c, f)]),
  },
  {
    id: "adherence",
    title: "Protocol adherence",
    group: "Labs & clinical",
    description: "Adherence bands across active protocols.",
    roles: ["Owner", "Practitioner"],
    columns: ["Band", "Patients"],
    rows: (f) => [
      ["≥ 80%", scale(9, f)],
      ["50–79%", scale(4, f)],
      ["< 50%", scale(2, f)],
    ],
  },
  {
    id: "program-sales",
    title: "Program sales & enrollment",
    group: "Programs",
    description: "Revenue and enrollments per program.",
    roles: ["Owner"],
    columns: ["Program", "Enrollments", "Revenue"],
    rows: (f) => [
      ["Metabolic Reset — 12-Week", scale(7, f), formatMinor(scale(524300, f))],
      ["Sleep Foundations Mini-Course", scale(12, f), formatMinor(scale(178800, f))],
    ],
  },
  {
    id: "program-progress",
    title: "Program progress & completion",
    group: "Programs",
    description: "Learner progress distribution.",
    roles: ["Owner", "Practitioner"],
    columns: ["Program", "Active", "Avg progress", "Completion"],
    rows: () => [
      ["Metabolic Reset — 12-Week", 24, "61%", "38%"],
      ["Sleep Foundations Mini-Course", 41, "78%", "68%"],
    ],
  },
  {
    id: "nof1-population",
    title: "N-of-1 population summary (de-identified)",
    group: "Research (de-identified)",
    description: "Aggregated experiment outcomes — no patient identifiers.",
    roles: ["Owner", "Practitioner"],
    columns: ["Intervention", "Experiments", "Likely beneficial", "No effect", "Inconclusive"],
    rows: () => [
      ["Magnesium glycinate (sleep)", 6, 4, 1, 1],
      ["Morning light (sleep/HRV)", 5, 3, 1, 1],
      ["Post-dinner walk (glucose)", 3, 2, 0, 1],
    ],
    footnote:
      "De-identified aggregate: counts only, minimum cell size 3, no identifiers, no dates. Individual experiments live in each patient's Tracking tab.",
  },
];

const roleStore = createSessionStore<ViewRole>("aidp:demo:report-role", "Owner");

export function useViewRole(): ViewRole {
  return roleStore.use();
}

export function setViewRole(role: ViewRole) {
  roleStore.set(role);
}

export function visibleReports(role: ViewRole): ReportDef[] {
  return REPORTS.filter((r) => r.roles.includes(role));
}

/** CSV of the visible mock rows — exported client-side, labeled demo. */
export function reportCsv(def: ReportDef, filters: ReportFiltersState): string {
  const esc = (v: string | number) => {
    const s = String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const lines = [
    `# ${def.title} — DEMO DATA (synthetic), filters: ${filters.range} · ${filters.location} · ${filters.practitioner}`,
    def.columns.map(esc).join(","),
    ...def.rows(filters).map((r) => r.map(esc).join(",")),
  ];
  return lines.join("\n");
}
