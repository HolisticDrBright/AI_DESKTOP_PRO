"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { CAMPAIGN_PROGRAM_LABEL, CAMPAIGN_PROGRAMS, workforceResponse, type CampaignOverview, type CampaignProgram, type EmailBlock, type EmailTemplate,
  type WorkforceRequest, type WorkforceResponse } from "@/campaigns/contract";
import { onWorkforceSessionChange } from "@/lib/workforce-session-change";

/**
 * The Campaigns screen (the marketing package): editable, for one practice. Every read and change goes through
 * /api/live/campaigns to the campaign engine; nothing here holds or computes campaign data.
 *
 * States that say different things look different:
 * - switched off (CAMPAIGN_ENGINE_ENABLED), loading, a failed read, and a refused one;
 * - "no subscribers yet" (a successful read of zero) against "can't read the campaign data" (a failure);
 * - a practice without the marketing package sees what the package does, and nothing it can edit or send.
 */
export type CampaignsState = { status: "off" } | { status: "loading" } | { status: "failed" } | { status: "refused" } | { status: "loaded"; overview: CampaignOverview };
type Act = (request: WorkforceRequest) => Promise<WorkforceResponse | null>;

async function call(request: WorkforceRequest): Promise<{ ok: true; data: WorkforceResponse } | { ok: false; status: number; detail: string }> {
  const response = await fetch("/api/live/campaigns", { method: "POST", credentials: "same-origin", cache: "no-store",
    headers: { "content-type": "application/json" }, body: JSON.stringify(request), signal: AbortSignal.timeout(25_000) });
  const payload = (await response.json().catch(() => ({}))) as { data?: unknown; error?: string; detail?: string };
  if (!response.ok) return { ok: false, status: response.status, detail: payload.detail ?? payload.error ?? "unavailable" };
  return { ok: true, data: workforceResponse.parse(payload.data) };
}

export function CampaignsScreen({ enabled }: { enabled: boolean }) {
  const [state, setState] = useState<CampaignsState>(enabled ? { status: "loading" } : { status: "off" });
  const [message, setMessage] = useState<{ tone: "ok" | "problem"; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const epoch = useRef(0);
  const load = useCallback(async () => {
    if (!enabled) return;
    const mine = ++epoch.current;
    setState({ status: "loading" });
    try {
      const result = await call({ action: "overview" });
      if (mine !== epoch.current) return;
      if (!result.ok) { setState(result.status === 401 || result.status === 403 ? { status: "refused" } : { status: "failed" }); return; }
      if (result.data.action === "overview") { const { action: _a, ...overview } = result.data; setState({ status: "loaded", overview }); }
    } catch { if (mine === epoch.current) setState({ status: "failed" }); }
  }, [enabled]);
  useEffect(() => {
    const counter = epoch;
    void load();
    const stop = onWorkforceSessionChange(() => { counter.current++; setState({ status: "refused" }); });
    return () => { counter.current++; stop(); };
  }, [load]);
  const act: Act = async request => {
    setBusy(true); setMessage(null);
    try {
      const result = await call(request);
      if (!result.ok) { setMessage({ tone: "problem", text: `Not done: ${result.detail.replace(/_/g, " ")}.` }); return null; }
      if (result.data.action === "done") setState({ status: "loaded", overview: result.data.refreshed });
      setMessage({ tone: "ok", text: "Saved." });
      return result.data;
    } catch { setMessage({ tone: "problem", text: "Not done: the campaign engine could not be reached. Nothing was changed." }); return null; }
    finally { setBusy(false); }
  };
  return <CampaignsView state={state} busy={busy} message={message} act={act} onRetry={() => void load()} />;
}

const box = "rounded-lg border border-line bg-card p-4";
const field = "mt-1 block w-full rounded border px-2 py-1 text-[13px]";
const button = "rounded border px-3 py-1 text-[13px] font-semibold disabled:opacity-50";

export function CampaignsView({ state, busy, message, act, onRetry }: { state: CampaignsState; busy: boolean; message: { tone: "ok" | "problem"; text: string } | null; act: Act; onRetry: () => void }) {
  if (state.status === "off") return <p role="status" data-testid="campaigns-off" className={box}>The campaign engine is switched off (CAMPAIGN_ENGINE_ENABLED). Nothing is collected or sent. See Outreach status for what turns it on.</p>;
  if (state.status === "loading") return <p role="status" data-testid="campaigns-loading" className={box}>Loading campaigns…</p>;
  if (state.status === "refused") return <p role="alert" data-testid="campaigns-refused" className={box}>Access changed. Sign in again and check your clinic access.</p>;
  if (state.status === "failed") return <p role="alert" data-testid="campaigns-failed" className={box}>Can&apos;t reach the campaign engine, so nothing below can be shown. This is not the same as having no subscribers. <button type="button" className="underline" onClick={onRetry}>Try again</button></p>;
  const o = state.overview;
  if (!o.entitlement.marketing) return <PackagePitch />;
  const marketer = o.role !== "none";
  return (
    <div className="space-y-4" data-testid="campaigns-loaded">
      {message ? <p role={message.tone === "ok" ? "status" : "alert"} data-testid="campaigns-message" className={message.tone === "ok" ? "text-ok" : "text-critical"}>{message.text}</p> : null}
      <Readiness overview={o} />
      <Lists overview={o} marketer={marketer} act={act} busy={busy} />
      {marketer ? <>
        <Settings overview={o} act={act} busy={busy} />
        <Domain overview={o} act={act} busy={busy} />
        <Templates overview={o} act={act} busy={busy} />
        <Sequences overview={o} act={act} busy={busy} />
        <Broadcasts overview={o} act={act} busy={busy} />
      </> : <p className={box} data-testid="campaigns-no-role">You can see counts. Editing, approving and seeing addresses need the marketing role, which a marketing admin of this practice grants.</p>}
      <Results overview={o} />
      {o.role === "marketing_admin" ? <Roles act={act} busy={busy} /> : null}
    </div>
  );
}

function PackagePitch() {
  return (
    <div className={box} data-testid="campaigns-not-entitled">
      <p className="font-semibold">The marketing package is not part of this practice&apos;s plan.</p>
      <p className="mt-2 text-[13px]">It adds email campaigns to people who ask to hear about a program: opt-in lists with a confirmation step, welcome sequences and broadcasts you approve before anything is sent, one-click unsubscribe, results by email, the leads board and channel tracking. It is included in the Growth and Complete tiers, or as an add-on. Nothing can be collected or sent without it.</p>
    </div>
  );
}

function Readiness({ overview }: { overview: CampaignOverview }) {
  return (
    <section className={box} data-testid="campaigns-readiness">
      <h2 className="font-semibold">Sending</h2>
      {overview.readiness.canSend ? <p className="text-[13px]">Ready: emails can be sent from {overview.settings.sendingDomain}.</p>
        : <ul className="mt-1 list-disc pl-5 text-[13px]">{overview.readiness.missing.map(m => <li key={m}>{m}</li>)}</ul>}
      <p className="mt-1 text-[12.5px] text-subtle">Contacts: {overview.entitlement.confirmedContacts} of {overview.entitlement.contactAllowance ?? "Unknown"} allowed.</p>
    </section>
  );
}

function Lists({ overview, marketer, act, busy }: { overview: CampaignOverview; marketer: boolean; act: Act; busy: boolean }) {
  const [shown, setShown] = useState<{ program: CampaignProgram; rows: { email: string; firstName: string | null; state: string }[] } | null>(null);
  const total = overview.lists.reduce((n, l) => n + l.counts.confirmed + l.counts.unsubscribed + l.counts.bounced + l.counts.complained, 0);
  return (
    <section className={box} data-testid="campaigns-lists">
      <h2 className="font-semibold">Lists</h2>
      {total === 0 ? <p className="text-[13px]" data-testid="campaigns-no-subscribers">No subscribers yet.</p> : null}
      <table className="mt-2 w-full text-left text-[13px]"><thead><tr><th>Program</th><th>Confirmed</th><th>Unsubscribed</th><th>Bounced</th><th>Complained</th><th /></tr></thead>
        <tbody>{overview.lists.map(l => <tr key={l.programKey} data-testid={`campaigns-list-${l.programKey}`}><td>{CAMPAIGN_PROGRAM_LABEL[l.programKey]}</td><td>{l.counts.confirmed}</td><td>{l.counts.unsubscribed}</td><td>{l.counts.bounced}</td><td>{l.counts.complained}</td>
          <td>{marketer ? <button type="button" className={button} disabled={busy} onClick={async () => { const r = await act({ action: "contacts", programKey: l.programKey }); if (r?.action === "contacts") setShown({ program: l.programKey, rows: r.contacts }); }}>Show addresses</button> : null}</td></tr>)}</tbody></table>
      {shown ? <div className="mt-2 text-[13px]" data-testid="campaigns-contacts"><p className="font-semibold">{CAMPAIGN_PROGRAM_LABEL[shown.program]}: first {shown.rows.length} addresses (export is off)</p>
        <ul>{shown.rows.map(r => <li key={r.email}>{r.email}{r.firstName ? ` (${r.firstName})` : ""}: {r.state}</li>)}</ul></div> : null}
    </section>
  );
}

function Settings({ overview, act, busy }: { overview: CampaignOverview; act: Act; busy: boolean }) {
  const s = overview.settings;
  const [draft, setDraft] = useState({ senderName: s.senderName ?? "", mailingAddress: s.mailingAddress ?? "", timeZone: s.timeZone ?? "", joinSlug: s.joinSlug ?? "", track: s.trackOpensAndClicks });
  return (
    <section className={box} data-testid="campaigns-settings">
      <h2 className="font-semibold">Practice settings (no defaults: each is yours to set)</h2>
      <div className="grid grid-cols-2 gap-3">
        <label className="text-[13px]">Sender name<input className={field} value={draft.senderName} onChange={e => setDraft({ ...draft, senderName: e.target.value })} /></label>
        <label className="text-[13px]">Sign-up address: /join/<b>slug</b>/…<input className={field} value={draft.joinSlug} onChange={e => setDraft({ ...draft, joinSlug: e.target.value })} /></label>
        <label className="col-span-2 text-[13px]">Mailing address (printed in every email)<input className={field} value={draft.mailingAddress} onChange={e => setDraft({ ...draft, mailingAddress: e.target.value })} /></label>
        <label className="text-[13px]">Time zone (emails go out 08:00 to 20:00 there)<input className={field} value={draft.timeZone} placeholder="America/Los_Angeles" onChange={e => setDraft({ ...draft, timeZone: e.target.value })} /></label>
        <label className="flex items-center gap-2 text-[13px]"><input type="checkbox" checked={draft.track} onChange={e => setDraft({ ...draft, track: e.target.checked })} />Count opens and clicks (totals only, never per person)</label>
      </div>
      <button type="button" className={`${button} mt-3`} disabled={busy} onClick={() => void act({ action: "update_settings", expectedVersion: s.version, senderName: draft.senderName.trim() || null,
        mailingAddress: draft.mailingAddress.trim() || null, timeZone: draft.timeZone.trim() || null, joinSlug: draft.joinSlug.trim() || null, trackOpensAndClicks: draft.track })}>Save settings</button>
    </section>
  );
}

function Domain({ overview, act, busy }: { overview: CampaignOverview; act: Act; busy: boolean }) {
  const [domain, setDomain] = useState(overview.settings.sendingDomain ?? "");
  const d = overview.domain;
  return (
    <section className={box} data-testid="campaigns-domain">
      <h2 className="font-semibold">Sending domain</h2>
      <p className="text-[13px]">Each practice sends from its own verified domain or subdomain. Add the records below at your DNS provider; sending starts only once they are found.</p>
      {overview.role === "marketing_admin" ? <div className="mt-2 flex gap-2"><input className={field} value={domain} placeholder="mail.yourpractice.example" onChange={e => setDomain(e.target.value)} />
        <button type="button" className={button} disabled={busy || !domain.trim()} onClick={() => void act({ action: "register_domain", domain: domain.trim() })}>Set up domain</button></div> : null}
      {d ? <>
        <p className="mt-2 text-[13px]" data-testid="campaigns-domain-status">{d.domain}: {d.verifiedForSending ? "verified" : "not verified yet"} (DKIM {d.dkim}, MAIL FROM {d.mailFrom}).</p>
        <table className="mt-1 w-full text-left text-[12px]"><thead><tr><th>Type</th><th>Name</th><th>Value</th></tr></thead>
          <tbody>{d.records.map(r => <tr key={`${r.type}-${r.name}-${r.value}`}><td>{r.type}</td><td className="break-all">{r.name}</td><td className="break-all">{r.value}</td></tr>)}</tbody></table>
        <button type="button" className={`${button} mt-2`} disabled={busy} onClick={() => void act({ action: "refresh_domain" })}>Check again</button>
      </> : <p className="mt-1 text-[13px]">No sending domain is set up.</p>}
    </section>
  );
}

const emptyBlocks: EmailBlock[] = [{ type: "paragraph", text: "Hello {{first_name|there}}," }, { type: "button", label: "Read about the program" }];
function Templates({ overview, act, busy }: { overview: CampaignOverview; act: Act; busy: boolean }) {
  const [editing, setEditing] = useState<{ templateId: string | null; version: number; programKey: CampaignProgram; kind: "sequence" | "broadcast"; name: string; subject: string; blocks: EmailBlock[] } | null>(null);
  const [problems, setProblems] = useState<string[] | null>(null);
  const [attorney, setAttorney] = useState("");
  const open = (t: EmailTemplate) => { setEditing({ templateId: t.templateId, version: t.version, programKey: t.programKey, kind: t.kind, name: t.name, subject: t.subject, blocks: t.blocks }); setProblems(null); };
  const current = editing?.templateId ? overview.templates.find(t => t.templateId === editing.templateId) : undefined;
  const needsAttorney = !!editing && overview.settings.attorneySignoffPrograms.includes(editing.programKey);
  return (
    <section className={box} data-testid="campaigns-templates">
      <h2 className="font-semibold">Emails</h2>
      <p className="text-[13px]">Every email is a draft until a named staff member approves it. The footer (why the reader gets it, your sender name, mailing address and unsubscribe link) is added to every email.</p>
      {overview.templates.length === 0 ? <p className="text-[13px]" data-testid="campaigns-no-templates">No emails yet. Install the starter drafts for a program below, or write one.</p> : null}
      <ul className="mt-2 text-[13px]">{overview.templates.map(t => <li key={t.templateId} data-testid={`campaigns-template-${t.templateId}`}>
        <button type="button" className="underline" onClick={() => open(t)}>{t.name}</button> · {CAMPAIGN_PROGRAM_LABEL[t.programKey]} · {t.kind} · version {t.version} · <b>{t.status === "approved" && t.approval?.version === t.version ? `approved by ${t.approval.by.name}` : "draft"}</b></li>)}</ul>
      <button type="button" className={`${button} mt-2`} onClick={() => { setEditing({ templateId: null, version: 0, programKey: "longevity-program", kind: "broadcast", name: "", subject: "", blocks: emptyBlocks }); setProblems(null); }}>New email</button>
      {editing ? <div className="mt-3 space-y-2 border-t pt-3" data-testid="campaigns-editor">
        <div className="grid grid-cols-3 gap-2">
          <label className="text-[13px]">Program<select className={field} value={editing.programKey} disabled={!!editing.templateId} onChange={e => setEditing({ ...editing, programKey: e.target.value as CampaignProgram })}>{CAMPAIGN_PROGRAMS.map(p => <option key={p} value={p}>{CAMPAIGN_PROGRAM_LABEL[p]}</option>)}</select></label>
          <label className="text-[13px]">Kind<select className={field} value={editing.kind} onChange={e => setEditing({ ...editing, kind: e.target.value as "sequence" | "broadcast" })}><option value="sequence">Sequence step</option><option value="broadcast">Broadcast</option></select></label>
          <label className="text-[13px]">Name<input className={field} value={editing.name} onChange={e => setEditing({ ...editing, name: e.target.value })} /></label>
        </div>
        <label className="block text-[13px]">Subject<input className={field} value={editing.subject} onChange={e => setEditing({ ...editing, subject: e.target.value })} /></label>
        {editing.blocks.map((b, i) => <div key={i} className="flex items-start gap-2 text-[13px]">
          <span className="w-20 pt-1">{b.type}</span>
          {b.type === "button" ? <input className={field} value={b.label} onChange={e => setEditing({ ...editing, blocks: editing.blocks.map((x, j) => j === i ? { type: "button", label: e.target.value } : x) })} />
            : b.type === "image" ? <span className="pt-1">{b.alt}</span>
              : <textarea className={field} value={b.text} onChange={e => setEditing({ ...editing, blocks: editing.blocks.map((x, j) => j === i ? { type: b.type, text: e.target.value } : x) })} />}
          <button type="button" className={button} onClick={() => setEditing({ ...editing, blocks: editing.blocks.filter((_, j) => j !== i) })}>Remove</button>
        </div>)}
        <div className="flex gap-2">{(["heading", "paragraph", "button"] as const).map(type => <button key={type} type="button" className={button}
          onClick={() => setEditing({ ...editing, blocks: [...editing.blocks, type === "button" ? { type, label: "Read about the program" } : { type, text: "" }] })}>Add {type}</button>)}</div>
        <p className="text-[12px] text-subtle">The only value filled in from the reader is the first name: {"{{first_name|there}}"}. A button always leads to the program&apos;s page.</p>
        <div className="flex flex-wrap gap-2">
          <button type="button" className={button} disabled={busy || !editing.name.trim() || !editing.subject.trim()} onClick={async () => {
            const r = await act({ action: "save_template", templateId: editing.templateId, expectedVersion: editing.version, draft: { programKey: editing.programKey, kind: editing.kind, name: editing.name.trim(), subject: editing.subject.trim(), blocks: editing.blocks } });
            if (r?.action === "done") { const saved = editing.templateId ? r.refreshed.templates.find(t => t.templateId === editing.templateId) : r.refreshed.templates.find(t => t.name === editing.name.trim() && t.version === 1); if (saved) open(saved); }
          }}>Save draft</button>
          {current ? <button type="button" className={button} disabled={busy} onClick={async () => { const r = await act({ action: "check_template", templateId: current.templateId }); if (r?.action === "check_template") setProblems(r.problems); }}>Check</button> : null}
          {current && needsAttorney ? <><input className="rounded border px-2 text-[13px]" placeholder="Attorney's name" value={attorney} onChange={e => setAttorney(e.target.value)} />
            <button type="button" className={button} disabled={busy || attorney.trim().length < 2} onClick={() => void act({ action: "record_attorney_signoff", templateId: current.templateId, version: current.version, attorneyName: attorney.trim() })}>Record attorney sign-off for version {current.version}</button></> : null}
          {current ? <button type="button" className={button} disabled={busy} onClick={() => void act({ action: "approve_template", templateId: current.templateId, version: current.version })}>Approve version {current.version}</button> : null}
        </div>
        {problems ? (problems.length ? <ul role="alert" className="list-disc pl-5 text-[13px] text-critical" data-testid="campaigns-problems">{problems.map(p => <li key={p}>{p}</li>)}</ul>
          : <p className="text-[13px]" data-testid="campaigns-no-problems">No problems found by the content check.</p>) : null}
      </div> : null}
    </section>
  );
}

function Sequences({ overview, act, busy }: { overview: CampaignOverview; act: Act; busy: boolean }) {
  return (
    <section className={box} data-testid="campaigns-sequences">
      <h2 className="font-semibold">Welcome sequences</h2>
      <p className="text-[13px]">A sequence starts when someone confirms and stops on unsubscribe, bounce or complaint. Editing an active sequence changes only what people have not reached yet.</p>
      {overview.sequences.map(seq => <SequenceEditor key={`${seq.programKey}-${seq.version}`} overview={overview} programKey={seq.programKey} act={act} busy={busy} />)}
    </section>
  );
}
function SequenceEditor({ overview, programKey, act, busy }: { overview: CampaignOverview; programKey: CampaignProgram; act: Act; busy: boolean }) {
  const seq = overview.sequences.find(s => s.programKey === programKey)!;
  const [steps, setSteps] = useState(seq.steps.map(s => ({ stepId: s.stepId as string | null, templateId: s.templateId, waitDays: s.waitDays })));
  const options = overview.templates.filter(t => t.programKey === programKey && t.kind === "sequence");
  return (
    <div className="mt-3 border-t pt-2 text-[13px]" data-testid={`campaigns-sequence-${programKey}`}>
      <p className="font-semibold">{CAMPAIGN_PROGRAM_LABEL[programKey]} · {seq.status}</p>
      {seq.steps.length === 0 ? <button type="button" className={button} disabled={busy} onClick={() => void act({ action: "install_starter", programKey })}>Install the starter drafts (three welcome emails and a broadcast)</button> : null}
      {steps.map((s, i) => <div key={i} className="mt-1 flex items-center gap-2">
        <span>Step {i + 1}: wait</span><input type="number" min={0} max={60} className="w-16 rounded border px-1" value={s.waitDays} onChange={e => setSteps(steps.map((x, j) => j === i ? { ...x, waitDays: Number(e.target.value) } : x))} /><span>days, then</span>
        <select className="rounded border px-1" value={s.templateId} onChange={e => setSteps(steps.map((x, j) => j === i ? { ...x, templateId: e.target.value } : x))}>{options.map(t => <option key={t.templateId} value={t.templateId}>{t.name}</option>)}</select>
        <button type="button" className={button} onClick={() => setSteps(steps.filter((_, j) => j !== i))}>Remove</button></div>)}
      <div className="mt-2 flex gap-2">
        {options.length ? <button type="button" className={button} onClick={() => setSteps([...steps, { stepId: null, templateId: options[0]!.templateId, waitDays: 3 }])}>Add step</button> : null}
        <button type="button" className={button} disabled={busy} onClick={() => void act({ action: "save_sequence", programKey, expectedVersion: seq.version, steps })}>Save steps</button>
        {seq.status === "active" ? <button type="button" className={button} disabled={busy} onClick={() => void act({ action: "set_sequence_status", programKey, expectedVersion: seq.version, status: "paused" })}>Pause</button>
          : seq.steps.length ? <button type="button" className={button} disabled={busy} onClick={() => void act({ action: "set_sequence_status", programKey, expectedVersion: seq.version, status: "active" })}>Start (every step must be approved)</button> : null}
      </div>
    </div>
  );
}

function Broadcasts({ overview, act, busy }: { overview: CampaignOverview; act: Act; busy: boolean }) {
  const [templateId, setTemplateId] = useState("");
  const [when, setWhen] = useState<Record<string, string>>({});
  const options = overview.templates.filter(t => t.kind === "broadcast");
  return (
    <section className={box} data-testid="campaigns-broadcasts">
      <h2 className="font-semibold">Broadcasts</h2>
      <p className="text-[13px]">One email to a list, now or at a set time. A test send to you comes first; only an approved email can be scheduled.</p>
      {overview.broadcasts.length === 0 ? <p className="text-[13px]">No broadcasts yet.</p> : null}
      <ul className="text-[13px]">{overview.broadcasts.map(b => {
        const t = overview.templates.find(x => x.templateId === b.templateId);
        return <li key={b.broadcastId} className="mt-1" data-testid={`campaigns-broadcast-${b.broadcastId}`}>{t?.name ?? "Unknown email"} · {CAMPAIGN_PROGRAM_LABEL[b.programKey]} · <b>{b.status}</b>{b.sendAt ? ` · ${new Date(b.sendAt).toLocaleString()}` : ""}
          {b.status === "draft" && t ? <span className="ml-2 inline-flex gap-1">
            <button type="button" className={button} disabled={busy} onClick={() => void act({ action: "test_send", templateId: t.templateId, broadcastId: b.broadcastId })}>Send a test to me</button>
            <input type="datetime-local" className="rounded border px-1" value={when[b.broadcastId] ?? ""} onChange={e => setWhen({ ...when, [b.broadcastId]: e.target.value })} />
            <button type="button" className={button} disabled={busy || !when[b.broadcastId]} onClick={() => void act({ action: "schedule_broadcast", broadcastId: b.broadcastId, sendAt: new Date(when[b.broadcastId]!).toISOString() })}>Schedule</button></span> : null}
          {b.status === "scheduled" || b.status === "sending" ? <button type="button" className={`${button} ml-2`} disabled={busy} onClick={() => void act({ action: "cancel_broadcast", broadcastId: b.broadcastId })}>Cancel</button> : null}</li>;
      })}</ul>
      {options.length ? <div className="mt-2 flex gap-2 text-[13px]"><select className="rounded border px-1" value={templateId} onChange={e => setTemplateId(e.target.value)}><option value="">Choose a broadcast email…</option>{options.map(t => <option key={t.templateId} value={t.templateId}>{t.name} ({CAMPAIGN_PROGRAM_LABEL[t.programKey]})</option>)}</select>
        <button type="button" className={button} disabled={busy || !templateId} onClick={() => { const t = options.find(x => x.templateId === templateId); if (t) void act({ action: "save_broadcast", broadcastId: null, programKey: t.programKey, templateId: t.templateId }); }}>New broadcast</button></div> : null}
    </section>
  );
}

function Results({ overview }: { overview: CampaignOverview }) {
  const tracked = overview.settings.trackOpensAndClicks;
  return (
    <section className={box} data-testid="campaigns-results">
      <h2 className="font-semibold">Results</h2>
      {overview.results.length === 0 ? <p className="text-[13px]" data-testid="campaigns-no-results">Nothing has been sent yet.</p> :
        <table className="mt-1 w-full text-left text-[13px]"><thead><tr><th>Email</th><th>Sent</th><th>Delivered</th><th>Bounced</th><th>Complained</th><th>Unsubscribed</th>{tracked ? <><th>Opened</th><th>Clicked</th></> : null}</tr></thead>
          <tbody>{overview.results.map(r => <tr key={r.templateId}><td>{overview.templates.find(t => t.templateId === r.templateId)?.name ?? "Unknown email"}</td><td>{r.sent}</td><td>{r.delivered}</td><td>{r.bounced}</td><td>{r.complained}</td><td>{r.unsubscribed}</td>{tracked ? <><td>{r.opened ?? "Unknown"}</td><td>{r.clicked ?? "Unknown"}</td></> : null}</tr>)}</tbody></table>}
      {!tracked ? <p className="mt-1 text-[12px] text-subtle">Opens and clicks are not counted for this practice.</p> : null}
    </section>
  );
}

function Roles({ act, busy }: { act: Act; busy: boolean }) {
  const [personId, setPersonId] = useState(""), [name, setName] = useState(""), [role, setRole] = useState<"marketing" | "marketing_admin">("marketing");
  return (
    <section className={box} data-testid="campaigns-roles">
      <h2 className="font-semibold">Marketing roles</h2>
      <div className="flex flex-wrap gap-2 text-[13px]">
        <input className="rounded border px-2" placeholder="Staff member's person id" value={personId} onChange={e => setPersonId(e.target.value)} />
        <input className="rounded border px-2" placeholder="Their name" value={name} onChange={e => setName(e.target.value)} />
        <select className="rounded border px-1" value={role} onChange={e => setRole(e.target.value as "marketing" | "marketing_admin")}><option value="marketing">marketing</option><option value="marketing_admin">marketing admin</option></select>
        <button type="button" className={button} disabled={busy || !personId || !name} onClick={() => void act({ action: "grant_role", personId: personId.trim(), role, name: name.trim() })}>Grant</button>
        <button type="button" className={button} disabled={busy || !personId} onClick={() => void act({ action: "revoke_role", personId: personId.trim() })}>Revoke</button>
      </div>
    </section>
  );
}
