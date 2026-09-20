"use client";
import { useEffect, useRef, useState, type RefObject } from "react";
import { Card } from "@/components/ui/bits";
import { AdapterError } from "@/adapters/errors";
import { requestRecordingAuthority } from "@/lib/recording-authority-client";
import { type RecordingAuthorityRequest, type RecordingConsentRelease, type RecordingWorkspace } from "@/contracts/encounterRecordingAuthority";
import { AwsRecordingCapturePanel } from "./AwsRecordingCapturePanel";
import { AwsRecordingTranscriptionPanel } from "./AwsRecordingTranscriptionPanel";
import type { AwsBrowserRecording } from "@/lib/aws-browser-recording";
import { onWorkforceSessionChange } from "@/lib/workforce-session-change";

const SCOPE_LABEL = { recording: "Recording", transcription: "Transcription", ai_drafting: "AI drafting" };
const inputStyle = "block w-full rounded border border-line bg-surface px-2 py-1.5 text-ink";
const buttonStyle = "rounded border border-line px-3 py-2 text-sm disabled:opacity-50";
type GrantTarget = { participantId: string; release: RecordingConsentRelease };

/** Consent and capture remain independent server authorities. Workspace reloads
 * stop input but must not destroy the page-owned unsent tail or exact retry. */
export function AwsRecordingConsentPanel({ encounterId, ownerRef, encounterOpen }: {
  encounterId: string; ownerRef: RefObject<AwsBrowserRecording | null>; encounterOpen: boolean;
}) {
  const [locale, setLocale] = useState("");
  const [jurisdiction, setJurisdiction] = useState("");
  const [workspace, setWorkspace] = useState<RecordingWorkspace | null>(null);
  const [target, setTarget] = useState<GrantTarget | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState("");
  const [retry, setRetry] = useState<RecordingAuthorityRequest | null>(null);
  const controller = useRef<AbortController | null>(null);
  const running = useRef(false);
  const [identityChanged, setIdentityChanged] = useState(false);
  const [finishedHere, setFinishedHere] = useState<string | null>(null);
  useEffect(() => {
    const active = new AbortController(); controller.current = active;
    const unsubscribe = onWorkforceSessionChange(() => {
      active.abort(); ownerRef.current?.dispose(); setIdentityChanged(true);
      setWorkspace(null); setTarget(null); setRetry(null);
    });
    return () => { active.abort(); unsubscribe(); };
  }, [ownerRef]);

  function resetSelection() { ownerRef.current?.interrupt(); setWorkspace(null); setTarget(null); setError(null); setNotice(""); }
  async function perform(request: RecordingAuthorityRequest, participantId?: string) {
    const signal = controller.current?.signal;
    if (!signal || signal.aborted || running.current) return;
    running.current = true; setBusy(true); setError(null); setNotice("");
    const mutation = !["workspace", "readConsentRelease"].includes(request.action);
    if (mutation || request.action === "workspace") ownerRef.current?.interrupt();
    if (request.action === "workspace") { setWorkspace(null); setTarget(null); }
    if (request.action === "readConsentRelease") setTarget(null);
    let saved = false;
    try {
      const result = await requestRecordingAuthority(request, signal);
      if (signal.aborted) return;
      if (request.action === "workspace" && "encounterId" in result.data) setWorkspace(result.data);
      else if (request.action === "readConsentRelease" && "content" in result.data && participantId) {
        const selected = workspace?.consentReleases.find(r => r.id === request.releaseId);
        if (!selected || selected.contentSha256 !== result.data.contentSha256 || selected.scope !== result.data.scope
          || selected.locale !== result.data.locale || selected.jurisdiction !== result.data.jurisdiction)
          throw new AdapterError("conflict");
        setTarget({ participantId, release: result.data });
      } else if (mutation) {
        saved = true; setRetry(null); setTarget(null); setWorkspace(null);
        setNotice("Saved. Reloading the current consent workspace.");
        const fresh = await requestRecordingAuthority({ action: "workspace", encounterId, locale, jurisdiction }, signal);
        if (signal.aborted) return;
        if ("encounterId" in fresh.data) setWorkspace(fresh.data);
        setNotice("Saved and confirmed by the consent service.");
      }
    } catch (e) {
      if (signal.aborted) return;
      const safe = e instanceof AdapterError ? e : new AdapterError("unavailable");
      setError(saved ? "The change was saved, but the latest workspace could not load. Load consent workspace again."
        : safe.code === "unauthenticated" ? "Sign in again to renew your workforce authorization, then return to this encounter."
          : safe.code === "forbidden" ? "The service refused this action. Your access or the required consent evidence may need review."
            : safe.code === "conflict" ? "The consent record changed. Load the workspace and review the current document before trying again."
              : safe.safeMessage);
      if (mutation && !saved && ["unavailable", "unknown"].includes(safe.code)) {
        setRetry(request);
        setNotice("The result is uncertain. Retry the same request below; do not create a second entry.");
      } else setRetry(null);
      if (safe.code === "unauthenticated" || safe.code === "forbidden" || safe.code === "conflict") {
        setWorkspace(null); setTarget(null);
      }
    } finally { running.current = false; if (!signal.aborted) setBusy(false); }
  }

  if (identityChanged) return <Card className="mt-4 p-4"><p role="alert">Your workforce session changed. Recording has stopped and local audio was cleared. Reload this encounter after signing in to review server recovery; this does not confirm remote deletion.</p></Card>;
  return <Card className="mt-4 space-y-4 p-4">
    <h2 className="m-0 text-base font-semibold">Recording consent — AWS</h2>
    <p className="text-sm text-subtle">Recording consent does not enable audio capture by itself. A separate service readiness check is required. Transcription runs only for finished recordings through its own reviewed service; AI drafting is not available.</p>
    <div role="status" aria-live="polite">{busy ? "Contacting the consent service…" : notice}</div>
    {error ? <p role="alert" className="text-sm text-red-700">{error}</p> : null}
    {retry ? <div className="space-y-2">
      <p className="text-sm">A previous change needs confirmation. Its original request is kept only while this page remains open.</p>
      <button className={buttonStyle} disabled={busy} onClick={() => void perform(retry)}>Retry the same request</button>
    </div> : null}
    <form onSubmit={event => { event.preventDefault(); void perform({ action: "workspace", encounterId, locale, jurisdiction }); }}>
      <fieldset disabled={busy || !!retry} className="flex flex-wrap items-end gap-3">
        <label className="text-sm">Consent locale
          <input className={inputStyle} required minLength={2} maxLength={20} placeholder="e.g. en-US" value={locale}
            onChange={e => { setLocale(e.target.value); resetSelection(); }} />
        </label>
        <label className="text-sm">Reviewed jurisdiction
          <input className={inputStyle} required maxLength={80} placeholder="Use your reviewed jurisdiction" value={jurisdiction}
            onChange={e => { setJurisdiction(e.target.value); resetSelection(); }} />
        </label>
        <button className={buttonStyle} type="submit">Load consent workspace</button>
      </fieldset>
    </form>
    <p className="text-xs text-subtle">Choose the applicable reviewed locale and jurisdiction explicitly. No other jurisdiction or unsigned document will be substituted.</p>
    {workspace ? <fieldset disabled={busy || !!retry} className="space-y-4">
      <p className="text-sm">Encounter status: {workspace.encounterStatus}. {workspace.activeCapture
        ? "A capture was found when this workspace loaded. Review its current status below. Microphone resume requires its original open recording page."
        : "No open capture was found at the last workspace load."}</p>
      {workspace.consentReleases.length === 0 ? <p className="text-sm">No current reviewed consent documents match this locale and jurisdiction. Ask your authorized reviewer to publish them.</p> : null}
      <form key={workspace.participants.map(p => p.id).join(",")} onSubmit={event => {
        event.preventDefault();
        const data = new FormData(event.currentTarget);
        void perform({ action: "addParticipant", encounterId, commandId: crypto.randomUUID(),
          kind: data.get("kind") as "patient" | "practitioner" | "caregiver" | "other",
          displayName: String(data.get("displayName") ?? ""), canSelfConsent: data.get("canSelfConsent") === "yes" });
      }}>
        <h3 className="text-sm font-semibold">Add a participant</h3>
        <div className="flex flex-wrap items-end gap-3">
          <label className="text-sm">Participant name<input className={inputStyle} name="displayName" required maxLength={200} /></label>
          <label className="text-sm">Participant role<select className={inputStyle} name="kind"><option value="patient">Patient</option><option value="practitioner">Practitioner</option><option value="caregiver">Caregiver</option><option value="other">Other</option></select></label>
          <label className="text-sm">Self-consent capacity<select className={inputStyle} name="canSelfConsent" required defaultValue=""><option value="" disabled>Select after review</option><option value="yes">Confirmed able to consent for themselves</option><option value="no">Representative review is required</option></select></label>
          <button className={buttonStyle} disabled={workspace.participants.length >= 20}>Add participant</button>
        </div>
        <p className="text-xs text-subtle">Record capacity only after your review. This screen does not determine legal capacity or authorize a guardian.</p>
      </form>
      {workspace.participants.length === 0 ? <p>No participants recorded.</p> : null}
      {workspace.participants.map(participant => <section key={participant.id} className="space-y-2 rounded border border-line p-3">
        <h3 className="m-0 text-sm font-semibold">{participant.displayName} — {participant.kind}</h3>
        {!participant.canSelfConsent ? <p className="text-sm">Representative evidence requires a separate reviewed-authority workflow. Consent cannot be granted here for this participant.</p> : null}
        {(["recording", "transcription", "ai_drafting"] as const).map(scope => {
          const consent = participant.consents.find(c => c.scope === scope);
          const release = workspace.consentReleases.find(r => r.scope === scope);
          return <div key={scope} className="space-y-2 text-sm">
            <p>{SCOPE_LABEL[scope]}: {consent?.effective ? "Effective consent recorded" : consent ? `Not effective (${consent.status})` : "Not granted"}</p>
            {release && participant.canSelfConsent && !consent?.effective ? <button className={buttonStyle}
              onClick={() => void perform({ action: "readConsentRelease", encounterId, releaseId: release.id }, participant.id)}>Review {SCOPE_LABEL[scope].toLowerCase()} consent for {participant.displayName}</button> : null}
            {consent?.status === "granted" ? <form onSubmit={event => {
              event.preventDefault(); const data = new FormData(event.currentTarget);
              void perform({ action: "withdrawConsent", consentId: consent.id, reason: String(data.get("reason") ?? "") });
            }} className="flex flex-wrap items-end gap-2">
              <label>Withdrawal reason<input name="reason" required maxLength={1000} className={inputStyle} /></label>
              <button className={buttonStyle}>Withdraw {SCOPE_LABEL[scope].toLowerCase()} consent for {participant.displayName}</button>
            </form> : null}
          </div>;
        })}
      </section>)}
    </fieldset> : null}
    {target ? <form key={target.participantId + target.release.id} className="space-y-3 rounded border border-line p-3"
      onSubmit={event => {
        event.preventDefault(); const data = new FormData(event.currentTarget);
        void perform({ action: "grantConsent", participantId: target.participantId, releaseId: target.release.id,
          commandId: crypto.randomUUID(), representativeAuthorityId: null,
          method: data.get("method") as "verbal_attested" | "written", acknowledgment: String(data.get("acknowledgment") ?? "") });
      }}>
      <fieldset disabled={busy || !!retry} className="space-y-3">
        <legend className="font-semibold">{SCOPE_LABEL[target.release.scope]} consent document</legend>
        <p className="text-sm">For {workspace?.participants.find(p => p.id === target.participantId)?.displayName} · Version {target.release.version} · {target.release.locale} · {target.release.jurisdiction}</p>
        <pre className="max-h-80 overflow-auto whitespace-pre-wrap font-sans text-sm">{target.release.content}</pre>
        <p className="break-all text-xs text-subtle">Document SHA-256: {target.release.contentSha256}</p>
        <label className="block text-sm">Consent method<select name="method" className={inputStyle}><option value="verbal_attested">Verbal consent attested by practitioner</option><option value="written">Written consent obtained</option></select></label>
        <label className="block text-sm">Acknowledgment of this exact document<textarea className={inputStyle} name="acknowledgment" required maxLength={2000} /></label>
        <label className="block text-sm"><input type="checkbox" required /> I presented this exact document and confirmed this participant’s consent to this scope.</label>
        <button className={buttonStyle}>Record {SCOPE_LABEL[target.release.scope].toLowerCase()} consent</button>
        <button className={buttonStyle} type="button" onClick={() => setTarget(null)}>Cancel review</button>
      </fieldset>
    </form> : null}
    <AwsRecordingCapturePanel encounterId={encounterId} ownerRef={ownerRef}
      available={encounterOpen && workspace?.encounterStatus === 'in_progress' && !busy && !retry}
      existingCapture={workspace?.activeCapture ?? null} onFinished={setFinishedHere} />
    {workspace ? <AwsRecordingTranscriptionPanel available={!busy && !retry} captures={workspace.finishedCaptures} /> : null}
    {workspace && finishedHere && !workspace.finishedCaptures.some(c => c.id === finishedHere)
      ? <p className="text-sm">A recording finished on this page is not in the loaded workspace yet. Load the consent workspace again to review its transcription.</p> : null}
  </Card>;
}
