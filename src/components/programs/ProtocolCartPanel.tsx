"use client";

import { useCallback, useState } from "react";

import type { ProtocolCartResponse } from "@/contracts/protocolCarts";

import { ProtocolCartView } from "./ProtocolCartView";

type Manifest = Extract<ProtocolCartResponse, { action: "read" }>;
type Compiled = Extract<ProtocolCartResponse, { action: "compile" }>;

/** The supplement list for one published program version. */
export function ProtocolCartPanel({ programVersionId }: { programVersionId: string }) {
  const [manifest, setManifest] = useState<Manifest | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const post = useCallback(async (request: unknown) => {
    const response = await fetch("/api/live/protocol-carts", {
      method: "POST", credentials: "same-origin", cache: "no-store",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(request), signal: AbortSignal.timeout(25000),
    });
    const payload = await response.json().catch(() => ({})) as { data?: unknown; error?: string };
    if (!response.ok) throw new Error(payload.error ?? "service_unavailable");
    return payload.data;
  }, []);

  const compile = useCallback(async () => {
    setBusy(true); setError(null); setNotice(null);
    try {
      const compiled = await post({ action: "compile", programVersionId }) as Compiled;
      setManifest(await post({ action: "read", manifestId: compiled.manifestId }) as Manifest);
      // A replay is worth saying: it means this list already existed for this version.
      if (compiled.replayed) setNotice("This list was already built for this version. Nothing was rebuilt.");
    } catch {
      setError("That list could not be built. The version may not be published, or it may name no supplements.");
    } finally { setBusy(false); }
  }, [post, programVersionId]);

  return <ProtocolCartView state={{ manifest, busy, error, notice, onCompile: () => void compile() }} />;
}
