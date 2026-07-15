/**
 * Domain types for the Phase-1 mock adapters.
 *
 * These interfaces are the contract between the UI and the data layer. The
 * mock implementations in this folder will be replaced by tRPC queries once
 * the shared backend is wired up — keep the shapes backend-friendly.
 *
 * Colors are expressed as semantic tones, never hex: blue = action /
 * practitioner-confirmed, teal = patient-reported, violet = AI / inference,
 * green = positive, amber = warning, coral = critical, navy = measured.
 */

export type Tone =
  | "action"
  | "teal"
  | "positive"
  | "warning"
  | "critical"
  | "ai"
  | "slate"
  | "navy";

export type Priority = "High" | "Medium" | "Low";

/* ------------------------------------------------------------- provenance */

/**
 * Where a piece of data came from. Drives the provenance component's tone and
 * label. Kept in the adapter layer so both UI and future tRPC payloads share it.
 */
export type ProvenanceSourceType =
  | "measured"
  | "patient-reported"
  | "practitioner-confirmed"
  | "ai-inference"
  | "published-evidence"
  | "imported-record";

export type ReviewState = "reviewed" | "awaiting-review" | "not-reviewed";

export interface ProvenanceData {
  sourceType: ProvenanceSourceType;
  /** Source name / document, e.g. "Quest panel · May 13" or "Oura · 30 d". */
  sourceName?: string;
  dateRange?: string;
  lastUpdated?: string;
  /** 0–100 completeness. Labelled as completeness, never a medical probability. */
  confidence?: number;
  conflicts?: number;
  review?: ReviewState;
}

export type PatientTabId =
  | "summary"
  | "twin"
  | "timeline"
  | "labs"
  | "reasoning"
  | "supplements"
  | "nof1-lab"
  | "protocols"
  | "reports";

export interface PatientDirectoryEntry {
  /** Route slug, e.g. `p-78435`. */
  id: string;
  /** Display identifier, e.g. `P-78435`. */
  mrn: string;
  name: string;
  initials: string;
  sex: "Female" | "Male";
  age: number;
  /** Display date of birth, MM/DD/YYYY. */
  dob: string;
  /** Header avatar gradient, [from, to]. */
  avatarGradient: [string, string];
  primaryGoals: string;
  careTeam: string[];
  lastVisit: string;
  nextVisit: string;
}

export interface HealthScore {
  value: number;
  band: string; // e.g. "Good"
  tone: Extract<Tone, "positive" | "warning" | "critical">;
  delta: { direction: "up" | "down"; text: string; tone: Tone };
}

export interface SystemAxis {
  label: string;
  /** 0..1 */
  value: number;
}

export interface RiskFlag {
  label: string;
  action: "Monitor" | "Review";
  tone: Extract<Tone, "warning" | "critical">;
}

export interface BiomarkerTrend {
  name: string;
  unit: string;
  value: string;
  status: "High" | "Low" | "Optimal";
  tone: Extract<Tone, "positive" | "warning" | "critical">;
  series: number[];
  trendWord: string;
}

export interface SleepSummary {
  score: number;
  band: string;
  tone: Extract<Tone, "positive" | "warning" | "critical">;
  series: number[];
  stats: { label: string; value: string }[];
}

export interface ActiveExperiment {
  name: string;
  goalLine: string;
  dayText: string; // e.g. "7 of 14"
  pct: number;
  outcomeLabel: string;
  direction: string; // e.g. "↑ 18%"
  directionTone: Tone;
}

export interface Hypothesis {
  name: string;
  sub: string;
  /** Internal evidence weighting — never a medical probability. */
  strength: number;
  /** Provenance of the data supporting this hypothesis. */
  provenance?: ProvenanceData;
}

/** A change to the clinical picture since the previous snapshot. */
export interface ReasoningChange {
  text: string;
  direction: "new" | "strengthened" | "weakened" | "resolved";
}

export interface ReasoningSnapshot {
  updatedOn: string;
  review:
    | { status: "awaiting" }
    | { status: "approved"; label: string };
  hypotheses: Hypothesis[];
  evidenceFor: string[];
  evidenceAgainst: string[];
  nextSteps: string[];
  /** Data the model flags as missing / would raise its confidence. */
  missingInformation?: string[];
  /** What changed since the last snapshot. */
  whatChanged?: ReasoningChange[];
  /** Safety considerations a practitioner must weigh before acting. */
  safetyConsiderations?: string[];
  /** Provenance summary for the snapshot as a whole. */
  provenance?: ProvenanceData;
}

/* ---------------------------------------------------------------- composer */

/**
 * Draft types the note/report composer can produce. Every draft is a
 * practitioner-review artifact — never final, never auto-sent.
 */
export type DraftKind =
  | "soap-note"
  | "patient-followup"
  | "lab-summary"
  | "supplement-rationale"
  | "nof1-interpretation"
  | "reasoning-summary"
  | "patient-message"
  | "referral";

export interface ComposerDraft {
  kind: DraftKind;
  title: string;
  /** Editable draft body (plain text). */
  body: string;
  sources: string[];
  dateRange?: string;
  missingInfo: string[];
  /** Drafts always start un-finalized; approval is an explicit practitioner step. */
  review: ReviewState;
  /** True for content that would reach the patient (extra review gate). */
  patientFacing: boolean;
}

export interface PatientSummary {
  healthScore: HealthScore;
  systems: SystemAxis[];
  priorities: string[];
  riskFlags: RiskFlag[];
  biomarkers: BiomarkerTrend[];
  sleep: SleepSummary;
  experiments: ActiveExperiment[];
  reasoning: ReasoningSnapshot;
  dataUpdated: string; // e.g. "2 min ago"
}

/* ---------------------------------------------------------------- right rail */

export type RailAlertIcon = "flask" | "clipboard" | "moon" | "sun";

export interface RailAlert {
  title: string;
  sub: string;
  icon: RailAlertIcon;
  tone: Tone;
}

export interface RailTask {
  title: string;
  who: string;
  priority: Priority;
}

export interface RailAppointment {
  name: string;
  when: string;
  initials: string;
  color: string;
}

export interface RightRailData {
  alerts: RailAlert[];
  tasks: RailTask[];
  openTaskCount: number;
  appointments: RailAppointment[];
}

/* --------------------------------------------------------- practice dashboard */

export type PracticeStatIcon =
  | "users"
  | "tasks"
  | "flask"
  | "layers"
  | "clock"
  | "calendar";

export interface PracticeStat {
  label: string;
  value: string;
  sub: string;
  subTone: Tone;
  icon: PracticeStatIcon;
  tone: Tone;
  href: string;
}

export type QueueItemType =
  | "Safety alert"
  | "Lab extraction"
  | "Reasoning update"
  | "Protocol approval"
  | "Experiment approval";

export interface QueueItem {
  type: QueueItemType;
  title: string;
  patient: string;
  when: string;
  priority: Priority;
  href: string;
}

export interface AbnormalBiomarker {
  marker: string;
  value: string;
  range: string;
  tone: Extract<Tone, "warning" | "critical">;
  patient: string;
  when: string;
}

export interface CompletedExperiment {
  name: string;
  patient: string;
  outcome: string;
  conclusion:
    | "Likely beneficial"
    | "Possibly beneficial"
    | "No measurable effect"
    | "Possibly harmful"
    | "Inconclusive";
  tone: Extract<Tone, "positive" | "slate">;
}

export interface RiskChange {
  name: string;
  initials: string;
  avatarColor: string;
  from: string;
  fromTone: Tone;
  to: string;
  toTone: Tone;
  href: string;
}

export interface AdherenceAlert {
  name: string;
  pct: number;
  tone: Extract<Tone, "warning" | "critical">;
  detail: string;
}

export interface TeamMemberLoad {
  name: string;
  initials: string;
  color: string;
  pct: number;
  open: number;
}

export interface PracticeDashboardData {
  dateLine: string;
  statusLine: string;
  stats: PracticeStat[];
  queue: QueueItem[];
  queueOpenCount: number;
  abnormal: AbnormalBiomarker[];
  experimentsDone: CompletedExperiment[];
  riskChanges: RiskChange[];
  lowAdherence: AdherenceAlert[];
  teamWorkload: TeamMemberLoad[];
}

/* -------------------------------------------------------------- command palette */

export type CommandIcon =
  | "note"
  | "upload"
  | "tube"
  | "home"
  | "users"
  | "reasoning";

export interface CommandItem {
  label: string;
  sub: string;
  kbd?: string;
  /** Either an icon or an initials tile. */
  icon?: CommandIcon;
  initials?: string;
  tone: Tone;
  /** Where the item navigates. Omitted for close-only actions. */
  href?: string;
}

export interface CommandGroup {
  label: string;
  items: CommandItem[];
}

/* ------------------------------------------------------------------ assistant */

export interface AssistantFact {
  text: string;
  badge: "Measured" | "Patient-reported" | "AI inference";
  tone: Extract<Tone, "navy" | "teal" | "ai">;
}

export interface AssistantSession {
  patientName: string;
  dataThrough: string;
  chips: string[];
  question: string;
  facts: AssistantFact[];
  sources: string[];
  missingInfo: string;
  reviewNotice: string;
}
