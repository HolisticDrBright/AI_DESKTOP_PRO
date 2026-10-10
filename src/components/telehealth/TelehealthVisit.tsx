"use client";

/**
 * In-visit screen: the Zoom meeting embedded in Desktop Pro (component view),
 * a running visit timer, flagged moments, quick notes, and a side panel that
 * opens the patient's real chart tabs.
 *
 * Nothing on this screen can start a meeting on its own. "Start visit" asks
 * the server for a visit session; the server resolves the appointment
 * through the practitioner's calendar access, the boundary re-checks the
 * consent authority and refuses without Zoom enabled under a verified BAA,
 * and the refusal is shown as-is. The SDK signature and host token arrive
 * once per start and are kept in component state only.
 *
 * Ending a visit is a server-side shutdown: the visit reads "ended" only once
 * Zoom confirms the meeting stopped. Leaving this client is not the same
 * claim and is never shown as one.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Flag, PhoneOff, ShieldAlert, Video } from "lucide-react";
import { api } from "@/adapters";
import { isAdapterError } from "@/adapters/errors";
import { telehealthAccessLost } from "@/lib/telehealth-access-loss";
import type { TelehealthDayVisit, TelehealthFlag, TelehealthSession, TelehealthVisit } from "@/adapters/telehealth.types";
import { Btn, BtnLink } from "@/components/ui/Btn";
import { Card, CardTitle } from "@/components/ui/bits";
import { ClinicalError, ClinicalLoading, ClinicalNote } from "@/components/ui/ClinicalStates";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { TextArea } from "@/components/ui/Field";
import { PageHeader } from "@/components/ui/PageHeader";
import { patientPath } from "@/lib/routes";
import { useFeedback } from "@/lib/feedback";
import {
  ConsentDialog,
  PhaseChip,
  fmtClock,
  fmtTime,
  loadVisitRow,
  noteHref,
  patientLabel,
  viewerTimeZone,
  visitPhase,
} from "./parts";
import { ZoomSdkLoadError, loadZoomMeetingSdk, type ZoomEmbeddedClient } from "./zoom-sdk";

type LoadState = "loading" | "ready" | "error";
/** Observable SDK bootstrap state (also exposed on the stage for the bootstrap test). */
type MeetingState = "idle" | "starting" | "loading_sdk" | "initialized" | "joining" | "connected" | "closed" | "failed";

export function TelehealthVisitScreen({ appointmentId, date }: { appointmentId: string; date: string }) {
  const router = useRouter();
  const { announce } = useFeedback();
  const [state, setState] = useState<LoadState>("loading");
  const [row, setRow] = useState<TelehealthDayVisit | null>(null);
  const [error, setError] = useState<{ message: string; signedOut: boolean } | null>(null);
  const [reloadKey, setReloadKey] = useState(0);
  const [consentOpen, setConsentOpen] = useState(false);

  const [meeting, setMeeting] = useState<MeetingState>("idle");
  const [meetingError, setMeetingError] = useState<string | null>(null);
  const [startedAt, setStartedAt] = useState<number | null>(null);
  const [elapsed, setElapsed] = useState(0);
  const [flags, setFlags] = useState<TelehealthFlag[]>([]);
  const [quickNotes, setQuickNotes] = useState("");
  const [confirmEnd, setConfirmEnd] = useState(false);
  const [ending, setEnding] = useState(false);

  const mountRef = useRef<HTMLDivElement>(null);
  const clientRef = useRef<ZoomEmbeddedClient | null>(null);
  const sessionRef = useRef<TelehealthSession | null>(null);
  const accessEpoch = useRef(0);

  const reload = useCallback(() => setReloadKey((k) => k + 1), []);
  const dropOpenedVisit = useCallback((e: unknown) => {
    if (!telehealthAccessLost(e)) return;
    accessEpoch.current += 1;
    const client = clientRef.current;
    clientRef.current = null;
    sessionRef.current = null;
    if (client?.leaveMeeting) void client.leaveMeeting().catch(() => undefined);
    setRow(null);
    setFlags([]);
    setQuickNotes("");
    setStartedAt(null);
    setElapsed(0);
    setConsentOpen(false);
    setConfirmEnd(false);
    setEnding(false);
    setMeeting("idle");
    setMeetingError(null);
    setState("error");
    setError({ message: isAdapterError(e) ? e.message : "This record isn't available.", signedOut: isAdapterError(e) && e.code === "unauthenticated" });
  }, []);

  useEffect(() => {
    let cancelled = false;
    setState("loading");
    loadVisitRow(appointmentId, date)
      .then((result) => {
        if (cancelled) return;
        setRow(result);
        setFlags(result.visit?.flags ?? []);
        setQuickNotes(result.visit?.quickNotes ?? "");
        if (result.visit?.startedAt) setStartedAt(Date.parse(result.visit.startedAt));
        setState("ready");
      })
      .catch((e: unknown) => {
        if (cancelled) return;
        dropOpenedVisit(e);
        setError({
          message: isAdapterError(e) ? e.message : "This visit could not be loaded.",
          signedOut: isAdapterError(e) && e.code === "unauthenticated",
        });
        setState("error");
      });
    return () => {
      cancelled = true;
    };
  }, [appointmentId, date, reloadKey, dropOpenedVisit]);

  useEffect(() => {
    if (startedAt === null) return;
    const tick = () => setElapsed(Math.floor((Date.now() - startedAt) / 1000));
    tick();
    const id = window.setInterval(tick, 1000);
    return () => window.clearInterval(id);
  }, [startedAt]);

  // Leave the meeting if the practitioner navigates away mid-visit. Leaving is
  // this client's departure only; the visit stays open on the server.
  useEffect(
    () => () => {
      accessEpoch.current += 1;
      const client = clientRef.current;
      clientRef.current = null;
      sessionRef.current = null;
      if (client?.leaveMeeting) void client.leaveMeeting().catch(() => undefined);
    },
    [appointmentId, date],
  );

  const startVisit = async () => {
    if (!row || !mountRef.current) return;
    const epoch = accessEpoch.current;
    const mount = mountRef.current;
    setMeeting("starting");
    setMeetingError(null);
    try {
      const result = await api.telehealth.start({
        appointmentId: row.appointmentId,
        date,
        timeZone: viewerTimeZone(),
        hostDisplayName: row.practitionerName ?? undefined,
      });
      if (epoch !== accessEpoch.current || mount !== mountRef.current) return;
      sessionRef.current = result.session;
      setRow({ ...row, visit: result.visit });
      if (result.visit.startedAt) setStartedAt(Date.parse(result.visit.startedAt));
      setMeeting("loading_sdk");
      const sdk = await loadZoomMeetingSdk();
      if (epoch !== accessEpoch.current || mount !== mountRef.current) return;
      const client = sdk.createClient();
      clientRef.current = client;
      await client.init({
        zoomAppRoot: mount,
        language: "en-US",
        patchJsMedia: true,
        leaveOnPageUnload: true,
        customize: {
          video: { isResizable: false, viewSizes: { default: { width: 880, height: 495 } } },
          meetingInfo: ["topic", "participant"],
        },
      });
      if (epoch !== accessEpoch.current || mount !== mountRef.current) {
        if (client.leaveMeeting) await client.leaveMeeting().catch(() => undefined);
        return;
      }
      setMeeting("initialized");
      client.on("connection-change", (payload) => {
        if (epoch !== accessEpoch.current || client !== clientRef.current) return;
        const stateValue = (payload as { state?: string } | undefined)?.state;
        if (stateValue === "Connected") setMeeting("connected");
        else if (stateValue === "Closed") setMeeting("closed");
        else if (stateValue === "Fail") {
          setMeeting("failed");
          setMeetingError("The Zoom connection failed. Reconnect to continue the visit.");
        }
      });
      if (epoch !== accessEpoch.current || client !== clientRef.current) {
        if (client.leaveMeeting) await client.leaveMeeting().catch(() => undefined);
        return;
      }
      setMeeting("joining");
      await client.join({
        signature: result.session.signature,
        meetingNumber: result.session.meetingNumber,
        password: result.session.passcode,
        userName: result.session.hostDisplayName,
        zak: result.session.zak,
      });
      if (epoch !== accessEpoch.current || client !== clientRef.current) {
        if (client.leaveMeeting) await client.leaveMeeting().catch(() => undefined);
        return;
      }
      setMeeting("connected");
      announce("Visit started. The Zoom meeting is open in Desktop Pro.");
    } catch (e) {
      if (epoch !== accessEpoch.current) return;
      dropOpenedVisit(e);
      setMeeting("failed");
      setMeetingError(
        e instanceof ZoomSdkLoadError
          ? `${e.message} The visit is open on the server; retry to load the meeting.`
          : isAdapterError(e)
            ? e.message
            : "The meeting could not be joined. Retry or contact support.",
      );
    }
  };

  const flagMoment = () => {
    const at = startedAt === null ? 0 : Math.floor((Date.now() - startedAt) / 1000);
    setFlags((current) => [...current, { atSeconds: at, label: `Flagged at ${fmtClock(at)}` }]);
    announce(`Moment flagged at ${fmtClock(at)}.`);
  };

  const endVisit = async () => {
    if (!row?.visit) return;
    const epoch = accessEpoch.current;
    setEnding(true);
    setMeetingError(null);
    try {
      // This client leaves; termination for everyone is the server's job below.
      const client = clientRef.current;
      clientRef.current = null;
      if (client?.leaveMeeting) {
        try {
          await client.leaveMeeting();
        } catch {
          /* local departure only; the server decides whether the meeting ended */
        }
      }
      if (epoch !== accessEpoch.current) return;
      const visit = await api.telehealth.end({
        appointmentId: row.appointmentId,
        date,
        timeZone: viewerTimeZone(),
        expectedVersion: row.visit.version,
        flags,
        quickNotes,
      });
      if (epoch !== accessEpoch.current) return;
      setRow({ ...row, visit });
      setConfirmEnd(false);
      if (visit.status === "ended") {
        announce("Visit ended. Zoom confirmed the meeting stopped. Opening the visit note.");
        router.push(noteHref(row));
      } else {
        setMeeting("closed");
        announce("Your notes are saved, but Zoom has not confirmed the meeting stopped. Retry the shutdown.");
      }
    } catch (e) {
      if (epoch !== accessEpoch.current) return;
      dropOpenedVisit(e);
      setMeetingError(isAdapterError(e) ? e.message : "The visit could not be ended.");
      setConfirmEnd(false);
    } finally {
      if (epoch === accessEpoch.current) setEnding(false);
    }
  };

  const onConsentRecorded = (visit: TelehealthVisit) => {
    setRow((current) => (current ? { ...current, visit } : current));
  };

  if (state === "loading") {
    return (
      <section className="mx-auto max-w-[1180px] px-[22px] pt-[18px] pb-6">
        <ClinicalLoading label="Loading the visit…" />
      </section>
    );
  }
  if (state === "error" || !row) {
    return (
      <section className="mx-auto max-w-[1180px] px-[22px] pt-[18px] pb-6">
        <PageHeader crumb="Workspace / Telehealth / Visit" title="Telehealth visit" />
        <ClinicalError
          message={error?.message ?? "This visit could not be loaded."}
          onRetry={reload}
          actionHref={error?.signedOut ? "/login" : undefined}
          actionLabel={error?.signedOut ? "Sign in" : undefined}
        />
      </section>
    );
  }

  const phase = visitPhase(row, true);
  const visit = row.visit;
  const ended = visit?.status === "ended";
  const shutdownPending = visit?.status === "ending";
  const cancelled = phase === "cancelled";
  const canStart = (phase === "ready" || phase === "in_visit") && !["connected", "joining", "initialized", "loading_sdk", "starting"].includes(meeting);
  const shutdownDetail = visit?.providerShutdown;

  return (
    <section data-screen-label="Telehealth visit" className="mx-auto max-w-[1180px] px-[22px] pt-[18px] pb-6">
      <PageHeader
        crumb="Workspace / Telehealth / Visit"
        title={
          <span className="flex items-center gap-2">
            {patientLabel(row)} <PhaseChip phase={phase} />
          </span>
        }
        sub={`${fmtTime(row.startsAt)} – ${fmtTime(row.endsAt)} · ${row.practitionerName ?? "Practitioner not recorded"}`}
        actions={
          <div className="flex items-center gap-2">
            <span
              aria-live="off"
              data-testid="visit-timer"
              className="rounded-lg border border-line bg-card px-3 py-[6px] font-mono text-[13px] font-semibold text-ink"
            >
              {startedAt === null ? "00:00" : fmtClock(elapsed)}
            </span>
            {!ended && !cancelled && (
              <Btn
                variant="danger"
                onClick={() => setConfirmEnd(true)}
                disabled={!visit || !(visit.status === "in_visit" || visit.status === "ending") || ending}
              >
                <PhoneOff size={13} strokeWidth={2} aria-hidden /> {shutdownPending ? "Retry shutdown" : "End visit"}
              </Btn>
            )}
            {(ended || shutdownPending) && (
              <BtnLink variant={ended ? "primary" : "outline"} href={noteHref(row)}>
                Open visit note
              </BtnLink>
            )}
          </div>
        }
      />

      {shutdownPending && (
        <div
          role="alert"
          data-testid="shutdown-pending"
          className="mb-3 rounded-[10px] border border-[rgba(214,84,74,0.4)] bg-critical-tint px-[13px] py-[10px] text-[12px] leading-[1.55] text-critical"
        >
          <strong>Zoom has not confirmed the meeting stopped.</strong>{" "}
          {shutdownDetail?.status === "failed"
            ? `The shutdown request failed (${shutdownDetail.detail ?? "no detail"}). The meeting may still be running for other participants, and recording or AI processing may continue.`
            : "A shutdown is in progress."}{" "}
          Your quick notes and flagged moments are saved. Retry the shutdown; you can write the note meanwhile, but the
          visit is not ended until Zoom confirms.
        </div>
      )}

      <div className="grid grid-cols-1 gap-3 xl:grid-cols-[1fr_320px]">
        <div className="flex flex-col gap-3">
          <Card className="overflow-hidden">
            <div
              ref={mountRef}
              data-zoom-mount
              data-zoom-state={meeting}
              data-testid="zoom-stage"
              className="relative flex min-h-[495px] items-center justify-center bg-[#0f1a26] text-white"
            >
              {meeting !== "connected" && (
                <div className="flex max-w-[460px] flex-col items-center gap-3 px-6 text-center">
                  <span className="flex h-12 w-12 items-center justify-center rounded-full bg-[rgba(255,255,255,0.1)]">
                    {phase === "consent_missing" || cancelled ? (
                      <ShieldAlert size={22} strokeWidth={1.75} aria-hidden />
                    ) : (
                      <Video size={22} strokeWidth={1.75} aria-hidden />
                    )}
                  </span>
                  {cancelled && (
                    <>
                      <p className="m-0 text-[14px] font-semibold">This appointment is cancelled</p>
                      <p className="m-0 text-[12.5px] leading-[1.5] text-[rgba(255,255,255,0.75)]">
                        A cancelled or no-show appointment cannot be started. Nothing here reaches Zoom.
                      </p>
                    </>
                  )}
                  {phase === "consent_missing" && (
                    <>
                      <p className="m-0 text-[14px] font-semibold">This visit cannot start</p>
                      <p className="m-0 text-[12.5px] leading-[1.5] text-[rgba(255,255,255,0.75)]">
                        There is no current telehealth and recording consent on record for this appointment. Record
                        it first; the server will refuse to open the meeting without it.
                      </p>
                      <Btn variant="primary" onClick={() => setConsentOpen(true)}>
                        Record consent
                      </Btn>
                    </>
                  )}
                  {ended && (
                    <>
                      <p className="m-0 text-[14px] font-semibold">Visit ended</p>
                      <p className="m-0 text-[12.5px] leading-[1.5] text-[rgba(255,255,255,0.75)]">
                        Zoom confirmed the meeting stopped. The AI Companion summary can be imported from the visit note.
                      </p>
                    </>
                  )}
                  {shutdownPending && (
                    <>
                      <p className="m-0 text-[14px] font-semibold">Meeting shutdown not confirmed</p>
                      <p className="m-0 text-[12.5px] leading-[1.5] text-[rgba(255,255,255,0.75)]">
                        You have left this meeting, but Zoom has not confirmed it ended for everyone. Use Retry shutdown.
                      </p>
                    </>
                  )}
                  {!ended && !shutdownPending && !cancelled && phase !== "consent_missing" && (
                    <>
                      <p className="m-0 text-[14px] font-semibold">
                        {meeting === "starting"
                          ? "Opening the visit…"
                          : meeting === "loading_sdk"
                            ? "Loading the Zoom Meeting SDK…"
                            : meeting === "initialized" || meeting === "joining"
                              ? "Connecting to Zoom…"
                              : meeting === "closed"
                                ? "Meeting closed"
                                : "Ready to start"}
                      </p>
                      <p className="m-0 text-[12.5px] leading-[1.5] text-[rgba(255,255,255,0.75)]">
                        Zoom opens inside this panel with the waiting room on. Mute, camera, screen share, chat and
                        participants use Zoom&apos;s own toolbar once connected. Recording and AI Companion notes
                        follow the practice&apos;s Zoom settings.
                      </p>
                      {canStart && (
                        <Btn variant="primary" onClick={() => void startVisit()}>
                          <Video size={13} strokeWidth={2} aria-hidden />{" "}
                          {meeting === "failed" || meeting === "closed" ? "Retry" : phase === "in_visit" ? "Rejoin visit" : "Start visit"}
                        </Btn>
                      )}
                    </>
                  )}
                  {meetingError && (
                    <p
                      role="alert"
                      data-testid="visit-refusal"
                      className="m-0 rounded-lg border border-[rgba(214,84,74,0.45)] bg-[rgba(214,84,74,0.14)] px-3 py-2 text-[12px] text-[#ffd9d6]"
                    >
                      {meetingError}
                    </p>
                  )}
                </div>
              )}
            </div>
          </Card>

          <Card className="p-4">
            <div className="flex items-center justify-between gap-3">
              <CardTitle>Quick notes for the call</CardTitle>
              <Btn size="sm" onClick={flagMoment} disabled={ended || cancelled}>
                <Flag size={12} strokeWidth={2} aria-hidden /> Flag this moment
              </Btn>
            </div>
            <p className="mt-1 mb-2 text-[11.5px] text-subtle">
              Saved with the visit when you end it, and offered to paste into the note. Not patient-facing.
            </p>
            <TextArea
              aria-label="Quick notes"
              value={quickNotes}
              onChange={(e) => setQuickNotes(e.target.value)}
              disabled={ended || cancelled}
              placeholder="Things to remember for the note…"
            />
            {flags.length > 0 && (
              <ul className="m-0 mt-3 flex list-none flex-wrap gap-2 p-0" aria-label="Flagged moments">
                {flags.map((flag, index) => (
                  <li key={`${flag.atSeconds}-${index}`} className="rounded-full bg-ai-tint px-[9px] py-[3px] text-[11px] font-semibold text-ai-deep">
                    {flag.label}
                  </li>
                ))}
              </ul>
            )}
          </Card>
        </div>

        <div className="flex flex-col gap-3">
          <Card className="p-4">
            <CardTitle>Chart</CardTitle>
            {row.patientId ? (
              <ul className="m-0 mt-2 flex list-none flex-col gap-1 p-0">
                {(
                  [
                    ["overview", "Overview"],
                    ["chart", "Chart & Timeline"],
                    ["labs", "Labs & Reasoning"],
                    ["protocol", "Protocol"],
                    ["supplements", "Supplements"],
                  ] as const
                ).map(([tab, label]) => (
                  <li key={tab}>
                    <Link
                      href={patientPath(row.patientId as string, tab)}
                      target="_blank"
                      rel="noreferrer"
                      className="block rounded-lg px-2 py-[6px] text-[12.5px] font-semibold text-action hover:bg-[rgba(37,99,199,0.06)] focus-visible:outline-2 focus-visible:outline-action"
                    >
                      {label} ↗
                    </Link>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="mt-2 mb-0 text-[12px] leading-[1.5] text-subtle">
                This booking is not linked to a chart. Link the patient-app request to a patient record to open
                their chart from here.
              </p>
            )}
            <p className="mt-3 mb-0 text-[11.5px] leading-[1.5] text-subtle">
              To show the patient a result, open the tab in its own window and share that window through
              Zoom&apos;s screen share — never this whole desktop.
            </p>
          </Card>

          <Card className="p-4">
            <CardTitle>Consent</CardTitle>
            {visit?.consents.length ? (
              <ul className="m-0 mt-2 list-none p-0 text-[12px] leading-[1.5] text-body">
                {visit.consents.map((consent) => (
                  <li key={consent.consentId}>
                    Combined telehealth + recording/AI notes, version {consent.artifactVersion} ·{" "}
                    {consent.method === "patient_app" ? "signed in the patient app" : "recorded by staff"} by{" "}
                    {consent.signerName}
                    {consent.patientLocation ? ` · patient in ${consent.patientLocation}` : ""}
                    {consent.status === "withdrawn" ? " · withdrawn" : ""}
                  </li>
                ))}
              </ul>
            ) : (
              <p className="mt-2 mb-0 text-[12px] text-warning-deep">Not signed.</p>
            )}
            <p className="mt-2 mb-0 text-[11.5px] leading-[1.5] text-subtle">
              Checked again against the practice&apos;s approved consent and the patient&apos;s current grant each
              time the visit starts.
            </p>
          </Card>

          <ClinicalNote>
            Nothing the AI drafts is final or patient-facing until you review it on the visit note.
          </ClinicalNote>
        </div>
      </div>

      <ConfirmDialog
        open={confirmEnd}
        title={shutdownPending ? "Retry ending the meeting?" : "End this visit?"}
        body="Desktop Pro asks Zoom to end the meeting for everyone and waits for Zoom to confirm. Your quick notes and flagged moments are saved with the visit. The visit note opens once Zoom confirms the meeting stopped."
        confirmLabel={ending ? "Ending…" : shutdownPending ? "Retry shutdown" : "End visit"}
        destructive
        onConfirm={() => void endVisit()}
        onCancel={() => setConfirmEnd(false)}
      />

      {consentOpen && <ConsentDialog row={row} date={date} open onClose={() => setConsentOpen(false)} onRecorded={onConsentRecorded} />}
    </section>
  );
}
