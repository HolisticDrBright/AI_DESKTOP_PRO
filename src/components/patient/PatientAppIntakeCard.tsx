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

type PatientAppIntakeFocus = "all" | "labs" | "wearables";

export function PatientAppIntakeCard({
  patientId,
  focus = "all",
  initialData = null,
}: {
  patientId: string;
  focus?: PatientAppIntakeFocus;
  initialData?: LivePatientAppIntake | null;
}) {
  const [data, setData] = useState<LivePatientAppIntake | null>(initialData);
  const [error, setError] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => {
    if (initialData && reloadKey === 0) return;
    let active = true;
    setError(null);
    liveClient.patientAppIntake(patientId).then((value) => {
      if (active) setData(value);
    }).catch((cause: unknown) => {
      if (!active) return;
      setError(isAdapterError(cause) ? cause.safeMessage : "Unable to load the patient-reported app intake.");
    });
    return () => { active = false; };
  }, [initialData, patientId, reloadKey]);

  if (error) return <ClinicalError message={error} onRetry={() => setReloadKey((value) => value + 1)} />;
  if (!data) return <ClinicalLoading label="Loading patient-reported V2 intake…" />;

  const profile = data.wellnessProfile?.payload;
  const lifestyle = data.lifestyleProfile?.payload;
  const contraindications = data.contraindications?.payload;
  const intake = data.clinicalIntake?.payload;
  const latestWearable = data.wearableDailyRecords[0]?.payload;
  const labImports = data.labImports ?? [];
  const showProfile = focus === "all";
  const showWearables = focus === "all" || focus === "wearables";
  const showLabs = focus === "all" || focus === "labs";
  const heading = focus === "labs"
    ? "Laboratory markers received from V2"
    : focus === "wearables"
      ? "Wearable measurements received from V2"
      : "V2 health profile and intake";
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
          {heading}
        </CardTitle>
        <div className="flex flex-wrap gap-2">
          {showProfile ? (
            <Pill tone={data.sharingStatus === "granted" ? "positive" : "warning"}>
              intake {data.sharingStatus.replace("_", " ")}
            </Pill>
          ) : null}
          {showWearables ? (
            <Pill tone={data.wearablesSharingStatus === "granted" ? "positive" : "warning"}>
              wearables {data.wearablesSharingStatus.replace("_", " ")}
            </Pill>
          ) : null}
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
          {showProfile ? <section aria-labelledby="v2-profile-heading" className="rounded-lg border border-hairline-2 p-3">
            <h3 id="v2-profile-heading" className="m-0 mb-2 text-[12px] font-bold">Wellness and lifestyle</h3>
            <dl className="m-0 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-[11.5px]">
              <dt className="text-faint">Height</dt><dd className="m-0">{numeric(profile?.height, " in")}</dd>
              <dt className="text-faint">Weight</dt><dd className="m-0">{numeric(profile?.weight, " lb")}</dd>
              <dt className="text-faint">Goals</dt><dd className="m-0">{textList(profile?.goals)}</dd>
              <dt className="text-faint">Sleep</dt><dd className="m-0">{numeric(lifestyle?.sleepHours, " h/night")} · quality {numeric(lifestyle?.sleepQuality, "/10")}</dd>
              <dt className="text-faint">Stress</dt><dd className="m-0">{numeric(lifestyle?.stressLevel, "/10")}</dd>
              <dt className="text-faint">Exercise</dt><dd className="m-0">{numeric(lifestyle?.exerciseFrequency, "×/week")} · {textList(lifestyle?.exerciseTypes)}</dd>
            </dl>
          </section> : null}
          {showProfile ? <section aria-labelledby="v2-safety-heading" className="rounded-lg border border-hairline-2 p-3">
            <h3 id="v2-safety-heading" className="m-0 mb-2 text-[12px] font-bold">Patient-reported safety history</h3>
            <dl className="m-0 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-[11.5px]">
              <dt className="text-faint">Conditions</dt><dd className="m-0">{textList(contraindications?.conditions)}</dd>
              <dt className="text-faint">Medications</dt><dd className="m-0">{textList(contraindications?.medications)}</dd>
              <dt className="text-faint">Allergies</dt><dd className="m-0">{textList(contraindications?.allergies)}</dd>
              <dt className="text-faint">Pregnancy</dt><dd className="m-0">{contraindications?.pregnancyStatus ?? "Not reported"}</dd>
              <dt className="text-faint">Nursing</dt><dd className="m-0">{typeof contraindications?.nursing === "boolean" ? (contraindications.nursing ? "Yes" : "No") : "Not reported"}</dd>
            </dl>
          </section> : null}
          {showProfile ? <section aria-labelledby="v2-intake-heading" className="rounded-lg border border-hairline-2 p-3 lg:col-span-2">
            <h3 id="v2-intake-heading" className="m-0 mb-2 text-[12px] font-bold">Health intake</h3>
            <p className="m-0 text-[12px] font-medium text-body">{intake?.chiefComplaint?.description ?? "No chief complaint received."}</p>
            <p className="m-0 mt-1 text-[11.5px] text-subtle">
              Duration {intake?.chiefComplaint?.duration ?? "not reported"} · severity {numeric(intake?.chiefComplaint?.severity, "/10")} · {data.questionnaireResponses.length} questionnaire answers received
            </p>
          </section> : null}
          {showWearables ? <section aria-labelledby="v2-wearables-heading" className="rounded-lg border border-hairline-2 p-3 lg:col-span-2">
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
          </section> : null}
          {showLabs ? <section aria-labelledby="v2-labs-heading" className="rounded-lg border border-hairline-2 p-3 lg:col-span-2">
            <h3 id="v2-labs-heading" className="m-0 mb-2 text-[12px] font-bold">Laboratory markers received from V2</h3>
            {labImports.length > 0 ? (
              <div className="overflow-x-auto">
                <table className="w-full border-collapse text-left text-[11.5px]">
                  <thead><tr className="border-b border-hairline-2 text-faint"><th className="py-2 pr-3">Marker</th><th className="py-2 pr-3">Result</th><th className="py-2 pr-3">Panel</th><th className="py-2">Review state</th></tr></thead>
                  <tbody>{labImports.map((entry) => (
                    <tr key={entry.eventId} className="border-b border-hairline-2 last:border-0">
                      <td className="py-2 pr-3 font-medium text-body">{entry.markerName}</td>
                      <td className="py-2 pr-3">{entry.value} {entry.unit ?? ''}</td>
                      <td className="py-2 pr-3 text-subtle">{entry.panelName}</td>
                      <td className="py-2"><Pill tone={entry.state === 'accepted' ? 'positive' : entry.state === 'rejected' ? 'critical' : 'warning'}>{entry.state.replace('_', ' ')}</Pill></td>
                    </tr>
                  ))}</tbody>
                </table>
              </div>
            ) : <p className="m-0 text-[12px] text-faint">No laboratory markers received.</p>}
            <p className="m-0 mt-2 text-[11.5px] text-subtle">Pending markers are patient-supplied and remain outside the accepted laboratory record until reviewed.</p>
          </section> : null}
        </div>
      )}
    </Card>
  );
}
