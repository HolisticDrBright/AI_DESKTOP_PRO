"use client";

import { useCallback, useEffect, useState } from "react";
import { CheckCircle2, Copy, Link2, RefreshCw } from "lucide-react";
import { liveClient } from "@/adapters/live-client";
import { Card, CardTitle } from "@/components/ui/bits";
import { Btn } from "@/components/ui/Btn";
import { ClinicalNote } from "@/components/ui/ClinicalStates";
import { useFeedback } from "@/lib/feedback";

type Invitation = { token: string; expiresAt: string };

function formatCode(code: string): string {
  return `${code.slice(0, 4)}-${code.slice(4, 8)}-${code.slice(8)}`;
}

export function SyntheticPatientConnectionPanel({ patientId }: { patientId: string }) {
  const { announce } = useFeedback();
  const [invitation, setInvitation] = useState<Invitation | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [connectionState, setConnectionState] = useState<
    "loading" | "verified" | "paused" | "revoked" | "not_connected" | "unavailable"
  >("loading");

  const loadConnectionState = useCallback(async () => {
    try {
      const intake = await liveClient.patientAppIntake(patientId);
      setConnectionState(intake.connectionState);
      setError(null);
      return intake.connectionState;
    } catch {
      setConnectionState("unavailable");
      return "unavailable" as const;
    }
  }, [patientId]);

  useEffect(() => {
    void loadConnectionState();
  }, [loadConnectionState]);

  const createInvitation = async () => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const response = await fetch("/api/live/sync/synthetic-invite", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ patientId }),
      });
      const payload = (await response.json().catch(() => ({}))) as {
        data?: Invitation;
        error?: { message?: string };
      };
      if (!response.ok || !payload.data) {
        throw new Error(payload.error?.message || "A connection code could not be created.");
      }
      setInvitation(payload.data);
      announce("One-time connection code created.");
    } catch (cause) {
      const latestState = await loadConnectionState();
      if (latestState !== "verified" && latestState !== "paused") {
        setError(cause instanceof Error ? cause.message : "A connection code could not be created.");
      }
    } finally {
      setBusy(false);
    }
  };

  const code = invitation ? formatCode(invitation.token) : null;
  return (
    <div className="grid gap-3 pt-4" data-testid="synthetic-sync-panel">
      <ClinicalNote>
        <strong>Synthetic connection test.</strong> This links an anonymous Desktop test chart to a
        synthetic V2 account. Do not use real names, health information, labs, or wearable data.
      </ClinicalNote>
      <Card className="px-4 py-4">
        <CardTitle className="mb-2">
          <Link2 size={14} strokeWidth={2} className="text-brand" aria-hidden />
          Connect the V2 app
        </CardTitle>
        {(connectionState === "verified" || connectionState === "paused") ? (
          <div className="rounded-lg border border-positive/40 bg-positive-tint px-3 py-3" data-testid="synthetic-sync-connected">
            <div className="flex items-center gap-2 text-[12.5px] font-semibold text-positive-deep">
              <CheckCircle2 size={15} aria-hidden />
              {connectionState === "verified" ? "V2 app connected" : "V2 app connection paused"}
            </div>
            <p className="m-0 mt-2 text-[12px] leading-5 text-subtle">
              The original code was single-use and cannot be displayed again. If V2 asks for a code,
              fully close and reopen V2 while signed in to the same test account, then refresh its
              connection status. Do not create a second chart or invitation.
            </p>
            <Btn size="sm" className="mt-2" disabled={busy} onClick={() => void loadConnectionState()}>
              <RefreshCw size={12} aria-hidden /> Refresh status
            </Btn>
          </div>
        ) : (
          <p className="m-0 text-[12.5px] leading-5 text-subtle">
            Create a short-lived, single-use code here. In V2, open You → Practitioner Desktop Sync,
            enter the code, and choose Connect securely. No matching by email, name, phone, or birth
            date is used.
          </p>
        )}
        {!invitation && (connectionState === "not_connected" || connectionState === "revoked") && (
          <div className="mt-3">
            <Btn variant="primary" disabled={busy} onClick={() => void createInvitation()} data-testid="synthetic-sync-create">
              {busy ? "Creating…" : "Create connection code"}
            </Btn>
          </div>
        )}
        {connectionState === "loading" && (
          <p className="m-0 mt-3 text-[12px] text-faint">Checking the current connection…</p>
        )}
        {connectionState === "unavailable" && (
          <div className="mt-3">
            <p role="alert" className="m-0 text-[12px] font-semibold text-critical">
              The current connection status could not be loaded. Refresh the status before creating a code.
            </p>
            <Btn size="sm" className="mt-2" onClick={() => void loadConnectionState()}>
              <RefreshCw size={12} aria-hidden /> Refresh status
            </Btn>
          </div>
        )}
        {invitation && code && (
          <div className="mt-3 rounded-lg border border-warning/40 bg-warning-tint px-3 py-3" data-testid="synthetic-sync-code">
            <div className="flex items-center gap-2 text-[12px] font-semibold text-warning-deep">
              <CheckCircle2 size={15} aria-hidden /> Shown once
            </div>
            <div className="mt-2 flex flex-wrap items-center gap-2">
              <code className="text-[20px] font-bold tracking-[0.12em] text-ink">{code}</code>
              <Btn
                size="sm"
                onClick={() => void navigator.clipboard.writeText(code)
                  .then(() => announce("Connection code copied."))
                  .catch(() => announce("Select the code and copy it manually."))}
              >
                <Copy size={13} aria-hidden /> Copy
              </Btn>
            </div>
            <p className="m-0 mt-2 text-[11.5px] text-subtle">
              Expires {new Date(invitation.expiresAt).toLocaleString()}. Generate another code only
              if this one expires before it is claimed.
            </p>
          </div>
        )}
        {error && <p role="alert" className="m-0 mt-3 text-[12px] font-semibold text-critical">{error}</p>}
      </Card>
    </div>
  );
}
