"use client";

import { useCallback, useEffect, useState } from "react";

import type { ConsultIntakeResponse } from "@/contracts/consultRequests";

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
async function post(body: unknown): Promise<{ data?: ConsultIntakeResponse; error?: string }> {
  const response = await fetch("/api/public/consult", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify(body), cache: "no-store",
  });
  const payload = await response.json().catch(() => ({})) as { data?: ConsultIntakeResponse; error?: string };
  if (!response.ok) return { error: payload.error ?? "service_unavailable" };
  return payload;
}

const EMPTY: ConsultFormValues = { name: "", email: "", phone: "", visitType: "", reasonCode: "" };

export function ConsultRequestForm({ slug }: { slug: string }) {
  const [link, setLink] = useState<Described | null>(null);
  const [unavailable, setUnavailable] = useState(false);
  const [values, setValues] = useState<ConsultFormValues>(EMPTY);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<Submitted | null>(null);
  const [failure, setFailure] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void post({ action: "describe", slug }).then(({ data, error }) => {
      if (cancelled) return;
      if (error || !data || data.action !== "describe") { setUnavailable(true); return; }
      setLink(data);
      setValues(current => ({ ...current, visitType: data.visitTypes[0], reasonCode: data.reasonCodes[0] }));
    });
    return () => { cancelled = true; };
  }, [slug]);

  const onChange = useCallback((field: keyof ConsultFormValues, value: string) => {
    setValues(current => ({ ...current, [field]: value }));
  }, []);

  const onSubmit = useCallback(() => {
    setBusy(true); setFailure(null);
    void post({
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
  if (result) return <ConsultRequestView state={{ kind: "received", result }} />;
  if (!link) return <ConsultRequestView state={{ kind: "loading" }} />;
  return <ConsultRequestView state={{ kind: "form", link, values, busy, failure, onChange, onSubmit }} />;
}
