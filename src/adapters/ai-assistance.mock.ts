import { USE_LIVE_API } from "./config";
import { getCarePlan } from "./careplan.mock";
import type { InboxThread } from "./inbox.mock";
import { listThreads } from "./inbox.mock";
import { getPatientSummary } from "./patients.mock";
import type { TodayData } from "./today.mock";
import { getWearables } from "./tracking.mock";

export type AiWorkflowPriority = "now" | "today" | "routine";
export type AiAssistanceStatus = "fixture" | "not-configured";

export interface AiAssistanceSource {
  id: string;
  label: string;
  detail: string;
  href?: string;
}

export interface AiAssistanceItem {
  id: string;
  title: string;
  detail: string;
  why: string;
  priority: AiWorkflowPriority;
  href?: string;
  patientName?: string;
  sourceIds: string[];
}

export interface AiAssistanceBrief {
  id: string;
  reviewKey: string;
  title: string;
  eyebrow: string;
  providerLabel: string;
  status: AiAssistanceStatus;
  generatedLabel: string;
  summary: string;
  items: AiAssistanceItem[];
  sources: AiAssistanceSource[];
  missingInformation: string[];
  safetyNotice: string;
}

export interface InboxAiAssist extends AiAssistanceBrief {
  suggestedReply: string;
}

function modeAware<T extends AiAssistanceBrief>(brief: T): T {
  if (!USE_LIVE_API) return brief;
  return {
    ...brief,
    providerLabel: "Not configured",
    status: "not-configured",
    summary:
      "AI assistance is disabled in live mode until an approved production provider is configured.",
    items: [],
    sources: [],
    missingInformation: [],
    safetyNotice:
      "No fixture output is shown in live mode and no patient data was sent to an AI provider.",
  };
}

function uniqueSources(sources: AiAssistanceSource[]): AiAssistanceSource[] {
  return [...new Map(sources.map((source) => [source.id, source])).values()];
}

export function buildTodayAiBrief(data: TodayData): AiAssistanceBrief {
  const items: AiAssistanceItem[] = [];
  const sources: AiAssistanceSource[] = [];

  for (const alert of data.attention.filter((row) => row.tone === "critical").slice(0, 2)) {
    const sourceId = `attention:${alert.id}`;
    sources.push({
      id: sourceId,
      label: "Alert feed",
      detail: alert.sub,
      href: alert.href,
    });
    items.push({
      id: `ai:${alert.id}`,
      title: alert.title,
      detail: alert.sub,
      why: "Surfaced first because the source workflow marks this as critical and unresolved.",
      priority: "now",
      href: alert.href,
      sourceIds: [sourceId],
    });
  }

  for (const row of data.labReviews.filter((item) => item.priority === "High").slice(0, 2)) {
    const sourceId = `queue:${row.id}`;
    sources.push({
      id: sourceId,
      label: "Review queue",
      detail: `${row.patientName} · ${row.title} · ${row.due}`,
      href: "/tasks",
    });
    items.push({
      id: `ai:${row.id}`,
      title: row.title,
      detail: `${row.patientName} · ${row.due}`,
      why: "High-priority lab review is waiting for practitioner action.",
      priority: "today",
      href: `/patients/${row.patientId}/labs`,
      patientName: row.patientName,
      sourceIds: [sourceId],
    });
  }

  for (const note of data.unsignedNotes.slice(0, 1)) {
    const sourceId = `note:${note.id}`;
    sources.push({
      id: sourceId,
      label: "Encounter chart",
      detail: `${note.patientName} · ${note.encounterLabel}`,
      href: `/patients/${note.patientId}/chart`,
    });
    items.push({
      id: `ai:${note.id}`,
      title: `Unsigned note · ${note.patientName}`,
      detail: `${note.encounterLabel} · ${note.ageLabel}`,
      why: "Unsigned documentation remains editable and is not yet locked into the chart.",
      priority: "today",
      href: `/patients/${note.patientId}/chart`,
      patientName: note.patientName,
      sourceIds: [sourceId],
    });
  }

  for (const thread of data.unreadThreads.filter((row) => row.priority === "High").slice(0, 1)) {
    const sourceId = `thread:${thread.id}`;
    sources.push({
      id: sourceId,
      label: "Secure inbox",
      detail: `${thread.patientName} · ${thread.subject}`,
      href: `/inbox?thread=${thread.id}`,
    });
    items.push({
      id: `ai:${thread.id}`,
      title: thread.subject,
      detail: `${thread.patientName} · unread ${thread.atLabel}`,
      why: "The thread is unread and already marked High priority in the inbox.",
      priority: "today",
      href: `/inbox?thread=${thread.id}`,
      patientName: thread.patientName,
      sourceIds: [sourceId],
    });
  }

  if (items.length === 0) {
    items.push({
      id: "ai:clear",
      title: "No priority conflicts detected",
      detail: "The currently loaded schedule, inbox, and review queue have no high-priority overlap.",
      why: "All reviewed operational sources are below the Today threshold.",
      priority: "routine",
      sourceIds: [],
    });
  }

  return modeAware({
    id: "today-ai-brief",
    reviewKey: "ai:today-brief",
    title: "AI daily brief",
    eyebrow: "Cross-workspace prioritization",
    providerLabel: "Deterministic demo assistant",
    status: "fixture",
    generatedLabel: "Generated from the current demo session",
    summary: `${items.filter((item) => item.priority === "now").length} immediate and ${items.filter((item) => item.priority === "today").length} same-day items surfaced from the schedule, inbox, review queue, and chart.`,
    items: items.slice(0, 5),
    sources: uniqueSources(sources),
    missingInformation: [
      "External phone, email, and wearable feeds are not connected in this demo.",
      "Priority reflects recorded workflow state, not a diagnosis or medical probability.",
    ],
    safetyNotice:
      "AI can prioritize and summarize. It cannot resolve, sign, send, order, or change a patient plan.",
  });
}

const THREAD_REPLY: Record<
  string,
  { summary: string; why: string; priority: AiWorkflowPriority; reply: string; missing: string[] }
> = {
  "th-priya-labs": {
    summary:
      "The patient reports worsening fatigue and becoming winded with stairs, and asks whether to move an iron panel earlier.",
    why:
      "New functional limitation is described in an unread High-priority message, so practitioner review should happen today.",
    priority: "now",
    reply:
      "Thank you for letting us know. Worsening fatigue and becoming winded with stairs deserves prompt review. If you develop chest pain, fainting, severe shortness of breath, or rapidly worsening symptoms, seek urgent care now. I am routing this to your practitioner today so the chart and lab timing can be reviewed before any changes are made.",
    missing: [
      "Onset, severity, symptoms at rest, chest pain, dizziness, bleeding, and current vital signs are not recorded in this thread.",
      "The attached ferritin trend has not been clinically verified in this demo.",
    ],
  },
  "th-avery-timing": {
    summary:
      "The patient is asking whether the recorded magnesium plan should be taken with dinner or closer to bedtime.",
    why:
      "This is a plan-clarification request. A chart-aware reply can reduce conflicting instructions, but the practitioner must verify the current product and dose.",
    priority: "routine",
    reply:
      "Thanks for checking before changing the timing. Your current plan lists magnesium glycinate one hour before bed. Please keep following the reviewed plan unless your practitioner updates it, and let us know if you have noticed any side effects or if another clinician gave you different instructions.",
    missing: [
      "Confirm the exact current product, dose, medication list, and whether another clinician advised a different schedule.",
    ],
  },
  "th-michael-reschedule": {
    summary: "The patient needs to move Thursday's follow-up because of work travel.",
    why: "This is an unresolved schedule request with two preferred time windows.",
    priority: "today",
    reply:
      "Thanks for the notice. We can check Friday morning and next Monday and will send the available options through the portal. Your current appointment is not changed until you confirm one of the new times.",
    missing: ["Calendar availability has not been checked yet."],
  },
  "th-marcus-refill": {
    summary: "The patient reports about one week of magnesium remaining and requests the same refill.",
    why: "Refill requests require current-plan, tolerance, and interaction review before approval.",
    priority: "today",
    reply:
      "Thanks for the heads-up. We will verify the current product, dose, tolerance, and medication list before confirming the refill. Please do not change the dose while the request is being reviewed.",
    missing: ["Current medication reconciliation and recent tolerance are not documented in this thread."],
  },
};

export function buildInboxAiAssist(thread: InboxThread): InboxAiAssist {
  const configured = THREAD_REPLY[thread.id] ?? {
    summary: `The ${thread.kind.replace("-", " ")} thread asks for follow-up on "${thread.subject}".`,
    why:
      "The thread is open and needs routing, a reviewed response, or a documented closure.",
    priority: thread.priority === "High" ? ("today" as const) : ("routine" as const),
    reply:
      "Thank you for your message. We have routed it to the appropriate team member for review. We will respond through the secure portal after the relevant chart information has been checked.",
    missing: ["The full chart context and any referenced external records still need practitioner review."],
  };

  const source: AiAssistanceSource = {
    id: `thread:${thread.id}`,
    label: "Secure portal thread",
    detail: `${thread.patientName} · ${thread.subject} · ${thread.atLabel}`,
    href: `/inbox?thread=${thread.id}`,
  };

  const result: InboxAiAssist = {
    id: `inbox-assist:${thread.id}`,
    reviewKey: `ai:inbox:${thread.id}`,
    title: "AI thread assist",
    eyebrow: "Triage and draft",
    providerLabel: "Deterministic demo assistant",
    status: "fixture",
    generatedLabel: "Based on this thread and recorded chart context",
    summary: configured.summary,
    items: [
      {
        id: `triage:${thread.id}`,
        title:
          configured.priority === "now"
            ? "Review now"
            : configured.priority === "today"
              ? "Review today"
              : "Routine review",
        detail: configured.why,
        why: "Workflow urgency only; this is not a diagnosis or medical probability.",
        priority: configured.priority,
        sourceIds: [source.id],
      },
    ],
    sources: [source],
    missingInformation: configured.missing,
    safetyNotice:
      "The suggested response is an editable draft. It cannot send until the practitioner reviews it and confirms the patient-facing action.",
    suggestedReply: configured.reply,
  };

  if (!USE_LIVE_API) return result;
  return {
    ...modeAware(result),
    suggestedReply: "",
  };
}

export function buildPatientChangeBrief(
  patientId: string,
  patientName: string,
): AiAssistanceBrief {
  const summary = getPatientSummary(patientId);
  const wearables = getWearables(patientId);
  const plans = getCarePlan(patientId);
  const latestThread = listThreads().find((thread) => thread.patientId === patientId);
  const sources: AiAssistanceSource[] = [];
  const items: AiAssistanceItem[] = [];

  if (summary) {
    const changingMarker = summary.biomarkers.find(
      (marker) => marker.tone === "critical" || marker.tone === "warning",
    );
    if (changingMarker) {
      const sourceId = `labs:${patientId}:${changingMarker.name}`;
      sources.push({
        id: sourceId,
        label: "Labs and biomarkers",
        detail: `${changingMarker.name} ${changingMarker.value} ${changingMarker.unit} · ${changingMarker.status} · ${changingMarker.trendWord}`,
        href: `/patients/${patientId}/labs`,
      });
      items.push({
        id: sourceId,
        title: `${changingMarker.name} remains ${changingMarker.status.toLowerCase()}`,
        detail: `${changingMarker.value} ${changingMarker.unit} · trend described as ${changingMarker.trendWord}`,
        why: "Included because the latest recorded status is outside the configured display band.",
        priority: changingMarker.tone === "critical" ? "today" : "routine",
        href: `/patients/${patientId}/labs`,
        patientName,
        sourceIds: [sourceId],
      });
    }
  }

  const wearable = wearables.series.find((series) => !series.good);
  if (wearable) {
    const sourceId = `wearable:${patientId}:${wearable.id}`;
    sources.push({
      id: sourceId,
      label: "Wearable trend",
      detail: `${wearable.label}: ${wearable.current} ${wearable.unit}; baseline ${wearable.baseline}`,
      href: `/patients/${patientId}/tracking?view=wearables`,
    });
    items.push({
      id: sourceId,
      title: `${wearable.label} changed from baseline`,
      detail: `${wearable.current} ${wearable.unit} now · baseline ${wearable.baseline}`,
      why: "A recorded wearable trend is moving in an unfavorable direction.",
      priority: wearables.alerts.some((alert) => alert.severity === "critical") ? "today" : "routine",
      href: `/patients/${patientId}/tracking?view=wearables`,
      patientName,
      sourceIds: [sourceId],
    });
  }

  const activePlan = plans.find((plan) => plan.status === "active");
  if (activePlan) {
    const sourceId = `protocol:${activePlan.id}`;
    sources.push({
      id: sourceId,
      label: "Active protocol",
      detail: `${activePlan.name} · ${activePlan.phase} · ${activePlan.adherencePct ?? "unknown"}% adherence`,
      href: `/patients/${patientId}/protocol`,
    });
    items.push({
      id: sourceId,
      title: `${activePlan.name} is active`,
      detail: `${activePlan.phase} · ${activePlan.adherencePct ?? "Adherence unknown"}${activePlan.adherencePct == null ? "" : "% adherence"} · review ${activePlan.nextReviewLabel}`,
      why: "The active protocol is relevant to the next encounter and has a scheduled review.",
      priority:
        activePlan.adherencePct != null && activePlan.adherencePct < 70 ? "today" : "routine",
      href: `/patients/${patientId}/protocol`,
      patientName,
      sourceIds: [sourceId],
    });
  }

  if (latestThread) {
    const sourceId = `thread:${latestThread.id}`;
    sources.push({
      id: sourceId,
      label: "Latest secure message",
      detail: `${latestThread.subject} · ${latestThread.atLabel}`,
      href: `/inbox?thread=${latestThread.id}`,
    });
    items.push({
      id: sourceId,
      title: latestThread.subject,
      detail: `${latestThread.status} thread · ${latestThread.atLabel}`,
      why: "The most recent patient communication may change visit priorities or follow-up.",
      priority: latestThread.priority === "High" ? "today" : "routine",
      href: `/inbox?thread=${latestThread.id}`,
      patientName,
      sourceIds: [sourceId],
    });
  }

  const missingInformation = [
    "Medication, allergy, pregnancy, and outside-care changes still require direct confirmation.",
    "The demo does not contain a complete reconciliation of external records since the last visit.",
  ];
  if (!summary) {
    missingInformation.unshift(
      "No longitudinal health-score or biomarker summary is available for this synthetic patient.",
    );
  }

  return modeAware({
    id: `patient-change-brief:${patientId}`,
    reviewKey: `ai:patient-change:${patientId}`,
    title: "What changed since last visit",
    eyebrow: "Longitudinal chart brief",
    providerLabel: "Deterministic demo assistant",
    status: "fixture",
    generatedLabel: "Built from the currently loaded synthetic chart",
    summary:
      items.length > 0
        ? `${items.length} chart changes or follow-up points were found across labs, wearables, protocols, and messages.`
        : "The available demo chart does not contain enough longitudinal data to identify a change.",
    items: items.slice(0, 5),
    sources: uniqueSources(sources),
    missingInformation,
    safetyNotice:
      "This brief is a navigation and drafting aid. The practitioner must verify every source before using it in assessment or treatment.",
  });
}
