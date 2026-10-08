"use client";

import { useEffect, useRef, useState } from "react";

import type { ProtocolCartRequest } from "@/contracts/protocolCarts";
import { createProtocolCartSession, emptyProtocolCartState } from "@/lib/protocolCartSession";
import { onWorkforceSessionChange } from "@/lib/workforce-session-change";

import { ProtocolCartView } from "./ProtocolCartView";

/** The supplement list for one published program version. */
export function ProtocolCartPanel({ programVersionId }: { programVersionId: string }) {
  // A new selection gets an empty scope immediately, not one render later.
  return <ProtocolCartScopedPanel key={programVersionId} programVersionId={programVersionId} />;
}

async function post(request: ProtocolCartRequest, lifetime: AbortSignal) {
  const response = await fetch("/api/live/protocol-carts", {
    method: "POST", credentials: "same-origin", cache: "no-store",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(request), signal: AbortSignal.any([lifetime, AbortSignal.timeout(25000)]),
  });
  const payload = await response.json().catch(() => ({})) as { data?: unknown; error?: string };
  if (!response.ok) throw new Error(payload.error ?? "service_unavailable");
  return payload.data;
}

function ProtocolCartScopedPanel({ programVersionId }: { programVersionId: string }) {
  const [state, setState] = useState(emptyProtocolCartState);
  const session = useRef<ReturnType<typeof createProtocolCartSession> | null>(null);
  useEffect(() => {
    let active = createProtocolCartSession(programVersionId, post, setState);
    session.current = active;
    const invalidate = () => {
      active.dispose();
      active = createProtocolCartSession(programVersionId, post, setState);
      session.current = active;
      setState({ ...emptyProtocolCartState, error: "Access may have changed. Refresh this list to check current access." });
    };
    const stop = onWorkforceSessionChange(invalidate);
    const hide = () => { if (document.hidden) invalidate(); };
    document.addEventListener("visibilitychange", hide);
    return () => {
      stop();
      document.removeEventListener("visibilitychange", hide);
      active.dispose();
      if (session.current === active) session.current = null;
    };
  }, [programVersionId]);
  return <ProtocolCartView state={{ ...state, onCompile: () => void session.current?.compile() }} />;
}
