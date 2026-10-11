"use client";

import { useCallback, useEffect, useState } from "react";

import type { ConsultIntakeResponse } from "@/contracts/consultRequests";
import { consultIntakeResponse } from "@/contracts/consultRequests";

import {
  ConsultRequestView, type ConsultFormValues, type Described, type Submitted,
} from "./ConsultRequestView";

/**
 * The public consult form: what it asks the server, and nothing about how it looks.
 *
 * The narrowness of what it sends is the point. There is no symptom field, no appointment
 * time, no patient identifier — a stranger cannot write anything clinical through this path,
 * and the page says so. What comes back is a reference code and nothing else.
 */
export async function postConsultRequest(body: unknown, fetcher: typeof fetch = fetch): Promise<{ data?: ConsultIntakeResponse; error?: string; status: number }> {
  try {
    const response = await fetcher("/api/public/consult", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify(body), cache: "no-store", signal: AbortSignal.timeout(20000),
    });
    const payload = await response.json().catch(() => ({})) as { data?: unknown; error?: string };
    if (!response.ok) return { error: payload.error ?? "service_unavailable", status: response.status };
    const parsed = consultIntakeResponse.safeParse(payload.data);
    if (!parsed.success || parsed.data.action !== (body as { action?: unknown } | null)?.action) return { error: "service_unavailable", status: 503 };
    return { data: parsed.data, status: response.status };
  } catch { return { error: "service_unavailable", status: 503 }; }
}

export function consultDescriptionOutcome(result: Awaited<ReturnType<typeof postConsultRequest>>):
  { kind: "ready"; link: Described } | { kind: "unavailable" } | { kind: "failed" } {
  if (result.status >= 200 && result.status < 300 && !result.error && result.data?.action === "describe") return { kind: "ready", link: result.data };
  // Keep the indistinguishable link refusal, but never claim a service outage
  // or malformed reply proves the link was withdrawn or expired.
  if ([400, 403, 409].includes(result.status)) return { kind: "unavailable" };
  return { kind: "failed" };
}

const EMPTY: ConsultFormValues = { name: "", email: "", phone: "", visitType: "", reasonCode: "" };

export function ConsultRequestForm({ slug }: { slug: string }) {
  const [link, setLink] = useState<Described | null>(null);
  const [unavailable, setUnavailable] = useState(false);
  const [readFailed, setReadFailed] = useState(false);
  const [readAttempt, setReadAttempt] = useState(0);
  const [values, setValues] = useState<ConsultFormValues>(EMPTY);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<Submitted | null>(null);
  const [failure, setFailure] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLink(null); setUnavailable(false); setReadFailed(false);
    void postConsultRequest({ action: "describe", slug }).then(reply => {
      if (cancelled) return;
      const outcome = consultDescriptionOutcome(reply);
      if (outcome.kind === "unavailable") { setUnavailable(true); return; }
      if (outcome.kind === "failed") { setReadFailed(true); return; }
      setLink(outcome.link);
      setValues(current => ({ ...current, visitType: outcome.link.visitTypes[0], reasonCode: outcome.link.reasonCodes[0] }));
    });
    return () => { cancelled = true; };
  }, [slug, readAttempt]);

  const onChange = useCallback((field: keyof ConsultFormValues, value: string) => {
    setValues(current => ({ ...current, [field]: value }));
  }, []);

  const onSubmit = useCallback(() => {
    setBusy(true); setFailure(null);
    void postConsultRequest({
      action: "submit", slug, name: values.name, email: values.email,
      phone: values.phone.trim().length > 0 ? values.phone : null,
      visitType: values.visitType, reasonCode: values.reasonCode, preferredWindows: [],
      timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone ?? null,
    }).then(({ data, error }) => {
      setBusy(false);
      if (error || !data || data.action !== "submit") { setFailure(error ?? "consult_request_refused"); return; }
      setResult(data);
    });
  }, [slug, values]);

  if (unavailable) return <ConsultRequestView state={{ kind: "unavailable" }} />;
  if (readFailed) return <ConsultRequestView state={{ kind: "failed", onRetry: () => setReadAttempt(attempt => attempt + 1) }} />;
  if (result) return <ConsultRequestView state={{ kind: "received", result }} />;
  if (!link) return <ConsultRequestView state={{ kind: "loading" }} />;
  return <ConsultRequestView state={{ kind: "form", link, values, busy, failure, onChange, onSubmit }} />;
}
