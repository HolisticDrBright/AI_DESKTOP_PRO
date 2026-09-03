"use client";

import { useCallback, useEffect, useState } from "react";
import { ExternalLink, FlaskConical, PackageSearch, ShieldCheck } from "lucide-react";
import { Card, CardTitle } from "@/components/ui/bits";
import { Btn } from "@/components/ui/Btn";
import { FULLSCRIPT_INTEGRATE_URL, fullscriptConnectionCopy } from "@/lib/fullscript-presentation";

type Posture = {
  configured: boolean;
  connected: boolean;
  environment: "sandbox_us" | "production_us" | null;
  resourceOwnerType?: string | null;
  scopes?: string[];
  connectedAt?: string | null;
  reason?: string;
};

export function FullscriptIntegrationPanel() {
  const [posture, setPosture] = useState<Posture | null>(null);
  const [error, setError] = useState<string | null>(null);
  const environment = posture?.environment ?? null;
  const postureLoaded = posture !== null;
  const copy = fullscriptConnectionCopy(environment);
  const load = useCallback(async () => {
    setError(null);
    const response = await fetch("/api/live/fullscript/status", { cache: "no-store" });
    const payload = await response.json().catch(() => null) as { data?: Posture } | null;
    if (!response.ok || !payload?.data) throw new Error("Fullscript posture is unavailable.");
    setPosture(payload.data);
  }, []);
  useEffect(() => { void load().catch((e) => setError(e instanceof Error ? e.message : "Fullscript is unavailable.")); }, [load]);
  useEffect(() => {
    if (typeof window === "undefined" || !postureLoaded) return;
    if (new URL(window.location.href).searchParams.get("fullscript") === "connection_failed") {
      setError(copy.failure);
    }
  }, [copy.failure, postureLoaded]);

  const connect = useCallback(async () => {
    setError(null);
    const response = await fetch("/api/live/fullscript/oauth/start", { method: "POST" });
    const payload = await response.json().catch(() => null) as { data?: { authorizationUrl?: string } } | null;
    const url = payload?.data?.authorizationUrl;
    if (!response.ok || !url) return setError("Fullscript authorization could not be started.");
    window.location.assign(url);
  }, []);

  const disconnect = useCallback(async () => {
    setError(null);
    const response = await fetch("/api/live/fullscript/disconnect", { method: "POST" });
    if (!response.ok) return setError("Fullscript could not be disconnected.");
    await load();
  }, [load]);

  return (
    <Card className="mt-4 px-4 py-4" data-testid="fullscript-integration">
      <div className="flex flex-wrap items-center gap-2">
        <CardTitle className="mb-0"><ShieldCheck size={14} aria-hidden /> Fullscript</CardTitle>
        <span className={`rounded-full px-2 py-0.5 text-[10px] font-bold ${posture?.connected ? "bg-positive-tint text-positive-deep" : "bg-slate-tint text-slate-badge"}`}>
          {posture?.connected ? "Connected" : posture?.configured ? "Ready to connect" : "Not configured"}
        </span>
        {posture?.environment ? <span className="text-[11px] text-subtle">{posture.environment === "sandbox_us" ? "US sandbox" : "US production"}</span> : null}
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
      {!posture?.connected ? <Btn className="mt-3" size="sm" disabled={!posture?.configured} onClick={() => void connect()}>{copy.button}</Btn> : null}
      {posture?.connected ? (
        <div className="mt-3 flex flex-wrap items-center gap-3">
          <p className="m-0 text-[11px] text-positive-deep">Authorized as {posture.resourceOwnerType ?? "Fullscript user"}. Scopes: {posture.scopes?.join(", ") || "not reported"}.</p>
          <Btn size="sm" variant="outline" onClick={() => void disconnect()}>Disconnect</Btn>
        </div>
      ) : null}
      {error ? <p role="alert" className="mt-2 text-[11.5px] text-critical">{error}</p> : null}
      {!posture?.configured && !error ? <p className="mt-2 text-[11.5px] text-warning-deep">Add the sandbox credentials to the AWS secret and configure the encrypted token table before connecting.</p> : null}
    </Card>
  );
}
