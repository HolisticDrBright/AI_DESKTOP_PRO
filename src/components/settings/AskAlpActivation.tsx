"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { CheckCircle2, ShieldAlert } from "lucide-react";
import { Card } from "@/components/ui/bits";

interface PromptRecord {
  version: string;
  content: string;
  refusal_text: string;
  disclosure_text: string;
  consent_text: string;
  care_team_fallback: string;
  signed_by: string | null;
  signed_date: string | null;
  content_sha256: string | null;
  configuration_sha256: string | null;
}

interface RuleRecord {
  code: string;
  pattern: string;
  fixed_response: string;
  severity: string;
}

interface ConfigurationStatus {
  active: PromptRecord | null;
  candidate: { prompt: PromptRecord; redflagRules: RuleRecord[]; confirmation: string } | null;
}

type State =
  | { kind: "loading" }
  | { kind: "blocked"; message: string }
  | { kind: "ready"; status: ConfigurationStatus };

async function safeError(response: Response): Promise<string> {
  const body = (await response.json().catch(() => ({}))) as { error?: { message?: string } };
  return body.error?.message ?? "The Ask ALP configuration service is unavailable right now.";
}

function CopyBlock({ title, content }: { title: string; content: string }) {
  return (
    <section className="rounded-xl border border-line bg-card px-4 py-3">
      <h3 className="m-0 text-[12px] font-bold text-ink">{title}</h3>
      <p className="m-0 mt-2 whitespace-pre-wrap text-[11.5px] leading-[1.65] text-body">{content}</p>
    </section>
  );
}

export function AskAlpActivation() {
  const [state, setState] = useState<State>({ kind: "loading" });
  const [reviewed, setReviewed] = useState<Set<string>>(new Set());
  const [confirmation, setConfirmation] = useState("");
  const [working, setWorking] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const response = await fetch("/api/live/ask-alp/configuration", { cache: "no-store" });
      if (!response.ok) {
        setState({ kind: "blocked", message: await safeError(response) });
        return;
      }
      const body = (await response.json()) as { data: ConfigurationStatus };
      setState({ kind: "ready", status: body.data });
    } catch {
      setState({ kind: "blocked", message: "The Ask ALP configuration service is unavailable right now." });
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  const candidate = state.kind === "ready" ? state.status.candidate : null;
  const ruleCodes = useMemo(() => candidate?.redflagRules.map((rule) => rule.code) ?? [], [candidate]);
  const readyToSign = Boolean(candidate && reviewed.has("prompt") && reviewed.has("refusal")
    && reviewed.has("disclosure") && reviewed.has("consent")
    && ruleCodes.every((code) => reviewed.has(code)) && confirmation === candidate.confirmation);

  const toggle = (key: string) => {
    setReviewed((current) => {
      const next = new Set(current);
      if (next.has(key)) next.delete(key); else next.add(key);
      return next;
    });
  };

  const activate = async () => {
    if (!candidate || !readyToSign || working) return;
    setWorking(true);
    setError(null);
    try {
      const response = await fetch("/api/live/ask-alp/configuration", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ version: candidate.prompt.version, ruleCodes, confirmation }),
      });
      if (!response.ok) {
        setError(await safeError(response));
        return;
      }
      await load();
    } catch {
      setError("The Ask ALP configuration service is unavailable right now.");
    } finally {
      setWorking(false);
    }
  };

  if (state.kind === "loading") return <p className="text-[12px] text-subtle">Loading the signed configuration record…</p>;
  if (state.kind === "blocked") {
    return <Card className="p-5"><p role="alert" className="m-0 text-[12px] text-critical">{state.message}</p></Card>;
  }
  if (state.status.active && !candidate) {
    const active = state.status.active;
    return (
      <Card className="p-5" data-testid="ask-alp-active">
        <div className="flex items-center gap-2 text-positive"><CheckCircle2 size={18} aria-hidden /><h2 className="m-0 text-[15px] font-bold">Ask ALP is signed and active</h2></div>
        <dl className="mt-4 grid grid-cols-[140px_1fr] gap-x-3 gap-y-2 text-[11.5px]">
          <dt className="font-semibold text-subtle">Version</dt><dd className="m-0 text-body">{active.version}</dd>
          <dt className="font-semibold text-subtle">Signed</dt><dd className="m-0 text-body">{active.signed_date ? new Date(active.signed_date).toLocaleString() : "Recorded"}</dd>
          <dt className="font-semibold text-subtle">Configuration hash</dt><dd className="m-0 break-all font-mono text-[10.5px] text-body">{active.configuration_sha256}</dd>
        </dl>
        <p className="m-0 mt-4 rounded-lg bg-number-tint px-3 py-2 text-[11px] leading-[1.55] text-body">Activation remains limited to synthetic users. It does not authorize real health information or remove the separate LLM-provider BAA deployment gate.</p>
      </Card>
    );
  }
  if (!candidate) return <Card className="p-5"><p className="m-0 text-[12px] text-subtle">No unsigned Ask ALP configuration is waiting for review.</p></Card>;

  const prompt = candidate.prompt;
  const checkboxClass = "mt-[2px] h-4 w-4 shrink-0 accent-action";
  return (
    <div className="flex flex-col gap-4" data-testid="ask-alp-activation">
      <div className="flex gap-3 rounded-xl border border-warning/30 bg-warning-tint px-4 py-3">
        <ShieldAlert size={18} className="mt-[1px] shrink-0 text-warning" aria-hidden />
        <p className="m-0 text-[11.5px] leading-[1.55] text-body">Clinical sign-off is attributable and permanent in the audit record. Review the exact language; the application will not load unsigned prompts or unsigned red-flag rules.</p>
      </div>

      <label className="flex cursor-pointer gap-3"><input className={checkboxClass} type="checkbox" checked={reviewed.has("prompt")} onChange={() => toggle("prompt")} /><span className="min-w-0 flex-1"><CopyBlock title={`System prompt — ${prompt.version}`} content={prompt.content} /></span></label>
      <label className="flex cursor-pointer gap-3"><input className={checkboxClass} type="checkbox" checked={reviewed.has("refusal")} onChange={() => toggle("refusal")} /><span className="min-w-0 flex-1"><CopyBlock title="Refusal language" content={prompt.refusal_text} /></span></label>
      <label className="flex cursor-pointer gap-3"><input className={checkboxClass} type="checkbox" checked={reviewed.has("disclosure")} onChange={() => toggle("disclosure")} /><span className="min-w-0 flex-1"><CopyBlock title="Patient disclosure" content={prompt.disclosure_text} /></span></label>
      <label className="flex cursor-pointer gap-3"><input className={checkboxClass} type="checkbox" checked={reviewed.has("consent")} onChange={() => toggle("consent")} /><span className="min-w-0 flex-1"><CopyBlock title="Patient consent language" content={prompt.consent_text} /></span></label>

      <section className="rounded-xl border border-line bg-card p-4">
        <h2 className="m-0 text-[14px] font-bold text-ink">Fixed red-flag responses</h2>
        <p className="mt-1 text-[11px] text-subtle">All {candidate.redflagRules.length} rules must be reviewed. A match bypasses AI generation and returns the fixed response verbatim.</p>
        <div className="mt-3 flex flex-col gap-3">
          {candidate.redflagRules.map((rule) => (
            <label key={rule.code} className="flex cursor-pointer gap-3 rounded-lg border border-hairline p-3">
              <input className={checkboxClass} type="checkbox" checked={reviewed.has(rule.code)} onChange={() => toggle(rule.code)} />
              <span className="min-w-0">
                <span className="block text-[11.5px] font-bold text-ink">{rule.code.replaceAll("_", " ")} · {rule.severity}</span>
                <span className="mt-1 block break-all font-mono text-[10px] text-faint">Match: {rule.pattern}</span>
                <span className="mt-2 block text-[11.5px] leading-[1.55] text-body">{rule.fixed_response}</span>
              </span>
            </label>
          ))}
        </div>
      </section>

      <Card className="p-4">
        <label htmlFor="ask-alp-confirmation" className="block text-[12px] font-bold text-ink">Type the exact confirmation</label>
        <p className="m-0 mt-1 text-[11px] leading-[1.5] text-body">Copy or type the phrase shown immediately below. It is not sent by email and it is not an authenticator code.</p>
        <p className="m-0 mt-1 font-mono text-[11px] text-subtle">{candidate.confirmation}</p>
        <input id="ask-alp-confirmation" value={confirmation} onChange={(event) => setConfirmation(event.target.value)} autoComplete="off" className="mt-3 h-9 w-full rounded-md border border-line bg-card px-3 font-mono text-[12px] text-body outline-none focus-visible:outline-2 focus-visible:outline-action" />
        {error && <p role="alert" className="m-0 mt-3 text-[11.5px] font-semibold text-critical">{error}</p>}
        <button type="button" disabled={!readyToSign || working} onClick={() => void activate()} className="mt-4 h-9 cursor-pointer rounded-md border-0 bg-action px-4 text-[12px] font-semibold text-white hover:bg-action-deep focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ink disabled:cursor-not-allowed disabled:opacity-45">{working ? "Signing…" : "Sign and activate synthetic Ask ALP"}</button>
        <p className="m-0 mt-3 text-[10.5px] leading-[1.5] text-faint">By activating, you attest that you reviewed the exact prompt, refusal, disclosure, consent, and each fixed response. The signing practitioner, timestamp, and hashes are written to the AWS audit record.</p>
      </Card>
    </div>
  );
}
