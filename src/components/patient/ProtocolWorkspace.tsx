"use client";

/**
 * Patient protocol workspace — CLINICAL, real data only.
 *
 * Everything on this screen is a row in the Desktop-owned protocol tables,
 * written through RPCs that run as the signed-in practitioner. The database —
 * not this component — enforces membership, clinical role, patient access,
 * tenant agreement, and the immutability of approved and active versions.
 *
 * The rules this screen exists to honor:
 *
 *   * A patient with no protocol shows an honest empty state. Nothing is
 *     synthesized to fill the screen.
 *   * Approved and active versions are IMMUTABLE. Correcting one creates a new
 *     draft version; prior clinical instructions are never overwritten.
 *   * A product entry carries its exact catalog identity — product id, label
 *     version, manufacturer, dosage, timing, route — and its verification
 *     status as the database derived it.
 *   * An affiliate link is commercial metadata. It is labelled as such and
 *     establishes no eligibility, evidence, dosage, or safety.
 *   * Interaction state is never presented as "no interactions". Until a
 *     deterministic check is possible AND a practitioner signs off, the item
 *     reads "Interaction review not completed".
 *   * Nothing here sends patient instructions, places an order, charges,
 *     modifies medications, activates a protocol, or writes into a note as a
 *     side effect. Approval and activation are separate confirmed actions.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  AlertTriangle,
  CheckCircle2,
  ClipboardList,
  History,
  Info,
  Loader2,
  Package,
  Plus,
  ShieldAlert,
  Trash2,
} from "lucide-react";
import { api } from "@/adapters";
import { isAdapterError } from "@/adapters/errors";
import type {
  LiveCatalogProduct,
  LiveInteractionCheck,
  LivePatientProtocol,
  LiveProtocolDraftPayload,
  LiveProtocolItem,
  LiveProtocolPhase,
  LiveProtocolTemplate,
  LiveProtocolVersion,
} from "@/adapters/live-types";
import { ClinicalError, ClinicalLoading } from "@/components/ui/ClinicalStates";
import { Card, CardTitle } from "@/components/ui/bits";
import { Btn } from "@/components/ui/Btn";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { useFeedback } from "@/lib/feedback";

const ITEM_KINDS = [
  { kind: "product", label: "Supplement / product" },
  { kind: "diet", label: "Diet" },
  { kind: "lifestyle", label: "Lifestyle" },
  { kind: "monitoring", label: "Monitoring" },
  { kind: "followup", label: "Follow-up" },
] as const;

type ItemKind = (typeof ITEM_KINDS)[number]["kind"];

const KIND_LABEL: Record<string, string> = Object.fromEntries(
  ITEM_KINDS.map((k) => [k.kind, k.label]),
);

const VERIFICATION_LABEL: Record<string, string> = {
  unverified: "Not backed by catalog data",
  label_verified: "Label on file, ingredients not structured",
  structured_verified: "Structured ingredient data on file",
};

const INPUT =
  "h-8 w-full rounded-lg border border-line bg-card px-2 text-[12.5px] text-body focus-visible:outline-2 focus-visible:outline-action";
const AREA =
  "min-h-[64px] w-full rounded-lg border border-line bg-card px-2 py-[6px] text-[12.5px] leading-[1.5] text-body focus-visible:outline-2 focus-visible:outline-action";
const LABEL = "mb-1 block text-[10px] font-bold tracking-[0.04em] text-faint uppercase";

/** Editable local shape for a draft. Mirrors LiveProtocolDraftPayload. */
type DraftPhase = {
  name: string;
  timing: "absolute" | "relative";
  startsOn: string;
  endsOn: string;
  relativeStartDay: string;
  relativeDurationDays: string;
  notes: string;
};
type DraftItem = {
  kind: ItemKind;
  label: string;
  phaseIndex: number | null;
  instructions: string;
  catalogProductId: string | null;
  catalogProductVersionId: string | null;
  manufacturer: string | null;
  labelVersion: string | null;
  dosageText: string;
  timingText: string;
  route: string;
  affiliateUrl: string;
  /** Present only for items already persisted — needed for interaction review. */
  itemId: string | null;
};
type DraftForm = {
  title: string;
  summary: string;
  dietInstructions: string;
  lifestyleInstructions: string;
  monitoringPlan: string;
  followupPlan: string;
  phases: DraftPhase[];
  items: DraftItem[];
};

type SaveState =
  | { kind: "idle" }
  | { kind: "saving" }
  | { kind: "saved"; at: string }
  | { kind: "conflict" }
  | { kind: "failed"; message: string };

function emptyPhase(): DraftPhase {
  return {
    name: "",
    timing: "relative",
    startsOn: "",
    endsOn: "",
    relativeStartDay: "0",
    relativeDurationDays: "28",
    notes: "",
  };
}

function phaseToForm(p: LiveProtocolPhase): DraftPhase {
  const absolute = p.startsOn != null || p.endsOn != null;
  return {
    name: p.name,
    timing: absolute ? "absolute" : "relative",
    startsOn: p.startsOn ?? "",
    endsOn: p.endsOn ?? "",
    relativeStartDay: p.relativeStartDay == null ? "" : String(p.relativeStartDay),
    relativeDurationDays: p.relativeDurationDays == null ? "" : String(p.relativeDurationDays),
    notes: p.notes ?? "",
  };
}

function itemToForm(it: LiveProtocolItem, phaseIds: string[]): DraftItem {
  const idx = it.phaseId ? phaseIds.indexOf(it.phaseId) : -1;
  return {
    kind: (ITEM_KINDS.find((k) => k.kind === it.kind)?.kind ?? "diet") as ItemKind,
    label: it.label,
    phaseIndex: idx >= 0 ? idx : null,
    instructions: it.instructions ?? "",
    catalogProductId: it.catalogProductId,
    catalogProductVersionId: it.catalogProductVersionId,
    manufacturer: it.manufacturer,
    labelVersion: it.labelVersion,
    dosageText: it.dosageText ?? "",
    timingText: it.timingText ?? "",
    route: it.route ?? "",
    affiliateUrl: it.affiliateUrl ?? "",
    itemId: it.id,
  };
}

function versionToForm(v: LiveProtocolVersion): DraftForm {
  const phaseIds = v.phases.map((p) => p.id);
  return {
    title: v.title,
    summary: v.summary ?? "",
    dietInstructions: v.dietInstructions ?? "",
    lifestyleInstructions: v.lifestyleInstructions ?? "",
    monitoringPlan: v.monitoringPlan ?? "",
    followupPlan: v.followupPlan ?? "",
    phases: v.phases.map(phaseToForm),
    items: v.items.map((it) => itemToForm(it, phaseIds)),
  };
}

function formToPayload(f: DraftForm): LiveProtocolDraftPayload {
  return {
    title: f.title,
    summary: f.summary || null,
    dietInstructions: f.dietInstructions || null,
    lifestyleInstructions: f.lifestyleInstructions || null,
    monitoringPlan: f.monitoringPlan || null,
    followupPlan: f.followupPlan || null,
    phases: f.phases.map((p) => ({
      name: p.name,
      // Absolute dates XOR relative offsets — the database enforces this too.
      startsOn: p.timing === "absolute" ? p.startsOn || null : null,
      endsOn: p.timing === "absolute" ? p.endsOn || null : null,
      relativeStartDay:
        p.timing === "relative" && p.relativeStartDay !== "" ? Number(p.relativeStartDay) : null,
      relativeDurationDays:
        p.timing === "relative" && p.relativeDurationDays !== ""
          ? Number(p.relativeDurationDays)
          : null,
      notes: p.notes || null,
    })),
    items: f.items.map((it) => ({
      kind: it.kind,
      label: it.label,
      phaseIndex: it.phaseIndex,
      instructions: it.instructions || null,
      catalogProductId: it.catalogProductId,
      catalogProductVersionId: it.catalogProductVersionId,
      // Sent for free-text products only; when a catalog version is pinned the
      // database overwrites these with the catalog's own values.
      manufacturer: it.manufacturer,
      labelVersion: it.labelVersion,
      dosageText: it.dosageText || null,
      timingText: it.timingText || null,
      route: it.route || null,
      affiliateUrl: it.affiliateUrl || null,
    })),
  };
}

function fmtDateTime(iso: string | null | undefined): string {
  if (!iso) return "—";
  const d = new Date(iso);
  return Number.isNaN(d.getTime())
    ? "—"
    : d.toLocaleString("en-US", {
        month: "short",
        day: "numeric",
        hour: "numeric",
        minute: "2-digit",
      });
}

function errText(e: unknown, fallback: string): string {
  return isAdapterError(e) ? e.safeMessage : fallback;
}

// ===========================================================================

export function ProtocolWorkspace({ patientId }: { patientId: string }) {
  const { announce } = useFeedback();
  const [state, setState] = useState<"loading" | "ready" | "error">("loading");
  const [data, setData] = useState<LivePatientProtocol | null>(null);
  const [error, setError] = useState<{ message: string; signedOut: boolean } | null>(null);
  const [reloadKey, setReloadKey] = useState(0);
  const [templates, setTemplates] = useState<LiveProtocolTemplate[] | null>(null);
  const [templatesError, setTemplatesError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const reload = useCallback(() => setReloadKey((k) => k + 1), []);

  useEffect(() => {
    let live = true;
    setState("loading");
    api.protocols
      .getForPatient(patientId)
      .then((d) => {
        if (!live) return;
        setData(d);
        setState("ready");
      })
      .catch((e: unknown) => {
        if (!live) return;
        setError({
          message: errText(e, "The protocol could not be loaded."),
          signedOut: isAdapterError(e) && e.code === "unauthenticated",
        });
        setState("error");
      });
    return () => {
      live = false;
    };
  }, [patientId, reloadKey]);

  useEffect(() => {
    let live = true;
    api.protocols
      .listTemplates(false)
      .then((t) => live && setTemplates(t))
      .catch((e: unknown) => {
        if (!live) return;
        // A template list failure must not be read as "no templates exist".
        setTemplates(null);
        setTemplatesError(errText(e, "Organization templates could not be loaded."));
      });
    return () => {
      live = false;
    };
  }, [reloadKey]);

  if (state === "loading") return <ClinicalLoading label="Loading protocol…" />;
  if (state === "error" || !data) {
    return (
      <ClinicalError
        message={error?.message ?? "The protocol could not be loaded."}
        onRetry={reload}
        actionHref={error?.signedOut ? "/login" : undefined}
        actionLabel={error?.signedOut ? "Sign in" : undefined}
      />
    );
  }

  const createDraft = (title: string, fromTemplateId: string | null) => {
    if (busy) return;
    setBusy(true);
    api.protocols
      .createDraft({ patientId, title, fromTemplateId })
      .then((r) => {
        announce(r.message ?? "Draft created.");
        reload();
      })
      .catch((e: unknown) => announce(errText(e, "The draft could not be created.")))
      .finally(() => setBusy(false));
  };

  return (
    <div data-testid="protocol-workspace" className="flex flex-col gap-3 pt-4">
      <LifecycleBar data={data} busy={busy} setBusy={setBusy} onChanged={reload} />

      {data.draft ? (
        <DraftEditor
          key={data.draft.id}
          version={data.draft}
          canAuthor={data.canAuthor}
          onChanged={reload}
        />
      ) : (
        <NoDraft
          data={data}
          templates={templates}
          templatesError={templatesError}
          busy={busy}
          onCreate={createDraft}
        />
      )}

      {data.active && <FrozenVersion version={data.active} kindLabel="Active version" />}
      {data.approved && data.approved.id !== data.active?.id && (
        <FrozenVersion version={data.approved} kindLabel="Approved version (not active)" />
      )}

      <VersionHistory data={data} busy={busy} setBusy={setBusy} onChanged={reload} />
      <TemplateTools data={data} busy={busy} setBusy={setBusy} onChanged={reload} />
    </div>
  );
}

// --------------------------------------------------------------- empty state

function NoDraft({
  data,
  templates,
  templatesError,
  busy,
  onCreate,
}: {
  data: LivePatientProtocol;
  templates: LiveProtocolTemplate[] | null;
  templatesError: string | null;
  busy: boolean;
  onCreate: (title: string, fromTemplateId: string | null) => void;
}) {
  const [title, setTitle] = useState("");
  const [templateId, setTemplateId] = useState("");
  const hasAny = data.exists;

  if (!data.canAuthor) {
    return (
      <Card className="p-4" >
        <p data-testid="protocol-readonly" className="m-0 text-[12.5px] leading-[1.55] text-subtle">
          {hasAny
            ? "You can view this protocol but not author it. Creating, editing, approving, and activating clinical instructions require a practitioner role with write access to this patient."
            : "This patient has no protocol on file, and your role cannot create one. Authoring clinical instructions requires a practitioner role with write access to this patient."}
        </p>
      </Card>
    );
  }

  return (
    <Card className="p-4">
      <CardTitle>{hasAny ? "Start a new draft version" : "No protocol on file"}</CardTitle>
      <p
        data-testid="protocol-empty"
        className="m-0 mt-1 mb-3 text-[12.5px] leading-[1.55] text-subtle"
      >
        {hasAny
          ? "There is no draft in progress. Start a blank draft, or begin from an approved organization template."
          : "This patient has no protocol on file. Nothing is shown because nothing has been written — start a blank draft, or begin from an approved organization template."}
      </p>
      <div className="grid gap-3 sm:grid-cols-2">
        <div>
          <label className={LABEL} htmlFor="protocol-new-title">
            Protocol title
          </label>
          <input
            id="protocol-new-title"
            data-testid="protocol-new-title"
            className={INPUT}
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder="e.g. Metabolic reset"
          />
        </div>
        <div>
          <label className={LABEL} htmlFor="protocol-template-select">
            Start from an approved template (optional)
          </label>
          <select
            id="protocol-template-select"
            data-testid="protocol-template-select"
            className={INPUT}
            value={templateId}
            onChange={(e) => setTemplateId(e.target.value)}
          >
            <option value="">Blank draft</option>
            {(templates ?? [])
              .filter((t) => t.status === "approved" && t.approvedVersionId)
              .map((t) => (
                <option key={t.id} value={t.id}>
                  {t.name} (v{t.approvedVersion})
                </option>
              ))}
          </select>
          {templatesError ? (
            <p role="alert" className="m-0 mt-1 text-[11px] font-medium text-warning-deep">
              {templatesError} This list is unavailable — it is not a statement that the
              organization has no templates.
            </p>
          ) : (
            templates != null &&
            templates.filter((t) => t.status === "approved").length === 0 && (
              <p className="m-0 mt-1 text-[11px] text-faint">
                No approved templates exist in this organization yet.
              </p>
            )
          )}
        </div>
      </div>
      <div className="mt-3 flex flex-wrap gap-2">
        <Btn
          size="sm"
          variant="primary"
          disabled={busy || !title.trim()}
          data-testid="protocol-create-blank"
          onClick={() => onCreate(title.trim(), templateId || null)}
        >
          {busy ? "Creating…" : templateId ? "Create draft from template" : "Create blank draft"}
        </Btn>
      </div>
    </Card>
  );
}

// ------------------------------------------------------------- lifecycle bar

function LifecycleBar({
  data,
  busy,
  setBusy,
  onChanged,
}: {
  data: LivePatientProtocol;
  busy: boolean;
  setBusy: (b: boolean) => void;
  onChanged: () => void;
}) {
  const { announce } = useFeedback();
  const [confirm, setConfirm] = useState<
    null | { status: "paused" | "completed" | "discontinued"; label: string }
  >(null);
  const p = data.protocol;

  const run = (status: "active" | "paused" | "completed" | "discontinued") => {
    if (!p || busy) return;
    setBusy(true);
    setConfirm(null);
    api.protocols
      .setLifecycle(p.id, status)
      .then((r) => {
        announce(r.message ?? "Protocol updated.");
        onChanged();
      })
      .catch((e: unknown) => announce(errText(e, "The protocol status could not be changed.")))
      .finally(() => setBusy(false));
  };

  if (!p) return null;

  return (
    <Card className="flex flex-wrap items-center justify-between gap-3 px-4 py-3">
      <div className="min-w-0">
        <div className="flex items-center gap-2">
          <ClipboardList size={15} strokeWidth={2} className="shrink-0 text-faint" aria-hidden />
          <h2 data-testid="protocol-title" className="m-0 truncate text-[14px] font-bold text-ink">
            {p.title}
          </h2>
          <span
            data-testid="protocol-status"
            className="shrink-0 rounded-full bg-slate-tint px-[9px] py-[2px] text-[10.5px] font-bold text-slate-badge"
          >
            {p.status}
          </span>
        </div>
        <p className="m-0 mt-[3px] text-[11.5px] text-faint">
          Updated {fmtDateTime(p.updatedAt)}
          {data.active ? ` · active version ${data.active.version}` : " · no active version"}
        </p>
      </div>
      {data.canAuthor && (
        <div className="flex shrink-0 flex-wrap gap-2">
          {p.status === "active" && (
            <Btn
              size="sm"
              variant="ghost"
              disabled={busy}
              data-testid="protocol-pause"
              onClick={() => setConfirm({ status: "paused", label: "Pause this protocol?" })}
            >
              Pause
            </Btn>
          )}
          {p.status === "paused" && (
            <Btn
              size="sm"
              variant="ghost"
              disabled={busy}
              data-testid="protocol-resume"
              onClick={() => run("active")}
            >
              Resume
            </Btn>
          )}
          {(p.status === "active" || p.status === "paused") && (
            <>
              <Btn
                size="sm"
                variant="ghost"
                disabled={busy}
                data-testid="protocol-complete"
                onClick={() =>
                  setConfirm({ status: "completed", label: "Mark this protocol complete?" })
                }
              >
                Complete
              </Btn>
              <Btn
                size="sm"
                variant="ghost"
                disabled={busy}
                data-testid="protocol-discontinue"
                onClick={() =>
                  setConfirm({ status: "discontinued", label: "Discontinue this protocol?" })
                }
              >
                Discontinue
              </Btn>
            </>
          )}
        </div>
      )}
      <ConfirmDialog
        open={confirm != null}
        title={confirm?.label ?? ""}
        body="This changes the protocol's status on the patient record and is audited. It does not message the patient, cancel an order, or modify medications."
        confirmLabel="Confirm"
        destructive={confirm?.status === "discontinued"}
        onConfirm={() => confirm && run(confirm.status)}
        onCancel={() => setConfirm(null)}
      />
    </Card>
  );
}

// ------------------------------------------------------------- draft editor

function DraftEditor({
  version,
  canAuthor,
  onChanged,
}: {
  version: LiveProtocolVersion;
  canAuthor: boolean;
  onChanged: () => void;
}) {
  const { announce } = useFeedback();
  const [form, setForm] = useState<DraftForm>(() => versionToForm(version));
  const [token, setToken] = useState<string>(version.updatedAt);
  const [save, setSave] = useState<SaveState>({ kind: "idle" });
  const [busy, setBusy] = useState(false);
  const [approving, setApproving] = useState(false);
  const [reviewNote, setReviewNote] = useState("");
  const dirty = useRef(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const patch = (next: Partial<DraftForm>) => {
    dirty.current = true;
    setForm((f) => ({ ...f, ...next }));
  };

  const persist = useCallback(
    (f: DraftForm) => {
      setSave({ kind: "saving" });
      return api.protocols
        .saveDraft({ versionId: version.id, payload: formToPayload(f), expectedUpdatedAt: token })
        .then((r) => {
          dirty.current = false;
          if (r.updatedAt) setToken(r.updatedAt);
          setSave({ kind: "saved", at: r.updatedAt ?? new Date().toISOString() });
          return true;
        })
        .catch((e: unknown) => {
          // A conflict is NOT retried silently: another editor's work would be
          // lost. The practitioner is told to reload.
          if (isAdapterError(e) && e.code === "conflict") setSave({ kind: "conflict" });
          else setSave({ kind: "failed", message: errText(e, "The draft could not be saved.") });
          return false;
        });
    },
    [token, version.id],
  );

  // Autosave: debounce edits, never fire on the initial render, and stop
  // entirely once a conflict is reported.
  useEffect(() => {
    if (!dirty.current || !canAuthor) return;
    if (save.kind === "conflict") return;
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => void persist(form), 1200);
    return () => {
      if (timer.current) clearTimeout(timer.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [form, canAuthor]);

  const approve = () => {
    if (busy) return;
    setBusy(true);
    // Save first: approving must freeze what is on screen, not a stale row.
    void persist(form).then((ok) => {
      if (!ok) {
        setBusy(false);
        announce("Nothing was approved — the draft could not be saved first.");
        return;
      }
      api.protocols
        .approve(version.id, reviewNote.trim() || null)
        .then((r) => {
          announce(r.message ?? "Version approved.");
          setApproving(false);
          onChanged();
        })
        .catch((e: unknown) => announce(errText(e, "The version could not be approved.")))
        .finally(() => setBusy(false));
    });
  };

  return (
    <Card className="p-4" >
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <CardTitle>Draft version {version.version}</CardTitle>
          <p className="m-0 mt-1 text-[11.5px] text-faint">
            Drafts are the only editable version. Approved and active versions are immutable.
          </p>
        </div>
        <SaveBadge state={save} />
      </div>

      {!canAuthor && (
        <p className="m-0 mt-3 text-[12.5px] text-subtle">
          This draft is read-only for your role.
        </p>
      )}

      <fieldset disabled={!canAuthor} className="m-0 border-0 p-0">
        <div className="mt-3 grid gap-3 sm:grid-cols-2">
          <div className="sm:col-span-2">
            <label className={LABEL} htmlFor="pd-title">
              Title
            </label>
            <input
              id="pd-title"
              data-testid="pd-title"
              className={INPUT}
              value={form.title}
              onChange={(e) => patch({ title: e.target.value })}
            />
          </div>
          <div className="sm:col-span-2">
            <label className={LABEL} htmlFor="pd-summary">
              Summary
            </label>
            <textarea
              id="pd-summary"
              data-testid="pd-summary"
              className={AREA}
              value={form.summary}
              onChange={(e) => patch({ summary: e.target.value })}
            />
          </div>
          <div>
            <label className={LABEL} htmlFor="pd-diet">
              Diet instructions
            </label>
            <textarea
              id="pd-diet"
              data-testid="pd-diet"
              className={AREA}
              value={form.dietInstructions}
              onChange={(e) => patch({ dietInstructions: e.target.value })}
            />
          </div>
          <div>
            <label className={LABEL} htmlFor="pd-lifestyle">
              Lifestyle instructions
            </label>
            <textarea
              id="pd-lifestyle"
              data-testid="pd-lifestyle"
              className={AREA}
              value={form.lifestyleInstructions}
              onChange={(e) => patch({ lifestyleInstructions: e.target.value })}
            />
          </div>
          <div>
            <label className={LABEL} htmlFor="pd-monitoring">
              Monitoring plan
            </label>
            <textarea
              id="pd-monitoring"
              data-testid="pd-monitoring"
              className={AREA}
              value={form.monitoringPlan}
              onChange={(e) => patch({ monitoringPlan: e.target.value })}
            />
          </div>
          <div>
            <label className={LABEL} htmlFor="pd-followup">
              Follow-up plan
            </label>
            <textarea
              id="pd-followup"
              data-testid="pd-followup"
              className={AREA}
              value={form.followupPlan}
              onChange={(e) => patch({ followupPlan: e.target.value })}
            />
          </div>
        </div>

        <PhaseEditor
          phases={form.phases}
          onChange={(phases) => patch({ phases })}
          items={form.items}
          onItemsChange={(items) => patch({ items })}
        />

        <ItemEditor
          items={form.items}
          phases={form.phases}
          onChange={(items) => patch({ items })}
          versionId={version.id}
        />
      </fieldset>

      {canAuthor && (
        <div className="mt-4 border-t border-hairline pt-3">
          {!approving ? (
            <div className="flex flex-wrap gap-2">
              <Btn
                size="sm"
                variant="primary"
                disabled={busy || save.kind === "conflict"}
                data-testid="pd-open-approve"
                onClick={() => setApproving(true)}
              >
                Review &amp; approve this version
              </Btn>
              <Btn
                size="sm"
                variant="ghost"
                disabled={busy}
                data-testid="pd-save-now"
                onClick={() => void persist(form)}
              >
                Save now
              </Btn>
            </div>
          ) : (
            <div className="rounded-lg border border-line bg-[rgba(247,250,252,0.7)] p-3">
              <p className="m-0 mb-2 text-[12px] leading-[1.55] text-body">
                Approving <strong>freezes this version</strong>. It becomes immutable — a later
                correction creates a new draft version rather than overwriting these instructions.
                Approval does <strong>not</strong> activate the protocol, send instructions to the
                patient, place any order, or charge anything.
              </p>
              <label className={LABEL} htmlFor="pd-review-note">
                Review note (optional)
              </label>
              <textarea
                id="pd-review-note"
                data-testid="pd-review-note"
                className={AREA}
                value={reviewNote}
                onChange={(e) => setReviewNote(e.target.value)}
              />
              <div className="mt-2 flex justify-end gap-2">
                <Btn size="sm" variant="ghost" onClick={() => setApproving(false)}>
                  Cancel
                </Btn>
                <Btn
                  size="sm"
                  variant="primary"
                  disabled={busy}
                  data-testid="pd-approve"
                  onClick={approve}
                >
                  {busy ? "Approving…" : "Approve version"}
                </Btn>
              </div>
            </div>
          )}
        </div>
      )}
    </Card>
  );
}

function SaveBadge({ state }: { state: SaveState }) {
  if (state.kind === "idle") {
    return (
      <span data-testid="pd-save-state" data-state="idle" className="text-[11.5px] text-faint">
        No unsaved changes
      </span>
    );
  }
  if (state.kind === "saving") {
    return (
      <span
        data-testid="pd-save-state"
        data-state="saving"
        role="status"
        className="flex items-center gap-1 text-[11.5px] font-semibold text-faint"
      >
        <Loader2 size={12} className="animate-spin" aria-hidden />
        Saving…
      </span>
    );
  }
  if (state.kind === "saved") {
    return (
      <span
        data-testid="pd-save-state"
        data-state="saved"
        role="status"
        className="flex items-center gap-1 text-[11.5px] font-semibold text-positive"
      >
        <CheckCircle2 size={12} aria-hidden />
        Saved {fmtDateTime(state.at)}
      </span>
    );
  }
  if (state.kind === "conflict") {
    return (
      <span
        data-testid="pd-save-state"
        data-state="conflict"
        role="alert"
        className="flex max-w-[280px] items-start gap-1 text-[11.5px] font-semibold text-warning-deep"
      >
        <AlertTriangle size={12} className="mt-[2px] shrink-0" aria-hidden />
        This draft changed in another window. Nothing here was saved — reload the page to see the
        current draft before editing again.
      </span>
    );
  }
  return (
    <span
      data-testid="pd-save-state"
      data-state="failed"
      role="alert"
      className="flex max-w-[280px] items-start gap-1 text-[11.5px] font-semibold text-critical"
    >
      <AlertTriangle size={12} className="mt-[2px] shrink-0" aria-hidden />
      Not saved — {state.message}
    </span>
  );
}

// -------------------------------------------------------------- phase editor

function PhaseEditor({
  phases,
  onChange,
  items,
  onItemsChange,
}: {
  phases: DraftPhase[];
  onChange: (p: DraftPhase[]) => void;
  items: DraftItem[];
  onItemsChange: (i: DraftItem[]) => void;
}) {
  const setAt = (i: number, next: Partial<DraftPhase>) =>
    onChange(phases.map((p, idx) => (idx === i ? { ...p, ...next } : p)));

  const remove = (i: number) => {
    onChange(phases.filter((_, idx) => idx !== i));
    // Items pointing at removed/shifted phases must be re-anchored, never left
    // pointing at a different phase than the practitioner chose.
    onItemsChange(
      items.map((it) =>
        it.phaseIndex == null
          ? it
          : it.phaseIndex === i
            ? { ...it, phaseIndex: null }
            : it.phaseIndex > i
              ? { ...it, phaseIndex: it.phaseIndex - 1 }
              : it,
      ),
    );
  };

  return (
    <section className="mt-4" data-testid="pd-phases">
      <div className="mb-2 flex items-center justify-between">
        <h3 className="m-0 text-[12px] font-bold tracking-[0.03em] text-faint uppercase">
          Phases
        </h3>
        <Btn
          size="sm"
          variant="ghost"
          data-testid="pd-add-phase"
          onClick={() => onChange([...phases, emptyPhase()])}
        >
          <Plus size={13} aria-hidden /> Add phase
        </Btn>
      </div>
      {phases.length === 0 ? (
        <p className="m-0 text-[12px] text-faint">
          No phases. A protocol may be a single unphased plan.
        </p>
      ) : (
        <ul className="m-0 flex list-none flex-col gap-2 p-0">
          {phases.map((p, i) => (
            <li key={i} className="rounded-lg border border-line bg-card p-3" data-testid="pd-phase">
              <div className="grid gap-2 sm:grid-cols-[1fr_auto]">
                <div>
                  <label className={LABEL} htmlFor={`pd-phase-name-${i}`}>
                    Phase name
                  </label>
                  <input
                    id={`pd-phase-name-${i}`}
                    data-testid={`pd-phase-name-${i}`}
                    className={INPUT}
                    value={p.name}
                    onChange={(e) => setAt(i, { name: e.target.value })}
                  />
                </div>
                <div className="flex items-end">
                  <button
                    type="button"
                    onClick={() => remove(i)}
                    aria-label={`Remove phase ${i + 1}`}
                    data-testid={`pd-remove-phase-${i}`}
                    className="flex h-8 items-center gap-1 rounded-lg border border-line bg-card px-2 text-[12px] font-semibold text-critical hover:border-line-hover focus-visible:outline-2 focus-visible:outline-action"
                  >
                    <Trash2 size={13} aria-hidden /> Remove
                  </button>
                </div>
              </div>
              <div className="mt-2">
                <span className={LABEL}>Timing</span>
                <div className="flex flex-wrap gap-3">
                  {(["relative", "absolute"] as const).map((mode) => (
                    <label key={mode} className="flex items-center gap-[5px] text-[12px] text-body">
                      <input
                        type="radio"
                        name={`pd-phase-timing-${i}`}
                        checked={p.timing === mode}
                        onChange={() => setAt(i, { timing: mode })}
                      />
                      {mode === "relative" ? "Relative to start" : "Fixed dates"}
                    </label>
                  ))}
                </div>
              </div>
              {p.timing === "relative" ? (
                <div className="mt-2 grid gap-2 sm:grid-cols-2">
                  <div>
                    <label className={LABEL} htmlFor={`pd-phase-rel-start-${i}`}>
                      Starts on day
                    </label>
                    <input
                      id={`pd-phase-rel-start-${i}`}
                      data-testid={`pd-phase-rel-start-${i}`}
                      type="number"
                      className={INPUT}
                      value={p.relativeStartDay}
                      onChange={(e) => setAt(i, { relativeStartDay: e.target.value })}
                    />
                  </div>
                  <div>
                    <label className={LABEL} htmlFor={`pd-phase-rel-days-${i}`}>
                      Duration (days)
                    </label>
                    <input
                      id={`pd-phase-rel-days-${i}`}
                      data-testid={`pd-phase-rel-days-${i}`}
                      type="number"
                      className={INPUT}
                      value={p.relativeDurationDays}
                      onChange={(e) => setAt(i, { relativeDurationDays: e.target.value })}
                    />
                  </div>
                </div>
              ) : (
                <div className="mt-2 grid gap-2 sm:grid-cols-2">
                  <div>
                    <label className={LABEL} htmlFor={`pd-phase-start-${i}`}>
                      Start date
                    </label>
                    <input
                      id={`pd-phase-start-${i}`}
                      data-testid={`pd-phase-start-${i}`}
                      type="date"
                      className={INPUT}
                      value={p.startsOn}
                      onChange={(e) => setAt(i, { startsOn: e.target.value })}
                    />
                  </div>
                  <div>
                    <label className={LABEL} htmlFor={`pd-phase-end-${i}`}>
                      End date
                    </label>
                    <input
                      id={`pd-phase-end-${i}`}
                      data-testid={`pd-phase-end-${i}`}
                      type="date"
                      className={INPUT}
                      value={p.endsOn}
                      onChange={(e) => setAt(i, { endsOn: e.target.value })}
                    />
                  </div>
                </div>
              )}
              <div className="mt-2">
                <label className={LABEL} htmlFor={`pd-phase-notes-${i}`}>
                  Notes
                </label>
                <textarea
                  id={`pd-phase-notes-${i}`}
                  className={AREA}
                  value={p.notes}
                  onChange={(e) => setAt(i, { notes: e.target.value })}
                />
              </div>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

// --------------------------------------------------------------- item editor

function ItemEditor({
  items,
  phases,
  onChange,
  versionId,
}: {
  items: DraftItem[];
  phases: DraftPhase[];
  onChange: (i: DraftItem[]) => void;
  versionId: string;
}) {
  const setAt = (i: number, next: Partial<DraftItem>) =>
    onChange(items.map((it, idx) => (idx === i ? { ...it, ...next } : it)));

  return (
    <section className="mt-4" data-testid="pd-items">
      <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
        <h3 className="m-0 text-[12px] font-bold tracking-[0.03em] text-faint uppercase">
          Protocol items
        </h3>
        <div className="flex flex-wrap gap-2">
          {ITEM_KINDS.map((k) => (
            <Btn
              key={k.kind}
              size="sm"
              variant="ghost"
              data-testid={`pd-add-${k.kind}`}
              onClick={() =>
                onChange([
                  ...items,
                  {
                    kind: k.kind,
                    label: "",
                    phaseIndex: null,
                    instructions: "",
                    catalogProductId: null,
                    catalogProductVersionId: null,
                    manufacturer: null,
                    labelVersion: null,
                    dosageText: "",
                    timingText: "",
                    route: "",
                    affiliateUrl: "",
                    itemId: null,
                  },
                ])
              }
            >
              <Plus size={13} aria-hidden /> {k.label}
            </Btn>
          ))}
        </div>
      </div>

      {items.length === 0 ? (
        <p className="m-0 text-[12px] text-faint">No items yet.</p>
      ) : (
        <ul className="m-0 flex list-none flex-col gap-2 p-0">
          {items.map((it, i) => (
            <li
              key={i}
              data-testid="pd-item"
              data-kind={it.kind}
              className="rounded-lg border border-line bg-card p-3"
            >
              <div className="mb-2 flex items-center justify-between gap-2">
                <span className="rounded-full bg-slate-tint px-[9px] py-[2px] text-[10.5px] font-bold text-slate-badge">
                  {KIND_LABEL[it.kind]}
                </span>
                <button
                  type="button"
                  onClick={() => onChange(items.filter((_, idx) => idx !== i))}
                  aria-label={`Remove item ${i + 1}`}
                  data-testid={`pd-remove-item-${i}`}
                  className="flex h-7 items-center gap-1 rounded-lg border border-line bg-card px-2 text-[11.5px] font-semibold text-critical hover:border-line-hover focus-visible:outline-2 focus-visible:outline-action"
                >
                  <Trash2 size={12} aria-hidden /> Remove
                </button>
              </div>

              <div className="grid gap-2 sm:grid-cols-2">
                <div className="sm:col-span-2">
                  <label className={LABEL} htmlFor={`pd-item-label-${i}`}>
                    Label
                  </label>
                  <input
                    id={`pd-item-label-${i}`}
                    data-testid={`pd-item-label-${i}`}
                    className={INPUT}
                    value={it.label}
                    onChange={(e) => setAt(i, { label: e.target.value })}
                  />
                </div>
                {phases.length > 0 && (
                  <div>
                    <label className={LABEL} htmlFor={`pd-item-phase-${i}`}>
                      Phase
                    </label>
                    <select
                      id={`pd-item-phase-${i}`}
                      data-testid={`pd-item-phase-${i}`}
                      className={INPUT}
                      value={it.phaseIndex == null ? "" : String(it.phaseIndex)}
                      onChange={(e) =>
                        setAt(i, {
                          phaseIndex: e.target.value === "" ? null : Number(e.target.value),
                        })
                      }
                    >
                      <option value="">All phases</option>
                      {phases.map((p, pi) => (
                        <option key={pi} value={pi}>
                          {p.name || `Phase ${pi + 1}`}
                        </option>
                      ))}
                    </select>
                  </div>
                )}
                <div className={phases.length > 0 ? "" : "sm:col-span-2"}>
                  <label className={LABEL} htmlFor={`pd-item-instructions-${i}`}>
                    Instructions
                  </label>
                  <textarea
                    id={`pd-item-instructions-${i}`}
                    className={AREA}
                    value={it.instructions}
                    onChange={(e) => setAt(i, { instructions: e.target.value })}
                  />
                </div>
              </div>

              {it.kind === "product" && (
                <ProductFields index={i} item={it} setAt={setAt} versionId={versionId} />
              )}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function ProductFields({
  index,
  item,
  setAt,
  versionId,
}: {
  index: number;
  item: DraftItem;
  setAt: (i: number, next: Partial<DraftItem>) => void;
  versionId: string;
}) {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<LiveCatalogProduct[] | null>(null);
  const [searching, setSearching] = useState(false);
  const [searchError, setSearchError] = useState<string | null>(null);

  const search = () => {
    setSearching(true);
    setSearchError(null);
    api.protocols
      .searchCatalog(query.trim() || null, 20)
      .then((r) => setResults(r.products))
      .catch((e: unknown) => {
        setResults(null);
        setSearchError(errText(e, "The product catalog could not be searched."));
      })
      .finally(() => setSearching(false));
  };

  return (
    <div className="mt-2 rounded-lg border border-line bg-[rgba(247,250,252,0.7)] p-3">
      <div className="flex flex-wrap items-end gap-2">
        <div className="min-w-[180px] flex-1">
          <label className={LABEL} htmlFor={`pd-catalog-q-${index}`}>
            Search the product catalog
          </label>
          <input
            id={`pd-catalog-q-${index}`}
            data-testid={`pd-catalog-q-${index}`}
            className={INPUT}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && (e.preventDefault(), search())}
          />
        </div>
        <Btn
          size="sm"
          variant="ghost"
          disabled={searching}
          data-testid={`pd-catalog-search-${index}`}
          onClick={search}
        >
          {searching ? "Searching…" : "Search"}
        </Btn>
      </div>

      {searchError && (
        <p role="alert" className="m-0 mt-2 text-[11.5px] font-medium text-critical">
          {searchError}
        </p>
      )}
      {results != null && results.length === 0 && (
        <p className="m-0 mt-2 text-[11.5px] text-faint">
          No catalog products matched. A product not in the catalog can still be entered by name,
          but it will carry no verified label data.
        </p>
      )}
      {results != null && results.length > 0 && (
        <ul className="m-0 mt-2 flex max-h-[180px] list-none flex-col gap-1 overflow-y-auto p-0">
          {results.map((p) => (
            <li key={p.productId}>
              <button
                type="button"
                data-testid={`pd-catalog-pick-${p.productId}`}
                onClick={() =>
                  setAt(index, {
                    label: p.name,
                    catalogProductId: p.productId,
                    catalogProductVersionId: p.productVersionId,
                    manufacturer: p.manufacturer,
                    labelVersion: p.labelVersion,
                  })
                }
                className="w-full rounded-lg border border-line bg-card px-2 py-[6px] text-left text-[12px] hover:border-line-hover focus-visible:outline-2 focus-visible:outline-action"
              >
                <span className="font-semibold text-ink">{p.name}</span>
                <span className="text-subtle">
                  {" · "}
                  {p.manufacturer ?? "Manufacturer not recorded"}
                  {p.labelVersion ? ` · label ${p.labelVersion}` : " · no label version on file"}
                </span>
                <span className="block text-[11px] text-faint">
                  {VERIFICATION_LABEL[p.verificationStatus]}
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}

      <div className="mt-3 grid gap-2 sm:grid-cols-3">
        <div>
          <label className={LABEL} htmlFor={`pd-dosage-${index}`}>
            Dosage
          </label>
          <input
            id={`pd-dosage-${index}`}
            data-testid={`pd-dosage-${index}`}
            className={INPUT}
            value={item.dosageText}
            onChange={(e) => setAt(index, { dosageText: e.target.value })}
          />
        </div>
        <div>
          <label className={LABEL} htmlFor={`pd-timing-${index}`}>
            Timing
          </label>
          <input
            id={`pd-timing-${index}`}
            data-testid={`pd-timing-${index}`}
            className={INPUT}
            value={item.timingText}
            onChange={(e) => setAt(index, { timingText: e.target.value })}
          />
        </div>
        <div>
          <label className={LABEL} htmlFor={`pd-route-${index}`}>
            Route
          </label>
          <input
            id={`pd-route-${index}`}
            data-testid={`pd-route-${index}`}
            className={INPUT}
            value={item.route}
            onChange={(e) => setAt(index, { route: e.target.value })}
          />
        </div>
      </div>

      <dl
        data-testid={`pd-product-identity-${index}`}
        className="m-0 mt-3 grid grid-cols-[auto_1fr] gap-x-3 gap-y-[3px] text-[11.5px]"
      >
        <dt className="font-semibold text-faint">Catalog product</dt>
        <dd className="m-0 text-body">{item.catalogProductId ?? "Not linked to the catalog"}</dd>
        <dt className="font-semibold text-faint">Manufacturer</dt>
        <dd className="m-0 text-body">{item.manufacturer ?? "Not recorded"}</dd>
        <dt className="font-semibold text-faint">Label version</dt>
        <dd className="m-0 text-body">{item.labelVersion ?? "Not recorded"}</dd>
      </dl>

      <div className="mt-3">
        <label className={LABEL} htmlFor={`pd-affiliate-${index}`}>
          Affiliate link (commercial metadata only)
        </label>
        <input
          id={`pd-affiliate-${index}`}
          data-testid={`pd-affiliate-${index}`}
          className={INPUT}
          value={item.affiliateUrl}
          onChange={(e) => setAt(index, { affiliateUrl: e.target.value })}
        />
        <p className="m-0 mt-1 text-[11px] leading-[1.5] text-faint">
          An affiliate link is commercial metadata only. It establishes no clinical eligibility,
          evidence, dosage, or safety, and is never used to rank or justify a recommendation.
        </p>
      </div>

      <InteractionPanel versionId={versionId} itemId={item.itemId} index={index} />
    </div>
  );
}

// -------------------------------------------------------- interaction review

function InteractionPanel({
  versionId,
  itemId,
  index,
}: {
  versionId: string;
  itemId: string | null;
  index: number;
}) {
  const { announce } = useFeedback();
  const [check, setCheck] = useState<LiveInteractionCheck | null>(null);
  const [running, setRunning] = useState(false);
  const [failed, setFailed] = useState<string | null>(null);
  const [note, setNote] = useState("");
  const [reviewing, setReviewing] = useState(false);

  const entry = useMemo(
    () => (itemId ? (check?.items.find((i) => i.itemId === itemId) ?? null) : null),
    [check, itemId],
  );

  const run = () => {
    setRunning(true);
    setFailed(null);
    api.protocols
      .checkInteractions(versionId)
      .then(setCheck)
      .catch((e: unknown) => {
        setCheck(null);
        setFailed(errText(e, "The interaction check could not be run."));
      })
      .finally(() => setRunning(false));
  };

  const recordReview = () => {
    if (!itemId || reviewing) return;
    setReviewing(true);
    api.protocols
      .reviewItemInteractions(itemId, note.trim() || null)
      .then((r) => {
        announce(r.message);
        run();
      })
      .catch((e: unknown) => announce(errText(e, "The review could not be recorded.")))
      .finally(() => setReviewing(false));
  };

  const reviewed = entry?.interactionReviewState === "reviewed_by_practitioner";

  return (
    <div
      data-testid={`pd-interactions-${index}`}
      data-review-state={entry?.interactionReviewState ?? "not_completed"}
      className="mt-3 rounded-lg border border-line bg-card p-3"
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="flex items-center gap-[6px] text-[12px] font-bold text-ink">
          <ShieldAlert size={13} strokeWidth={2} className="text-warning-deep" aria-hidden />
          Interactions
        </span>
        <Btn
          size="sm"
          variant="ghost"
          disabled={running || !itemId}
          data-testid={`pd-run-check-${index}`}
          onClick={run}
        >
          {running ? "Checking…" : "Run interaction check"}
        </Btn>
      </div>

      {!itemId && (
        <p className="m-0 mt-2 text-[11.5px] leading-[1.5] text-faint">
          Save the draft before running a check — the check reads the persisted item, not the
          unsaved form.
        </p>
      )}

      {failed && (
        <p role="alert" className="m-0 mt-2 text-[11.5px] font-medium text-critical">
          {failed} No interaction conclusion is available.
        </p>
      )}

      {/* The default and the honest state. Until a deterministic check is
          possible AND a practitioner signs off, this is what the item reads. */}
      {!reviewed && (
        <p
          data-testid={`pd-interaction-status-${index}`}
          className="m-0 mt-2 text-[12px] font-semibold text-warning-deep"
        >
          Interaction review not completed
        </p>
      )}
      {reviewed && (
        <p
          data-testid={`pd-interaction-status-${index}`}
          className="m-0 mt-2 flex items-center gap-1 text-[12px] font-semibold text-positive"
        >
          <CheckCircle2 size={13} aria-hidden />
          Interaction review recorded by a practitioner
        </p>
      )}

      {entry && (
        <>
          <p className="m-0 mt-2 text-[11.5px] leading-[1.5] text-subtle">
            {entry.state === "not_completed"
              ? entry.reason
              : entry.findings.length === 0
                ? "The deterministic check ran and the checked sources contained no matching interaction. That is not a determination that this product is interaction-free."
                : `The deterministic check found ${entry.findings.length} matching ${entry.findings.length === 1 ? "record" : "records"} in the checked sources.`}
          </p>
          <p className="m-0 mt-1 text-[11px] text-faint">
            Verification: {VERIFICATION_LABEL[entry.verificationStatus]}
          </p>
          {entry.findings.length > 0 && (
            <ul
              data-testid={`pd-findings-${index}`}
              className="m-0 mt-2 flex list-none flex-col gap-[6px] p-0"
            >
              {entry.findings.map((f, fi) => (
                <li
                  key={fi}
                  className="rounded-lg border border-line bg-warning-tint px-2 py-[6px] text-[11.5px]"
                >
                  <span className="font-bold text-ink">
                    {f.ingredient ?? "Ingredient not named"} ↔{" "}
                    {f.medication ?? "Medication not named"}
                  </span>
                  {f.severity && <span className="text-warning-deep"> · {f.severity}</span>}
                  {f.mechanism && (
                    <span className="block text-body">{f.mechanism}</span>
                  )}
                  <span className="block text-faint">
                    Source: {f.source ?? "not recorded"}
                    {f.version ? ` (${f.version})` : ""}
                  </span>
                </li>
              ))}
            </ul>
          )}
          {check && (
            <p className="m-0 mt-2 flex items-start gap-1 text-[11px] leading-[1.5] text-faint">
              <Info size={12} className="mt-[2px] shrink-0" aria-hidden />
              {check.disclaimer} Medications on file: {check.medicationsRecorded}, of which{" "}
              {check.medicationsCoded} carry a coded identifier.
            </p>
          )}
        </>
      )}

      {itemId && !reviewed && (
        <div className="mt-2">
          <label className={LABEL} htmlFor={`pd-review-${index}`}>
            Practitioner interaction review note (optional)
          </label>
          <input
            id={`pd-review-${index}`}
            data-testid={`pd-review-note-${index}`}
            className={INPUT}
            value={note}
            onChange={(e) => setNote(e.target.value)}
          />
          <Btn
            size="sm"
            variant="ghost"
            className="mt-2"
            disabled={reviewing}
            data-testid={`pd-record-review-${index}`}
            onClick={recordReview}
          >
            {reviewing ? "Recording…" : "Record interaction review"}
          </Btn>
        </div>
      )}
    </div>
  );
}

// ------------------------------------------------------------ frozen version

function FrozenVersion({
  version,
  kindLabel,
}: {
  version: LiveProtocolVersion;
  kindLabel: string;
}) {
  const phaseName = (id: string | null) =>
    id ? (version.phases.find((p) => p.id === id)?.name ?? "Unknown phase") : null;

  return (
    <Card className="p-4" >
      <CardTitle>
        {kindLabel} — v{version.version}
      </CardTitle>
      <p className="m-0 mt-1 mb-3 text-[11.5px] leading-[1.5] text-faint">
        Immutable. Approved {fmtDateTime(version.approvedAt)}
        {version.activatedAt ? ` · activated ${fmtDateTime(version.activatedAt)}` : ""}. Correcting
        it creates a new draft version — these instructions are never overwritten.
      </p>

      {version.summary && (
        <p className="m-0 mb-3 text-[12.5px] leading-[1.55] text-body">{version.summary}</p>
      )}

      <dl className="m-0 mb-3 grid gap-2 sm:grid-cols-2">
        {(
          [
            ["Diet", version.dietInstructions],
            ["Lifestyle", version.lifestyleInstructions],
            ["Monitoring", version.monitoringPlan],
            ["Follow-up", version.followupPlan],
          ] as const
        ).map(([label, value]) => (
          <div key={label}>
            <dt className={LABEL}>{label}</dt>
            <dd className="m-0 text-[12.5px] leading-[1.5] text-body">
              {value ?? <span className="text-faint">Not recorded</span>}
            </dd>
          </div>
        ))}
      </dl>

      {version.phases.length > 0 && (
        <ul className="m-0 mb-3 flex list-none flex-col gap-1 p-0">
          {version.phases.map((p) => (
            <li key={p.id} className="text-[12px] text-body">
              <span className="font-semibold">{p.name}</span>
              {p.startsOn || p.endsOn ? (
                <span className="text-subtle">
                  {" · "}
                  {p.startsOn ?? "start not set"} → {p.endsOn ?? "end not set"}
                </span>
              ) : p.relativeStartDay != null || p.relativeDurationDays != null ? (
                <span className="text-subtle">
                  {" · day "}
                  {p.relativeStartDay ?? "?"} for {p.relativeDurationDays ?? "?"} days
                </span>
              ) : (
                <span className="text-faint"> · timing not recorded</span>
              )}
            </li>
          ))}
        </ul>
      )}

      {version.items.length === 0 ? (
        <p className="m-0 text-[12px] text-faint">This version records no items.</p>
      ) : (
        <ul className="m-0 flex list-none flex-col gap-2 p-0">
          {version.items.map((it) => (
            <li
              key={it.id}
              data-testid="frozen-item"
              className="rounded-lg border border-line bg-card p-[10px]"
            >
              <div className="flex flex-wrap items-center gap-2">
                <span className="rounded-full bg-slate-tint px-[8px] py-[2px] text-[10px] font-bold text-slate-badge">
                  {KIND_LABEL[it.kind] ?? it.kind}
                </span>
                <span className="text-[12.5px] font-semibold text-ink">{it.label}</span>
                {phaseName(it.phaseId) && (
                  <span className="text-[11.5px] text-faint">{phaseName(it.phaseId)}</span>
                )}
              </div>
              {it.kind === "product" && (
                <>
                  <p className="m-0 mt-1 text-[11.5px] text-subtle">
                    {it.manufacturer ?? "Manufacturer not recorded"}
                    {it.labelVersion ? ` · label ${it.labelVersion}` : " · label version not recorded"}
                    {it.dosageText ? ` · ${it.dosageText}` : ""}
                    {it.timingText ? ` · ${it.timingText}` : ""}
                    {it.route ? ` · ${it.route}` : ""}
                  </p>
                  <p
                    data-testid="frozen-item-interaction"
                    className={`m-0 mt-1 text-[11.5px] font-semibold ${
                      it.interactionReviewState === "reviewed_by_practitioner"
                        ? "text-positive"
                        : "text-warning-deep"
                    }`}
                  >
                    {it.interactionReviewState === "reviewed_by_practitioner"
                      ? "Interaction review recorded by a practitioner"
                      : "Interaction review not completed"}
                  </p>
                  {it.affiliateUrl && (
                    <p className="m-0 mt-1 flex items-center gap-1 text-[11px] text-faint">
                      <Package size={11} aria-hidden />
                      Affiliate link on file — commercial metadata only, carrying no clinical
                      meaning.
                    </p>
                  )}
                </>
              )}
              {it.instructions && (
                <p className="m-0 mt-1 text-[12px] leading-[1.5] text-body">{it.instructions}</p>
              )}
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

// ----------------------------------------------------------- version history

function VersionHistory({
  data,
  busy,
  setBusy,
  onChanged,
}: {
  data: LivePatientProtocol;
  busy: boolean;
  setBusy: (b: boolean) => void;
  onChanged: () => void;
}) {
  const { announce } = useFeedback();
  const [confirmActivate, setConfirmActivate] = useState<string | null>(null);

  const act = (kind: "activate" | "revise", versionId: string) => {
    if (busy) return;
    setBusy(true);
    setConfirmActivate(null);
    const call =
      kind === "activate"
        ? api.protocols.activate(versionId)
        : api.protocols.revise(versionId);
    call
      .then((r) => {
        announce(r.message ?? "Done.");
        onChanged();
      })
      .catch((e: unknown) =>
        announce(
          errText(
            e,
            kind === "activate"
              ? "The version could not be activated."
              : "A new draft could not be created.",
          ),
        ),
      )
      .finally(() => setBusy(false));
  };

  if (data.history.length === 0) {
    return (
      <Card className="p-4">
        <CardTitle>
          <span className="flex items-center gap-[6px]">
            <History size={13} strokeWidth={2} aria-hidden /> Version history
          </span>
        </CardTitle>
        <p data-testid="protocol-history-empty" className="m-0 mt-1 text-[12.5px] text-subtle">
          No versions have been written yet.
        </p>
      </Card>
    );
  }

  return (
    <Card className="p-4">
      <CardTitle>
        <span className="flex items-center gap-[6px]">
          <History size={13} strokeWidth={2} aria-hidden /> Version history
        </span>
      </CardTitle>
      <p className="m-0 mt-1 mb-3 text-[11.5px] leading-[1.5] text-faint">
        Append-only. Superseded versions are kept, never deleted or edited.
      </p>
      <ul data-testid="protocol-history" className="m-0 flex list-none flex-col gap-1 p-0">
        {data.history.map((h) => (
          <li
            key={h.id}
            data-testid="protocol-history-row"
            data-version={h.version}
            data-status={h.status}
            className="flex flex-wrap items-center gap-2 rounded-lg border border-line bg-card px-[10px] py-[7px]"
          >
            <span className="text-[12px] font-bold text-ink">v{h.version}</span>
            <span className="rounded-full bg-slate-tint px-[8px] py-[2px] text-[10px] font-bold text-slate-badge">
              {h.status}
            </span>
            <span className="min-w-0 flex-1 truncate text-[12px] text-body">{h.title}</span>
            <span className="text-[11px] text-faint">
              {h.activatedAt
                ? `activated ${fmtDateTime(h.activatedAt)}`
                : h.approvedAt
                  ? `approved ${fmtDateTime(h.approvedAt)}`
                  : `created ${fmtDateTime(h.createdAt)}`}
            </span>
            {data.canAuthor && h.status === "approved" && (
              <Btn
                size="sm"
                variant="primary"
                disabled={busy}
                data-testid={`protocol-activate-${h.version}`}
                onClick={() => setConfirmActivate(h.id)}
              >
                Activate
              </Btn>
            )}
            {data.canAuthor && (h.status === "approved" || h.status === "active") && (
              <Btn
                size="sm"
                variant="ghost"
                disabled={busy || data.draft != null}
                data-testid={`protocol-revise-${h.version}`}
                onClick={() => act("revise", h.id)}
              >
                {data.draft != null ? "Draft open" : "Revise into new draft"}
              </Btn>
            )}
          </li>
        ))}
      </ul>
      <ConfirmDialog
        open={confirmActivate != null}
        title="Put this version in effect?"
        body="Activating makes this the patient's active protocol and supersedes any previously active version, which is kept. It does NOT send instructions to the patient, place a lab or supplement order, charge anything, modify medications, or write into a note — each of those is a separate action."
        confirmLabel="Activate version"
        onConfirm={() => confirmActivate && act("activate", confirmActivate)}
        onCancel={() => setConfirmActivate(null)}
      />
    </Card>
  );
}

// -------------------------------------------------------------- template tools

function TemplateTools({
  data,
  busy,
  setBusy,
  onChanged,
}: {
  data: LivePatientProtocol;
  busy: boolean;
  setBusy: (b: boolean) => void;
  onChanged: () => void;
}) {
  const { announce } = useFeedback();
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const source = data.draft ?? data.active ?? data.approved;

  if (!data.canAuthor) return null;

  const create = () => {
    if (busy || !name.trim()) return;
    setBusy(true);
    api.protocols.templates
      .create({
        name: name.trim(),
        description: description.trim() || null,
        fromVersionId: source?.id ?? null,
      })
      .then((r) => {
        announce(r.message ?? "Template created.");
        setName("");
        setDescription("");
        onChanged();
      })
      .catch((e: unknown) => announce(errText(e, "The template could not be created.")))
      .finally(() => setBusy(false));
  };

  return (
    <Card className="p-4">
      <CardTitle>Save as an organization template</CardTitle>
      <p className="m-0 mt-1 mb-3 text-[11.5px] leading-[1.5] text-faint">
        {source
          ? `Copies version ${source.version} into a new, versioned organization template. The copy is detached — editing the template never changes this patient's protocol, and customizing a protocol started from a template never changes the template.`
          : "There is no version to copy yet. Create a draft first."}
      </p>
      <div className="grid gap-2 sm:grid-cols-2">
        <div>
          <label className={LABEL} htmlFor="tpl-name">
            Template name
          </label>
          <input
            id="tpl-name"
            data-testid="tpl-name"
            className={INPUT}
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
        </div>
        <div>
          <label className={LABEL} htmlFor="tpl-description">
            Description
          </label>
          <input
            id="tpl-description"
            data-testid="tpl-description"
            className={INPUT}
            value={description}
            onChange={(e) => setDescription(e.target.value)}
          />
        </div>
      </div>
      <div className="mt-3">
        <Btn
          size="sm"
          variant="ghost"
          disabled={busy || !name.trim()}
          data-testid="tpl-create"
          onClick={create}
        >
          {busy ? "Saving…" : source ? `Create template from v${source.version}` : "Create template"}
        </Btn>
      </div>
    </Card>
  );
}
