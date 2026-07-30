"use client";

import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { MessageSquare } from "lucide-react";
import { api } from "@/adapters";
import { AdapterError } from "@/adapters/errors";
import type { LivePatientMessages, LiveThreadCategory } from "@/adapters/live-types";
import { Card, CardTitle } from "@/components/ui/bits";
import { Btn } from "@/components/ui/Btn";
import { ClinicalEmpty, ClinicalError, ClinicalLoading, ClinicalNote } from "@/components/ui/ClinicalStates";
import { useFeedback } from "@/lib/feedback";

const INPUT =
  "h-8 rounded-lg border border-line bg-card px-3 text-[12.5px] text-body outline-none focus-visible:outline-2 focus-visible:outline-action";
const LABEL = "mb-1 block text-[11px] font-bold tracking-[0.02em] text-subtle uppercase";

const CATEGORIES: { value: LiveThreadCategory; label: string }[] = [
  { value: "general", label: "General" },
  { value: "clinical_question", label: "Clinical question" },
  { value: "refill", label: "Refill" },
  { value: "lab", label: "Lab" },
  { value: "wearable_alert", label: "Wearable alert" },
  { value: "scheduling", label: "Scheduling" },
  { value: "billing", label: "Billing" },
  { value: "program_check_in", label: "Program check-in" },
  { value: "protocol_adherence", label: "Protocol adherence" },
  { value: "administrative", label: "Administrative" },
];

function errText(e: unknown): string {
  return e instanceof AdapterError ? e.message : "Something went wrong. Try again.";
}
function fmtDate(iso: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  return Number.isNaN(d.getTime())
    ? "—"
    : d.toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
}

/**
 * Patient-chart Messages tab: this patient's REAL conversation threads, with
 * persisted unread counts, opening straight into the Inbox workspace. A new
 * thread here is a real conversation row (access, category, and tenancy are
 * server-enforced) — nothing on this tab sends anything to the patient.
 */
export function PatientMessagesLive({ patientId }: { patientId: string }) {
  const router = useRouter();
  const { announce } = useFeedback();
  const [data, setData] = useState<LivePatientMessages | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [composing, setComposing] = useState(false);
  const [subject, setSubject] = useState("");
  const [category, setCategory] = useState<LiveThreadCategory>("general");
  const [createError, setCreateError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    setError(null);
    try {
      setData(await api.inbox.forPatient(patientId));
    } catch (e) {
      setError(errText(e));
    }
  }, [patientId]);

  useEffect(() => {
    void load();
  }, [load]);

  const createThread = async () => {
    if (!subject.trim() || busy) return;
    setBusy(true);
    setCreateError(null);
    try {
      const result = await api.inbox.createThread({ patientId, subject: subject.trim(), category });
      announce("Conversation created.");
      if (result.conversationId) {
        router.push(`/inbox?thread=${result.conversationId}`);
      } else {
        setComposing(false);
        setSubject("");
        await load();
      }
    } catch (e) {
      setCreateError(errText(e));
    } finally {
      setBusy(false);
    }
  };

  if (error) {
    return (
      <div className="pt-4">
        <ClinicalError message={error} onRetry={load} />
      </div>
    );
  }
  if (!data) {
    return (
      <div className="pt-4">
        <ClinicalLoading label="Loading this patient's conversations…" />
      </div>
    );
  }

  return (
    <div className="pt-4" data-testid="patient-messages">
      <Card className="px-4 py-[13px]">
        <div className="flex items-center gap-2">
          <CardTitle className="mb-0">
            <MessageSquare size={13} strokeWidth={2} className="text-brand" aria-hidden />
            Conversations
          </CardTitle>
          <span className="flex-1" />
          <Btn
            variant="ghost"
            onClick={() => {
              setComposing((v) => !v);
              setCreateError(null);
            }}
            data-testid="patient-new-thread-toggle"
          >
            {composing ? "Cancel" : "New conversation"}
          </Btn>
        </div>

        {composing && (
          <div className="mt-3 rounded-lg border border-line bg-well px-3 py-3">
            <div className="flex flex-wrap items-end gap-3">
              <div className="min-w-[220px] flex-1">
                <label htmlFor="pm-subject" className={LABEL}>
                  Subject
                </label>
                <input
                  id="pm-subject"
                  className={`${INPUT} w-full`}
                  value={subject}
                  onChange={(e) => setSubject(e.target.value)}
                  placeholder="What is this conversation about?"
                  data-testid="patient-new-thread-subject"
                />
              </div>
              <div>
                <label htmlFor="pm-category" className={LABEL}>
                  Category
                </label>
                <select
                  id="pm-category"
                  className={INPUT}
                  value={category}
                  onChange={(e) => setCategory(e.target.value as LiveThreadCategory)}
                >
                  {CATEGORIES.map((c) => (
                    <option key={c.value} value={c.value}>
                      {c.label}
                    </option>
                  ))}
                </select>
              </div>
              <Btn
                variant="primary"
                onClick={createThread}
                disabled={!subject.trim() || busy}
                data-testid="patient-new-thread-create"
              >
                {busy ? "Creating…" : "Create"}
              </Btn>
            </div>
            {createError && (
              <p role="alert" className="m-0 mt-2 text-[12px] font-semibold text-critical">
                {createError}
              </p>
            )}
          </div>
        )}

        {data.threads.length === 0 ? (
          <div className="mt-3">
            <ClinicalEmpty
              title="No conversations with this patient"
              message="Message threads appear here once one exists. Counts and threads are persisted records — nothing is simulated."
            />
          </div>
        ) : (
          <ul className="m-0 mt-3 list-none divide-y divide-line p-0" data-testid="patient-thread-list">
            {data.threads.map((t) => (
              <li key={t.id}>
                <button
                  type="button"
                  onClick={() => router.push(`/inbox?thread=${t.id}`)}
                  className="flex w-full items-center gap-2 px-1 py-2 text-left hover:bg-well focus-visible:outline-2 focus-visible:outline-action"
                  data-testid={`patient-thread-${t.id}`}
                >
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-[12.5px] font-semibold text-body">
                      {t.subject || "(no subject)"}
                    </span>
                    <span className="block text-[11.5px] text-faint">
                      {CATEGORIES.find((c) => c.value === t.category)?.label ?? t.category} · {t.status} ·{" "}
                      {t.messageCount} message{t.messageCount === 1 ? "" : "s"} · last activity{" "}
                      {fmtDate(t.lastMessageAt ?? t.createdAt)}
                    </span>
                  </span>
                  {t.urgent && (
                    <span className="inline-flex h-[18px] items-center rounded-full bg-critical-tint px-2 text-[10px] font-bold text-critical">
                      urgent language
                    </span>
                  )}
                  {t.priority !== "normal" && (
                    <span className="inline-flex h-[18px] items-center rounded-full bg-slate-tint px-2 text-[10px] font-bold text-slate-badge">
                      {t.priority}
                    </span>
                  )}
                  {t.unreadCount > 0 && (
                    <span
                      className="inline-flex h-[18px] min-w-[18px] items-center justify-center rounded-full bg-brand px-1.5 text-[10px] font-bold text-white"
                      aria-label={`${t.unreadCount} unread`}
                    >
                      {t.unreadCount}
                    </span>
                  )}
                </button>
              </li>
            ))}
          </ul>
        )}
      </Card>
      <div className="mt-3">
        <ClinicalNote>
          Opening a conversation goes to the Inbox workspace. No delivery provider is configured, so
          replies can be drafted but <strong>cannot be sent</strong> to the patient from anywhere in
          this application.
        </ClinicalNote>
      </div>
    </div>
  );
}
