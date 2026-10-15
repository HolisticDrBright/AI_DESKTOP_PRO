"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import { clinicNotificationSettingsView } from "@/contracts/patientNotifications";
import { onWorkforceSessionChange } from "@/lib/workforce-session-change";

import { PatientNotificationChoicesView, type PatientNotificationChoicesState } from "./PatientNotificationChoicesView";

/** Reading one linked patient's reminder and notice choices. It sends nothing that changes them. */
export function PatientNotificationChoicesPanel({ connectionId }: { connectionId: string }) {
  const [state, setState] = useState<PatientNotificationChoicesState>({ status: "loading" });
  const [busy, setBusy] = useState(false);
  const epoch = useRef(0);

  const load = useCallback(async () => {
    const generation = ++epoch.current;
    setBusy(true);
    setState({ status: "loading" });
    try {
      const response = await fetch("/api/live/patient-notification-settings", {
        method: "POST", credentials: "same-origin", cache: "no-store",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action: "read", connectionId }),
        signal: AbortSignal.timeout(25000),
      });
      if (epoch.current !== generation) return;
      if (response.status === 401 || response.status === 403) { setState({ status: "refused" }); return; }
      if (!response.ok) throw new Error("unavailable");
      const view = clinicNotificationSettingsView.parse(((await response.json()) as { data?: unknown }).data);
      if (epoch.current !== generation) return;
      // An answer about a different patient is not an answer about this one.
      if (view.connectionId !== connectionId) throw new Error("connection_mismatch");
      setState({ status: "loaded", view });
    } catch {
      if (epoch.current === generation) setState({ status: "unavailable" });
    } finally {
      if (epoch.current === generation) setBusy(false);
    }
  }, [connectionId]);

  useEffect(() => {
    const counter = epoch;
    void load();
    const stop = onWorkforceSessionChange(() => { counter.current++; setBusy(false); setState({ status: "refused" }); });
    return () => { counter.current++; stop(); };
  }, [load]);

  return <PatientNotificationChoicesView state={state} busy={busy} onRefresh={() => void load()} />;
}
