"use client";

import { useCallback, useState } from "react";

import type { RevisionWorkforceResponse } from "@/contracts/clinicalDisputes";

import { RevisionAnnounceView, type RevisionAnnounceState } from "./RevisionAnnounceView";

type Preview = Extract<RevisionWorkforceResponse, { action: "preview" }>;
type Published = Extract<RevisionWorkforceResponse, { action: "publish_notices" }>;

/** Announcing a revision for one published version. Scoped to the version the panel selected. */
export function RevisionAnnouncePanel({ toVersionId }: { toVersionId: string }) {
  const [preview, setPreview] = useState<Preview | null>(null);
  const [revisionClass, setRevisionClass] = useState<RevisionAnnounceState["revisionClass"]>("correction");
  const [statement, setStatement] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const post = useCallback(async (request: unknown) => {
    const response = await fetch("/api/live/care-governance", {
      method: "POST", credentials: "same-origin", cache: "no-store",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ surface: "revisions", request }),
      signal: AbortSignal.timeout(25000),
    });
    const payload = await response.json().catch(() => ({})) as { data?: unknown; error?: string };
    if (!response.ok) throw new Error(payload.error ?? "service_unavailable");
    return payload.data;
  }, []);

  const load = useCallback(async () => {
    setBusy(true); setError(null); setNotice(null);
    try { setPreview(await post({ action: "preview", toVersionId }) as Preview); }
    catch { setError("That version could not be checked. It may not be published. Nothing was sent."); }
    finally { setBusy(false); }
  }, [post, toVersionId]);

  const publish = useCallback(async () => {
    setBusy(true); setError(null); setNotice(null);
    try {
      const result = await post({
        action: "publish_notices", toVersionId, revisionClass,
        statement: statement.trim().length > 0 ? statement.trim() : null,
      }) as Published;
      setNotice(result.noticesCreated === 0
        ? "Nothing new to send — those patients had already been told about this version."
        : `${result.noticesCreated} patient${result.noticesCreated === 1 ? "" : "s"} notified. Their copies are unchanged.`);
      setPreview(null); setStatement("");
    } catch { setError("That could not be sent. Nothing was notified."); }
    finally { setBusy(false); }
  }, [post, revisionClass, statement, toVersionId]);

  return <RevisionAnnounceView state={{
    preview, revisionClass, statement, busy, error, notice,
    onPreview: () => void load(), onClass: setRevisionClass, onStatement: setStatement,
    onPublish: () => void publish(),
  }} />;
}
