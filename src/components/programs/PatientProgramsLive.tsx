"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { GraduationCap } from "lucide-react";
import { api } from "@/adapters";
import { AdapterError } from "@/adapters/errors";
import type {
  LivePatientPrograms,
  LiveProgramLibrary,
  LiveProgramOffer,
} from "@/adapters/live-types";
import { Card, CardTitle } from "@/components/ui/bits";
import { Btn } from "@/components/ui/Btn";
import { useFeedback } from "@/lib/feedback";

const INPUT =
  "h-8 rounded-lg border border-line bg-card px-3 text-[12.5px] text-body outline-none focus-visible:outline-2 focus-visible:outline-action";

function errText(e: unknown): string {
  return e instanceof AdapterError ? e.message : "Something went wrong. Try again.";
}

/**
 * Patient-chart Programs card: the patient's REAL enrollments (pinned version,
 * persisted progress), plus enrollment into a published program. Eligibility,
 * version pinning, comp authorization, and the Stripe refusal are all
 * server-enforced; errors are shown verbatim as the honest outcome.
 */
export function PatientProgramsLive({ patientId }: { patientId: string }) {
  const { announce } = useFeedback();
  const [data, setData] = useState<LivePatientPrograms | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [library, setLibrary] = useState<LiveProgramLibrary | null>(null);
  const [enrolling, setEnrolling] = useState(false);
  const [programId, setProgramId] = useState("");
  const [offers, setOffers] = useState<LiveProgramOffer[]>([]);
  const [offerId, setOfferId] = useState("");
  const [compReason, setCompReason] = useState("");
  const [enrollError, setEnrollError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    setError(null);
    try {
      setData(await api.programs.forPatient(patientId));
    } catch (e) {
      setError(errText(e));
    }
  }, [patientId]);

  useEffect(() => {
    void load();
  }, [load]);

  const openEnroll = async () => {
    setEnrolling((v) => !v);
    if (!library) {
      try {
        setLibrary(await api.programs.library({ status: "published" }));
      } catch (e) {
        setEnrollError(errText(e));
      }
    }
  };

  const pickProgram = async (id: string) => {
    setProgramId(id);
    setOfferId("");
    setOffers([]);
    setEnrollError(null);
    if (!id) return;
    try {
      const studio = await api.programs.studio(id);
      setOffers(studio.offers.filter((o) => o.status === "active" && o.enrollmentOpen));
    } catch (e) {
      setEnrollError(errText(e));
    }
  };

  const selectedOffer = offers.find((o) => o.id === offerId) ?? null;

  const enroll = async () => {
    if (!programId || busy) return;
    setBusy(true);
    setEnrollError(null);
    try {
      const res = await api.programs.enroll({
        programId,
        patientId,
        offerId: offerId || null,
        activate: true,
        compReason: compReason.trim() || null,
      });
      announce(res.message);
      setEnrolling(false);
      setProgramId("");
      setOfferId("");
      setCompReason("");
      await load();
    } catch (e) {
      setEnrollError(errText(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card className="px-4 py-[13px]" data-testid="patient-programs">
      <div className="flex items-center gap-2">
        <CardTitle className="mb-0">
          <GraduationCap size={13} strokeWidth={2} className="text-brand" aria-hidden />
          Programs
        </CardTitle>
        <span className="flex-1" />
        <Btn size="sm" onClick={() => void openEnroll()} data-testid="enroll-toggle">
          {enrolling ? "Close" : "Enroll in program"}
        </Btn>
      </div>

      {error ? (
        <p className="m-0 mt-2 text-[12px] text-critical">{error}</p>
      ) : !data ? (
        <p className="m-0 mt-2 text-[12px] text-faint">Loading…</p>
      ) : data.enrollments.length === 0 ? (
        <p className="m-0 mt-2 text-[12px] text-faint" data-testid="patient-programs-empty">
          No program enrollments for this patient.
        </p>
      ) : (
        <ul className="m-0 mt-2 flex list-none flex-col gap-[6px] p-0" data-testid="patient-program-list">
          {data.enrollments.map((e) => (
            <li key={e.enrollmentId} className="text-[12.5px]" data-testid={`patient-enrollment-${e.enrollmentId}`}>
              <div className="flex flex-wrap items-baseline gap-2">
                <Link href={`/programs/${e.programId}`} className="font-semibold text-action hover:underline">
                  {e.programName}
                </Link>
                <span className="inline-flex h-[18px] items-center rounded-full bg-slate-tint px-2 text-[10px] font-bold text-slate-badge">
                  {e.status}
                </span>
                <span className="text-subtle" data-testid="pinned-version">
                  pinned to v{e.pinnedVersion ?? "—"}
                </span>
              </div>
              <p className="m-0 text-[11.5px] text-subtle" data-testid="enrollment-progress">
                {e.lessonsCompleted}/{e.lessonTotal} lessons complete · {e.progressCount} progress
                records{e.needsReviewCount > 0 ? ` · ${e.needsReviewCount} awaiting review` : ""}
                {e.expiresAt ? ` · access until ${new Date(e.expiresAt).toLocaleDateString()}` : ""}
              </p>
            </li>
          ))}
        </ul>
      )}

      {enrolling && (
        <div className="mt-3 flex flex-col gap-2 border-t border-hairline-2 pt-3" data-testid="enroll-form">
          <div className="flex flex-wrap items-center gap-2">
            <select
              className={INPUT}
              value={programId}
              onChange={(e) => void pickProgram(e.target.value)}
              aria-label="Program to enroll in"
              data-testid="enroll-program"
            >
              <option value="">Choose a published program…</option>
              {(library?.programs ?? [])
                .filter((p) => p.publishedVersion !== null && p.status === "published")
                .map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name} (v{p.publishedVersion})
                  </option>
                ))}
            </select>
            <select
              className={INPUT}
              value={offerId}
              onChange={(e) => setOfferId(e.target.value)}
              aria-label="Offer"
              disabled={!programId}
              data-testid="enroll-offer"
            >
              <option value="">No offer — direct enrollment</option>
              {offers.map((o) => (
                <option key={o.id} value={o.id}>
                  {o.name} · {o.paymentMode === "stripe" ? "Stripe (Not configured)" : o.paymentMode}
                </option>
              ))}
            </select>
          </div>
          {selectedOffer?.paymentMode === "manual_comp" && (
            <input
              className={INPUT}
              value={compReason}
              placeholder="Complimentary enrollment reason (required)"
              aria-label="Complimentary enrollment reason"
              onChange={(e) => setCompReason(e.target.value)}
              data-testid="enroll-comp-reason"
            />
          )}
          <div className="flex items-center gap-2">
            <Btn
              variant="primary"
              size="sm"
              disabled={!programId || busy}
              onClick={() => void enroll()}
              data-testid="enroll-submit"
            >
              Enroll (pins the published version)
            </Btn>
          </div>
          {enrollError && (
            <p className="m-0 text-[12px] font-semibold text-critical" data-testid="enroll-error">
              {enrollError}
            </p>
          )}
        </div>
      )}
    </Card>
  );
}
