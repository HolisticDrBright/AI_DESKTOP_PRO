/**
 * Patient profile extras (MOCK) — the practice-management half of the chart
 * header: demographics, contacts, booking stats, alerts, forms,
 * communication prefs. All synthetic. Clinical data stays in the clinical
 * adapters; this file is front-office context only.
 */

export interface ProfileContact {
  phone: string;
  email: string;
  address: string;
  preferred: "Portal" | "Phone" | "Email";
}

export interface BookingStats {
  total: number;
  upcoming: number;
  noShows: number;
  cancellations: number;
  lastVisitLabel: string;
  sinceLastVisit: string;
  nextAppointmentLabel: string;
  nextAppointmentHref: string;
  memberSinceLabel: string;
}

export interface PatientFormStatus {
  name: string;
  status: "complete" | "assigned" | "overdue";
  atLabel: string;
}

export interface CommEntry {
  atLabel: string;
  kind: "portal" | "system";
  summary: string;
  threadId?: string;
}

export interface PatientProfileExtras {
  pronouns?: string;
  contact: ProfileContact;
  emergency: { name: string; relation: string; phone: string };
  insurance: { carrier: string; plan: string; memberId: string } | null;
  medicalAlerts: { label: string; tone: "critical" | "warning" }[];
  booking: BookingStats;
  forms: PatientFormStatus[];
  comms: CommEntry[];
  referralSource: string;
  tags: string[];
}

const DEFAULT_EXTRAS: PatientProfileExtras = {
  contact: {
    phone: "(555) 014-2288",
    email: "patient@example.invalid",
    address: "—",
    preferred: "Portal",
  },
  emergency: { name: "On file", relation: "—", phone: "—" },
  insurance: null,
  medicalAlerts: [],
  booking: {
    total: 4,
    upcoming: 0,
    noShows: 0,
    cancellations: 0,
    lastVisitLabel: "Jun 30",
    sinceLastVisit: "3 weeks",
    nextAppointmentLabel: "None scheduled",
    nextAppointmentHref: "/calendar",
    memberSinceLabel: "2025",
  },
  forms: [],
  comms: [],
  referralSource: "Website",
  tags: [],
};

const EXTRAS: Record<string, PatientProfileExtras> = {
  "p-78435": {
    pronouns: "she/her",
    contact: {
      phone: "(555) 014-7788",
      email: "alexandra.demo@example.invalid",
      address: "412 Cedar Ave, Portland, OR",
      preferred: "Portal",
    },
    emergency: { name: "Chris Morgan", relation: "Partner", phone: "(555) 014-7789" },
    insurance: { carrier: "Cascade Health (synthetic)", plan: "PPO 2500", memberId: "CH-002-4471" },
    medicalAlerts: [
      { label: "Penicillin allergy — anaphylaxis", tone: "critical" },
      { label: "Sertraline 50 mg — interaction screen active", tone: "warning" },
    ],
    booking: {
      total: 18,
      upcoming: 2,
      noShows: 0,
      cancellations: 1,
      lastVisitLabel: "Jul 9",
      sinceLastVisit: "10 days",
      nextAppointmentLabel: "Today · Supplement consult · 2:00 PM",
      nextAppointmentHref: "/calendar",
      memberSinceLabel: "Aug 2024",
    },
    forms: [
      { name: "Intake — health history", status: "complete", atLabel: "Aug 2024" },
      { name: "PSS-10 (quarterly)", status: "complete", atLabel: "Jul 2" },
      { name: "Sleep quality diary", status: "assigned", atLabel: "due Jul 25" },
    ],
    comms: [
      { atLabel: "Today 7:42 AM", kind: "portal", summary: "Asked about evening supplement timing", threadId: "th-avery-timing" },
      { atLabel: "Jul 9", kind: "system", summary: "Visit summary shared to portal" },
      { atLabel: "Jul 2", kind: "system", summary: "PSS-10 assessment completed" },
    ],
    referralSource: "Practitioner referral",
    tags: ["Metabolic Reset — Phase 2", "Membership"],
  },
  "p-64201": {
    pronouns: "he/him",
    contact: {
      phone: "(555) 014-3321",
      email: "michael.demo@example.invalid",
      address: "88 Harbor St, Portland, OR",
      preferred: "Email",
    },
    emergency: { name: "Renee Johnson", relation: "Spouse", phone: "(555) 014-3322" },
    insurance: null,
    medicalAlerts: [{ label: "Statin intolerance (reported)", tone: "warning" }],
    booking: {
      total: 9,
      upcoming: 1,
      noShows: 1,
      cancellations: 2,
      lastVisitLabel: "Jul 12",
      sinceLastVisit: "1 week",
      nextAppointmentLabel: "Thu · Follow-up · 9:00 AM (reschedule requested)",
      nextAppointmentHref: "/inbox?thread=th-michael-reschedule",
      memberSinceLabel: "Jan 2025",
    },
    forms: [
      { name: "Intake — health history", status: "complete", atLabel: "Jan 2025" },
      { name: "Cardiometabolic questionnaire", status: "overdue", atLabel: "was due Jul 10" },
    ],
    comms: [
      { atLabel: "Today 8:15 AM", kind: "portal", summary: "Requested Thursday reschedule", threadId: "th-michael-reschedule" },
      { atLabel: "Mon", kind: "portal", summary: "Billing question resolved", threadId: "th-billing-question" },
    ],
    referralSource: "Web search",
    tags: ["Cardiometabolic program"],
  },
  "p-59318": {
    pronouns: "she/her",
    contact: {
      phone: "(555) 014-9014",
      email: "priya.demo@example.invalid",
      address: "1509 5th Ave, Lake Oswego, OR",
      preferred: "Portal",
    },
    emergency: { name: "Arun Sharma", relation: "Spouse", phone: "(555) 014-9015" },
    insurance: { carrier: "Cascade Health (synthetic)", plan: "HMO 1500", memberId: "CH-014-8892" },
    medicalAlerts: [{ label: "Ferritin 9 ng/mL — iron repletion pending approval", tone: "critical" }],
    booking: {
      total: 6,
      upcoming: 1,
      noShows: 0,
      cancellations: 0,
      lastVisitLabel: "Jul 15",
      sinceLastVisit: "4 days",
      nextAppointmentLabel: "Mon · Lab review · 9:45 AM",
      nextAppointmentHref: "/calendar",
      memberSinceLabel: "Jun 2025",
    },
    forms: [
      { name: "Intake — health history", status: "complete", atLabel: "Jun 2025" },
      { name: "Fatigue severity scale", status: "assigned", atLabel: "due Jul 22" },
    ],
    comms: [
      { atLabel: "Today 6:58 AM", kind: "portal", summary: "Reported worsening fatigue", threadId: "th-priya-labs" },
      { atLabel: "Jul 15", kind: "system", summary: "Lab review visit completed" },
    ],
    referralSource: "Patient referral",
    tags: ["High risk — ferritin alert"],
  },
};

export function getProfileExtras(patientId: string): PatientProfileExtras {
  return EXTRAS[patientId] ?? DEFAULT_EXTRAS;
}
