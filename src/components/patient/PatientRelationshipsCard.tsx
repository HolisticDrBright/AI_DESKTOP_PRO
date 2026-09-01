"use client";

import { useCallback, useEffect, useState, type FormEvent, type ReactNode } from "react";
import { Copy, Link2, ShieldCheck, UserPlus, X } from "lucide-react";
import { api } from "@/adapters";
import { isAdapterError } from "@/adapters/errors";
import {
  PATIENT_RELATIONSHIP_SCOPES,
  type LivePatientRelationship,
  type LivePatientRelationshipInvitationResult,
  type LivePatientRelationships,
  type LivePatientRelationshipScope,
  type LivePatientRelationshipType,
} from "@/adapters/live-types";
import { Btn } from "@/components/ui/Btn";
import { Card, CardTitle } from "@/components/ui/bits";
import { Pill } from "@/components/ui/Pill";

const INPUT = "h-9 w-full rounded-lg border border-line bg-card px-3 text-[13px] text-body outline-none focus-visible:outline-2 focus-visible:outline-action";
const LABEL = "mb-1 block text-[11px] font-bold text-subtle";
const SCOPE_LABEL: Record<LivePatientRelationshipScope, string> = {
  protocols_supplements: "Protocols, supplements & timing",
  laboratory_results: "Laboratory results",
  medical_records: "Medical records",
};
const RELATIONSHIP_LABEL: Record<LivePatientRelationshipType, string> = {
  parent: "Parent",
  adult_child: "Adult child",
  spouse_partner: "Spouse or partner",
  sibling: "Sibling",
  family_caregiver: "Family caregiver",
  other: "Other family/support person",
};

function message(error: unknown): string {
  return isAdapterError(error) ? error.safeMessage : "The relationship request could not be saved.";
}

function statusLabel(status: LivePatientRelationship["status"]): string {
  return status.replaceAll("_", " ");
}

function Modal({ title, children, onClose, busy }: {
  title: string;
  children: ReactNode;
  onClose: () => void;
  busy: boolean;
}) {
  return (
    <div className="fixed inset-0 z-[150] flex items-center justify-center bg-[rgba(24,42,61,0.32)] px-4 backdrop-blur-[3px]"
      onMouseDown={(event) => { if (event.target === event.currentTarget && !busy) onClose(); }}>
      <div role="dialog" aria-modal="true" aria-labelledby="relationship-dialog-title"
        className="max-h-[calc(100vh-32px)] w-full max-w-[620px] overflow-y-auto rounded-lg border border-line bg-card shadow-[0_18px_60px_rgba(24,42,61,0.2)]">
        <div className="flex items-start justify-between border-b border-line px-5 py-4">
          <h2 id="relationship-dialog-title" className="m-0 text-[17px] font-bold text-ink">{title}</h2>
          <button type="button" aria-label="Close relationship dialog" disabled={busy} onClick={onClose}
            className="grid h-8 w-8 cursor-pointer place-items-center rounded-lg border-0 bg-transparent text-muted hover:bg-sunken focus-visible:outline-2 focus-visible:outline-action disabled:cursor-not-allowed">
            <X size={17} aria-hidden />
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}

export function PatientRelationshipsCard({ patientId }: { patientId: string }) {
  const [data, setData] = useState<LivePatientRelationships | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [result, setResult] = useState<LivePatientRelationshipInvitationResult | null>(null);
  const [displayName, setDisplayName] = useState("");
  const [email, setEmail] = useState("");
  const [relationshipType, setRelationshipType] = useState<LivePatientRelationshipType>("family_caregiver");
  const [scopes, setScopes] = useState<LivePatientRelationshipScope[]>(["protocols_supplements"]);
  const [expiresInDays, setExpiresInDays] = useState<30 | 90 | 365>(90);
  const [attestsSynthetic, setAttestsSynthetic] = useState(false);
  const [revokeTarget, setRevokeTarget] = useState<LivePatientRelationship | null>(null);
  const [revokeReason, setRevokeReason] = useState("");

  const load = useCallback(async () => {
    try {
      setLoadError(null);
      setData(await api.patients.relationships(patientId));
    } catch (error) {
      setLoadError(message(error));
    }
  }, [patientId]);

  useEffect(() => { void load(); }, [load]);

  const closeInvite = () => {
    if (busy) return;
    setOpen(false);
    setResult(null);
    setFormError(null);
  };

  const toggleScope = (scope: LivePatientRelationshipScope) => {
    setScopes((current) => current.includes(scope)
      ? current.filter((item) => item !== scope)
      : [...current, scope]);
  };

  const invite = async (event: FormEvent) => {
    event.preventDefault();
    if (busy) return;
    if (!displayName.trim() || !/^\S+@\S+\.\S+$/.test(email.trim()) || scopes.length < 1) {
      setFormError("Enter the family member's name and email, and choose at least one access area.");
      return;
    }
    if (data?.syntheticOnly !== false && !attestsSynthetic) {
      setFormError("Confirm that the invitation uses a fictional test identity.");
      return;
    }
    setBusy(true);
    setFormError(null);
    try {
      const created = await api.patients.inviteRelationship({
        patientId, displayName: displayName.trim(), email: email.trim().toLowerCase(),
        relationshipType, requestedScopes: scopes, expiresInDays, attestsSynthetic,
      });
      setResult(created);
      await load();
    } catch (error) {
      setFormError(message(error));
    } finally {
      setBusy(false);
    }
  };

  const revoke = async (event: FormEvent) => {
    event.preventDefault();
    if (!revokeTarget || busy) return;
    if (revokeReason.trim().length < 3) {
      setFormError("Enter a brief reason for the audit record.");
      return;
    }
    setBusy(true);
    setFormError(null);
    try {
      await api.patients.revokeRelationship({
        relationshipId: revokeTarget.id,
        expectedVersion: revokeTarget.version,
        reason: revokeReason.trim(),
      });
      setRevokeTarget(null);
      setRevokeReason("");
      await load();
    } catch (error) {
      setFormError(message(error));
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <Card className="px-4 py-[13px]" data-testid="patient-relationships-card">
        <div className="flex items-center justify-between gap-3">
          <CardTitle><Link2 size={13} strokeWidth={2} className="text-brand" aria-hidden />Family access</CardTitle>
          <Btn size="sm" onClick={() => { setOpen(true); setFormError(null); }} data-testid="add-relationship-open">
            <UserPlus size={13} aria-hidden /> Add relationship
          </Btn>
        </div>
        <p className="mt-1 mb-2 text-[11px] leading-[1.5] text-faint">
          Family access is view-only and scope-specific. The patient must approve it, the recipient must verify their own identity, and either party can revoke it.
        </p>
        {loadError ? (
          <p role="alert" className="m-0 text-[12px] text-critical">{loadError} <button type="button" onClick={() => void load()} className="font-semibold underline">Retry</button></p>
        ) : !data ? (
          <p className="m-0 text-[12px] text-faint">Loading relationships…</p>
        ) : data.relationships.length === 0 ? (
          <p className="m-0 text-[12px] text-faint">No family access relationships recorded.</p>
        ) : (
          <ul className="m-0 flex list-none flex-col gap-2 p-0">
            {data.relationships.map((relationship) => (
              <li key={relationship.id} className="rounded-lg border border-hairline-2 bg-sunken px-3 py-2">
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <p className="m-0 truncate text-[12px] font-semibold text-body">{relationship.displayName} · {RELATIONSHIP_LABEL[relationship.relationshipType]}</p>
                    <p className="m-0 mt-0.5 text-[10.5px] text-faint">{relationship.maskedEmail}</p>
                  </div>
                  <Pill tone={relationship.status === "active" ? "positive" : relationship.status === "revoked" || relationship.status === "expired" ? "slate" : "warning"}>
                    {statusLabel(relationship.status)}
                  </Pill>
                </div>
                <p className="m-0 mt-1 text-[10.5px] leading-[1.45] text-subtle">
                  {(relationship.grantedScopes.length ? relationship.grantedScopes : relationship.requestedScopes).map((scope) => SCOPE_LABEL[scope]).join(" · ")}
                </p>
                {relationship.status !== "revoked" && relationship.status !== "expired" && (
                  <button type="button" onClick={() => { setRevokeTarget(relationship); setFormError(null); }}
                    className="mt-1.5 border-0 bg-transparent p-0 text-[10.5px] font-semibold text-critical hover:underline focus-visible:outline-2 focus-visible:outline-action">
                    Revoke access
                  </button>
                )}
              </li>
            ))}
          </ul>
        )}
      </Card>

      {open && (
        <Modal title={result ? "Relationship invitation created" : "Add family relationship"} onClose={closeInvite} busy={busy}>
          {result ? (
            <div className="px-5 py-4">
              <div className="rounded-lg border border-positive/30 bg-positive-tint px-3 py-3">
                <p className="m-0 flex items-center gap-2 text-[13px] font-semibold text-body"><ShieldCheck size={16} aria-hidden />Waiting for patient approval</p>
                <p className="mt-1 mb-0 text-[12px] leading-5 text-subtle">This code is shown once. Share it only through an approved secure channel. It does not grant access by itself.</p>
                <div className="mt-3 flex items-center gap-2">
                  <code className="rounded-md border border-line bg-card px-3 py-2 text-[15px] font-bold tracking-[0.16em] text-ink">{result.invitationCode}</code>
                  <Btn type="button" size="sm" onClick={() => void navigator.clipboard.writeText(result.invitationCode)}><Copy size={13} aria-hidden />Copy</Btn>
                </div>
              </div>
              <p className="mt-3 mb-0 text-[11px] leading-[1.5] text-faint">The patient must approve the requested areas and the recipient must claim the invitation using the matching verified email. Until both occur, no record or protocol access is available.</p>
              <div className="mt-4 flex justify-end"><Btn type="button" variant="primary" onClick={closeInvite}>Done</Btn></div>
            </div>
          ) : (
            <form onSubmit={(event) => void invite(event)}>
              <div className="grid gap-4 px-5 py-4 sm:grid-cols-2">
                {data?.syntheticOnly !== false && (
                  <div className="sm:col-span-2 rounded-lg border border-warning/35 bg-warning-tint px-3 py-2.5 text-[12px] leading-5 text-warning-deep"><strong>Synthetic staging only.</strong> Use a fictional family member and test email. Do not enter a real person&apos;s identity.</div>
                )}
                <label><span className={LABEL}>Family member name *</span><input className={INPUT} maxLength={120} autoComplete="off" value={displayName} onChange={(event) => setDisplayName(event.target.value)} /></label>
                <label><span className={LABEL}>Email *</span><input type="email" className={INPUT} maxLength={320} autoComplete="off" value={email} onChange={(event) => setEmail(event.target.value)} /></label>
                <label><span className={LABEL}>Relationship *</span><select className={INPUT} value={relationshipType} onChange={(event) => setRelationshipType(event.target.value as LivePatientRelationshipType)}>{Object.entries(RELATIONSHIP_LABEL).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
                <label><span className={LABEL}>Access expires *</span><select className={INPUT} value={expiresInDays} onChange={(event) => setExpiresInDays(Number(event.target.value) as 30 | 90 | 365)}><option value={30}>30 days after approval</option><option value={90}>90 days after approval</option><option value={365}>1 year after approval</option></select></label>
                <fieldset className="sm:col-span-2 rounded-lg border border-line px-3 py-2.5"><legend className="px-1 text-[11px] font-bold text-subtle">Requested view-only access *</legend>{PATIENT_RELATIONSHIP_SCOPES.map((scope) => <label key={scope} className="mt-1 flex cursor-pointer items-start gap-2 text-[12px] text-body"><input type="checkbox" className="mt-0.5 h-4 w-4 accent-action" checked={scopes.includes(scope)} onChange={() => toggleScope(scope)} /><span>{SCOPE_LABEL[scope]}</span></label>)}</fieldset>
                <div className="sm:col-span-2 rounded-lg border border-line bg-sunken px-3 py-2.5 text-[11px] leading-5 text-subtle">This invitation cannot permit editing, messaging as the patient, billing access, exports, wearable data, reproductive-health data, or account recovery. A legal representative&apos;s authority requires a separate verification workflow.</div>
                {data?.syntheticOnly !== false && <label className="sm:col-span-2 flex cursor-pointer items-start gap-2.5"><input type="checkbox" className="mt-0.5 h-4 w-4 accent-action" checked={attestsSynthetic} onChange={(event) => setAttestsSynthetic(event.target.checked)} /><span className="text-[12px] text-body">I confirm this uses fictional test identity information only.</span></label>}
                {formError && <p role="alert" className="sm:col-span-2 m-0 text-[12px] font-semibold text-critical">{formError}</p>}
              </div>
              <div className="flex justify-end gap-2 border-t border-line px-5 py-3"><Btn type="button" disabled={busy} onClick={closeInvite}>Cancel</Btn><Btn type="submit" variant="primary" disabled={busy}>{busy ? "Creating…" : "Create approval request"}</Btn></div>
            </form>
          )}
        </Modal>
      )}

      {revokeTarget && (
        <Modal title="Revoke family access" onClose={() => { if (!busy) { setRevokeTarget(null); setRevokeReason(""); setFormError(null); } }} busy={busy}>
          <form onSubmit={(event) => void revoke(event)}>
            <div className="px-5 py-4"><p className="mt-0 text-[12px] leading-5 text-body">Revocation takes effect immediately for <strong>{revokeTarget.displayName}</strong>. Previously generated audit records are retained.</p><label><span className={LABEL}>Reason for audit record *</span><textarea className="min-h-24 w-full rounded-lg border border-line bg-card px-3 py-2 text-[13px] text-body outline-none focus-visible:outline-2 focus-visible:outline-action" maxLength={500} value={revokeReason} onChange={(event) => setRevokeReason(event.target.value)} /></label>{formError && <p role="alert" className="mb-0 text-[12px] font-semibold text-critical">{formError}</p>}</div>
            <div className="flex justify-end gap-2 border-t border-line px-5 py-3"><Btn type="button" disabled={busy} onClick={() => setRevokeTarget(null)}>Cancel</Btn><Btn type="submit" variant="danger" disabled={busy}>{busy ? "Revoking…" : "Revoke access"}</Btn></div>
          </form>
        </Modal>
      )}
    </>
  );
}
