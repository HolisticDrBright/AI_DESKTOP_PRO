"use client";

import { useCallback, useEffect, useState } from "react";
import { ExternalLink, FlaskConical, PackageSearch, ShieldCheck } from "lucide-react";
import { Card, CardTitle } from "@/components/ui/bits";
import { Btn } from "@/components/ui/Btn";
import {
  FULLSCRIPT_INTEGRATE_URL, fullscriptConnectionCopy, fullscriptPanelState, readFullscriptCallbackOutcome, type FullscriptPosture,
} from "@/lib/fullscript-presentation";

export function FullscriptIntegrationPanel() {
  const [posture, setPosture] = useState<FullscriptPosture | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [busy, setBusy] = useState<"connecting" | "disconnecting" | null>(null);
  const [outcome, setOutcome] = useState<ReturnType<typeof readFullscriptCallbackOutcome>>(null);
  const copy = fullscriptConnectionCopy(posture?.environment ?? null);
  const state = fullscriptPanelState({ posture, loadError, outcome, busy });
  // A refusal (this account, this clinic) and an outage are not "not configured": show the server's own clinician-safe
  // message, which names no clinic, and claim nothing about the connection until it can be read again.
  const load = useCallback(async () => {
    const response = await fetch("/api/live/fullscript/status", { cache: "no-store" }).catch(() => null);
    const payload = await response?.json().catch(() => null) as { data?: FullscriptPosture; error?: { message?: unknown } } | null;
    if (!response?.ok || !payload?.data) {
      setLoadError(typeof payload?.error?.message === "string" ? payload.error.message : "Fullscript's status couldn't be read right now. Try again in a moment.");
      return;
    }
    setLoadError(null);
    setPosture(payload.data);
  }, []);
  useEffect(() => { void load(); }, [load]);
  useEffect(() => {
    if (typeof window === "undefined") return;
    setOutcome(readFullscriptCallbackOutcome(new URL(window.location.href).searchParams.get("fullscript")));
  }, []);

  const connect = useCallback(async () => {
    setActionError(null);
    setOutcome(null);
    setBusy("connecting");
    const response = await fetch("/api/live/fullscript/oauth/start", { method: "POST" }).catch(() => null);
    const payload = await response?.json().catch(() => null) as { data?: { authorizationUrl?: string } } | null;
    const url = payload?.data?.authorizationUrl;
    if (!response?.ok || !url) {
      setBusy(null);
      return setActionError("Fullscript authorization could not be started, so nothing was changed. Try again in a moment.");
    }
    window.location.assign(url);
  }, []);

  const disconnect = useCallback(async () => {
    setActionError(null);
    setOutcome(null);
    setBusy("disconnecting");
    const response = await fetch("/api/live/fullscript/disconnect", { method: "POST" }).catch(() => null);
    const payload = await response?.json().catch(() => null) as { error?: { message?: unknown } } | null;
    setBusy(null);
    // The server says why, and whether the connection is still active; a failure never reads as disconnected.
    if (!response?.ok) setActionError(typeof payload?.error?.message === "string" ? payload.error.message : "Fullscript couldn't confirm the disconnect, so your connection is still active.");
    await load();
  }, [load]);

  return (
    <Card className="mt-4 px-4 py-4" data-testid="fullscript-integration">
      <div className="flex flex-wrap items-center gap-2">
        <CardTitle className="mb-0"><ShieldCheck size={14} aria-hidden /> Fullscript</CardTitle>
        <span data-testid="fullscript-state" className={`rounded-full px-2 py-0.5 text-[10px] font-bold ${state.connected ? "bg-positive-tint text-positive-deep" : "bg-slate-tint text-slate-badge"}`}>
          {state.badge}
        </span>
        {!loadError && posture?.environment ? <span className="text-[11px] text-subtle">{posture.environment === "sandbox_us" ? "US sandbox" : "US production"}</span> : null}
      </div>
      <p className="mt-2 text-[12px] text-subtle">
        OAuth is practitioner-scoped. The client secret and refresh tokens stay on the AWS server and never enter Desktop or the mobile app.
      </p>
      <p className="mt-2 text-[11.5px] text-subtle">{copy.guidance}</p>
      {posture?.environment === "sandbox_us" ? (
        <a className="mt-2 inline-flex text-[11.5px] font-semibold text-link hover:underline" href={FULLSCRIPT_INTEGRATE_URL} target="_blank" rel="noreferrer">
          Open Fullscript Integrate sandbox access
        </a>
      ) : null}
      <div className="mt-3 grid gap-2 sm:grid-cols-3">
        <p className="m-0 flex items-center gap-1.5 text-[11.5px]"><PackageSearch size={13} aria-hidden /> Catalog search and exact product details</p>
        <p className="m-0 flex items-center gap-1.5 text-[11.5px]"><ExternalLink size={13} aria-hidden /> Fresh practitioner treatment-plan links</p>
        <p className="m-0 flex items-center gap-1.5 text-[11.5px]"><FlaskConical size={13} aria-hidden /> Lab catalog, checkout, status, and results</p>
      </div>
      {state.showConnect ? <Btn className="mt-3" size="sm" disabled={!state.connectEnabled} onClick={() => void connect()}>{copy.button}</Btn> : null}
      {state.showDisconnect && posture ? (
        <div className="mt-3 flex flex-wrap items-center gap-3">
          <p className="m-0 text-[11px] text-positive-deep">Authorized as {posture.resourceOwnerType ?? "Fullscript user"}. Scopes: {posture.scopes?.join(", ") || "not reported"}.</p>
          <Btn size="sm" variant="outline" disabled={!state.disconnectEnabled} onClick={() => void disconnect()}>Disconnect</Btn>
        </div>
      ) : null}
      {state.reconnectMessage ? (
        <p className="mt-2 text-[11.5px] text-warning-deep" data-testid="fullscript-reconnect-required">{state.reconnectMessage}</p>
      ) : null}
      {state.notice ? <p role="status" className="mt-2 text-[11.5px] text-warning-deep" data-testid="fullscript-outcome">{state.notice}</p> : null}
      {loadError || actionError ? <p role="alert" className="mt-2 text-[11.5px] text-critical">{actionError ?? loadError}</p> : null}
      {state.setupHint ? <p className="mt-2 text-[11.5px] text-warning-deep">{state.setupHint}</p> : null}
    </Card>
  );
}
