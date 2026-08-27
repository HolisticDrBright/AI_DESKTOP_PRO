"use client";

import { useEffect, useState } from "react";
import { ClipboardCheck, ShieldCheck } from "lucide-react";
import { isAdapterError } from "@/adapters/errors";
import { liveClient } from "@/adapters/live-client";
import type { LivePatientAppIntake } from "@/adapters/live-types";
import { Card, CardTitle } from "@/components/ui/bits";
import { ClinicalError, ClinicalLoading } from "@/components/ui/ClinicalStates";
import { Pill } from "@/components/ui/Pill";

function dateLabel(value: string | undefined): string {
  if (!value) return "Not received";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "Not received" : date.toLocaleString();
}

function textList(values: string[] | undefined): string {
  const safe = values?.filter((value) => typeof value === "string" && value.trim()).slice(0, 12) ?? [];
  return safe.length > 0 ? safe.join(", ") : "None reported";
}

function numeric(value: number | undefined, suffix = ""): string {
  return typeof value === "number" && Number.isFinite(value) ? `${value}${suffix}` : "Not reported";
}

export function PatientAppIntakeCard({ patientId }: { patientId: string }) {
  const [data, setData] = useState<LivePatientAppIntake | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => {
    let active = true;
    setError(null);
    liveClient.patientAppIntake(patientId).then((value) => {
      if (active) setData(value);
    }).catch((cause: unknown) => {
      if (!active) return;
      setError(isAdapterError(cause) ? cause.safeMessage : "Unable to load the patient-reported app intake.");
    });
    return () => { active = false; };
  }, [patientId, reloadKey]);

  if (error) return <ClinicalError message={error} onRetry={() => setReloadKey((value) => value + 1)} />;
  if (!data) return <ClinicalLoading label="Loading patient-reported V2 intake…" />;

  const profile = data.wellnessProfile?.payload;
  const lifestyle = data.lifestyleProfile?.payload;
  const contraindications = data.contraindications?.payload;
  const intake = data.clinicalIntake?.payload;
  const latestWearable = data.wearableDailyRecords[0]?.payload;
  const lastReceived = [
    data.wellnessProfile?.receivedAt, data.lifestyleProfile?.receivedAt,
    data.contraindications?.receivedAt, data.clinicalIntake?.receivedAt,
    ...data.questionnaireResponses.map((entry) => entry.receivedAt),
    ...data.wearableDailyRecords.map((entry) => entry.receivedAt),
  ].filter((value): value is string => Boolean(value)).sort().at(-1);

  return (
    <Card className="px-4 py-[13px]" data-testid="patient-app-intake">
      <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
        <CardTitle>
          <ClipboardCheck size={13} strokeWidth={2} className="text-brand" aria-hidden />
          V2 health profile and intake
        </CardTitle>
        <div className="flex flex-wrap gap-2">
          <Pill tone={data.sharingStatus === "granted" ? "positive" : "warning"}>
            intake {data.sharingStatus.replace("_", " ")}
          </Pill>
          <Pill tone={data.wearablesSharingStatus === "granted" ? "positive" : "warning"}>
            wearables {data.wearablesSharingStatus.replace("_", " ")}
          </Pill>
        </div>
      </div>
      <div className="mb-3 flex items-start gap-2 rounded-[10px] border border-hairline-2 bg-sunken px-3 py-[10px] text-[11.5px] leading-[1.5] text-subtle">
        <ShieldCheck size={14} className="mt-[1px] shrink-0 text-brand" aria-hidden />
        <span>Patient reported from AI Longevity Pro V2. Review and reconcile it before treating any item as practitioner-verified chart data. Last received: {dateLabel(lastReceived)}.</span>
      </div>
      {data.connectionState === "not_connected" ? (
        <p className="m-0 text-[12px] text-faint">No verified V2 connection exists for this patient.</p>
      ) : (
        <div className="grid gap-3 lg:grid-cols-2">
          <section aria-labelledby="v2-profile-heading" className="rounded-lg border border-hairline-2 p-3">
            <h3 id="v2-profile-heading" className="m-0 mb-2 text-[12px] font-bold">Wellness and lifestyle</h3>
            <dl className="m-0 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-[11.5px]">
              <dt className="text-faint">Height</dt><dd className="m-0">{numeric(profile?.height, " in")}</dd>
              <dt className="text-faint">Weight</dt><dd className="m-0">{numeric(profile?.weight, " lb")}</dd>
              <dt className="text-faint">Goals</dt><dd className="m-0">{textList(profile?.goals)}</dd>
              <dt className="text-faint">Sleep</dt><dd className="m-0">{numeric(lifestyle?.sleepHours, " h/night")} · quality {numeric(lifestyle?.sleepQuality, "/10")}</dd>
              <dt className="text-faint">Stress</dt><dd className="m-0">{numeric(lifestyle?.stressLevel, "/10")}</dd>
              <dt className="text-faint">Exercise</dt><dd className="m-0">{numeric(lifestyle?.exerciseFrequency, "×/week")} · {textList(lifestyle?.exerciseTypes)}</dd>
            </dl>
          </section>
          <section aria-labelledby="v2-safety-heading" className="rounded-lg border border-hairline-2 p-3">
            <h3 id="v2-safety-heading" className="m-0 mb-2 text-[12px] font-bold">Patient-reported safety history</h3>
            <dl className="m-0 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-[11.5px]">
              <dt className="text-faint">Conditions</dt><dd className="m-0">{textList(contraindications?.conditions)}</dd>
              <dt className="text-faint">Medications</dt><dd className="m-0">{textList(contraindications?.medications)}</dd>
              <dt className="text-faint">Allergies</dt><dd className="m-0">{textList(contraindications?.allergies)}</dd>
              <dt className="text-faint">Pregnancy</dt><dd className="m-0">{contraindications?.pregnancyStatus ?? "Not reported"}</dd>
              <dt className="text-faint">Nursing</dt><dd className="m-0">{typeof contraindications?.nursing === "boolean" ? (contraindications.nursing ? "Yes" : "No") : "Not reported"}</dd>
            </dl>
          </section>
          <section aria-labelledby="v2-intake-heading" className="rounded-lg border border-hairline-2 p-3 lg:col-span-2">
            <h3 id="v2-intake-heading" className="m-0 mb-2 text-[12px] font-bold">Health intake</h3>
            <p className="m-0 text-[12px] font-medium text-body">{intake?.chiefComplaint?.description ?? "No chief complaint received."}</p>
            <p className="m-0 mt-1 text-[11.5px] text-subtle">
              Duration {intake?.chiefComplaint?.duration ?? "not reported"} · severity {numeric(intake?.chiefComplaint?.severity, "/10")} · {data.questionnaireResponses.length} questionnaire answers received
            </p>
          </section>
          <section aria-labelledby="v2-wearables-heading" className="rounded-lg border border-hairline-2 p-3 lg:col-span-2">
            <h3 id="v2-wearables-heading" className="m-0 mb-2 text-[12px] font-bold">Patient-supplied wearable measurements</h3>
            {latestWearable ? (
              <dl className="m-0 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-[11.5px] sm:grid-cols-[auto_1fr_auto_1fr]">
                <dt className="text-faint">Latest day</dt><dd className="m-0">{latestWearable.date ?? "Not reported"}</dd>
                <dt className="text-faint">Source</dt><dd className="m-0">{latestWearable.source ?? "Not reported"}</dd>
                <dt className="text-faint">Sleep</dt><dd className="m-0">{numeric(latestWearable.sleepDurationMinutes, " min")}</dd>
                <dt className="text-faint">Steps</dt><dd className="m-0">{numeric(latestWearable.steps)}</dd>
                <dt className="text-faint">HRV</dt><dd className="m-0">{numeric(latestWearable.hrv, " ms")}</dd>
                <dt className="text-faint">Resting HR</dt><dd className="m-0">{numeric(latestWearable.restingHr, " bpm")}</dd>
                <dt className="text-faint">Data quality</dt><dd className="m-0">{numeric(latestWearable.dataQualityScore, "%")}</dd>
                <dt className="text-faint">Days received</dt><dd className="m-0">{data.wearableDailyRecords.length}</dd>
              </dl>
            ) : (
              <p className="m-0 text-[12px] text-faint">No wearable measurements received.</p>
            )}
            <p className="m-0 mt-2 text-[11.5px] text-subtle">Review and reconcile these measurements before using them as practitioner-verified chart data.</p>
          </section>
        </div>
      )}
    </Card>
  );
}
