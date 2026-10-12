"use client";

import { Btn } from "@/components/ui/Btn";
import { ClinicalNote } from "@/components/ui/ClinicalStates";
import { CatalogPickerPanel } from "@/components/programs/CatalogPickerPanel";
import { ProgramMediaUploadPanel } from "@/components/programs/ProgramMediaUploadPanel";
import type { ProgramMediaUploadScope } from "@/lib/programs/programMediaUpload";
import type { CatalogReader } from "@/lib/programs/catalogPicker";
import {
  governedMediaIssue, newItem, newPhase, readingLevelNote, validateConsumerProgram,
  type ConsumerProgram, type ConsumerProgramItem, type ConsumerProgramPhase,
} from "@/lib/programs/consumerProgramAuthoring";

/**
 * Authoring for the patient-facing program a version carries. The practitioner writes phases
 * and steps in the shape the service compiles and the consumer app renders; the panel validates
 * against the shared contract as they type, previews what a patient would see, and states
 * plainly when a field the contract accepts is not yet admitted by the deployed service.
 *
 * Nothing here orders, doses, approves or publishes. A supplement step names a governed product
 * by identity; a patient buys only through the prepared Fullscript action for that identity.
 */
const INPUT = "h-8 w-full rounded-lg border border-line bg-card px-3 text-[12.5px] text-body outline-none focus-visible:outline-2 focus-visible:outline-action";
const AREA = "min-h-[56px] w-full rounded-lg border border-line bg-card px-3 py-2 text-[12.5px] leading-normal text-body outline-none focus-visible:outline-2 focus-visible:outline-action";
const LABEL = "mb-1 block text-[11px] font-bold tracking-[0.02em] text-subtle uppercase";
const KINDS: ConsumerProgramItem["kind"][] = ["lesson", "diet", "habit", "supplement"];
const AUTHORSHIP = [["", "Not stated (shown as unreviewed)"], ["practitioner_authored", "Practitioner-authored"], ["consumer_ai", "Consumer AI content"], ["unreviewed", "Unreviewed"]] as const;

/** How the editor reaches the governed catalog: the Studio's reader, the draft version and the Studio session it is showing. */
export type ConsumerProgramCatalog = { read: CatalogReader; versionId: string; session: string };

export const CONSUMER_PROGRAM_HELD_TEXT =
  "The deployed service does not return the patient program for this version, so it cannot be edited here without overwriting what it holds. Authoring opens once the reviewed admission candidate (program-education-catalog-admission) is applied by Codex. Nothing typed here is saved.";

export function ConsumerProgramEditor({ value, disabled, onChange, catalog = null, mediaScope = null }: {
  value: ConsumerProgram | null | undefined; disabled: boolean; onChange: (next: ConsumerProgram | null) => void;
  /** Null when no catalog reader is connected: bindings are then shown and kept, never changed. */
  catalog?: ConsumerProgramCatalog | null;
  mediaScope?: Omit<ProgramMediaUploadScope, 'stepId'> | null;
}) {
  if (value === undefined) {
    return <ClinicalNote data-testid="consumer-program-held">{CONSUMER_PROGRAM_HELD_TEXT}</ClinicalNote>;
  }
  if (value === null) {
    return (
      <div className="flex flex-col gap-2" data-testid="consumer-program-empty">
        <p className="m-0 text-[12px] text-subtle">No patient program yet. Without one, this version can be published for the Studio but assigns nothing to a patient.</p>
        <Btn disabled={disabled} onClick={() => onChange({ title: "", phases: [newPhase(1)] })} data-testid="consumer-program-add">Add a patient program</Btn>
      </div>
    );
  }
  const update = (mutate: (draft: ConsumerProgram) => ConsumerProgram) => onChange(mutate(structuredClone(value)));
  const setPhase = (index: number, patch: Partial<ConsumerProgramPhase>) => update(d => { Object.assign(d.phases[index]!, patch); return d; });
  const setItem = (pi: number, ii: number, patch: Partial<ConsumerProgramItem> | Record<string, unknown>) => update(d => { Object.assign(d.phases[pi]!.items[ii]!, patch); return d; });
  const setProduct = (pi: number, ii: number, patch: Record<string, unknown>) => update(d => { const item = d.phases[pi]!.items[ii]!; item.product = { ...(item.product ?? { id: "", ingredientKeys: [], dose: "", purchaseUrl: null }), ...patch } as ConsumerProgramItem["product"]; return d; });
  const validation = validateConsumerProgram(value);
  return (
    <div className="flex flex-col gap-3" data-testid="consumer-program-editor">
      <div>
        <label className={LABEL} htmlFor="cp-title">Patient program title</label>
        <input id="cp-title" className={INPUT} value={value.title} disabled={disabled} data-testid="consumer-program-title"
          onChange={e => update(d => ({ ...d, title: e.target.value }))} />
      </div>
      {value.phases.map((phase, pi) => (
        <div key={pi} className="rounded-[10px] border border-hairline-2 bg-surface px-3 py-2 flex flex-col gap-2" data-testid={`consumer-phase-${pi}`}>
          <div className="grid gap-2 md:grid-cols-4">
            <input className={INPUT} aria-label={`Phase ${pi + 1} id`} value={phase.id} disabled={disabled} onChange={e => setPhase(pi, { id: e.target.value })} />
            <input className={INPUT} aria-label={`Phase ${pi + 1} title`} value={phase.title} disabled={disabled} onChange={e => setPhase(pi, { title: e.target.value })} />
            <input className={INPUT} type="number" min={1} max={365} aria-label={`Phase ${pi + 1} days`} value={phase.days} disabled={disabled} onChange={e => setPhase(pi, { days: Number(e.target.value) })} />
            <select className={INPUT} aria-label={`Phase ${pi + 1} transition`} value={phase.transition} disabled={disabled} onChange={e => setPhase(pi, { transition: e.target.value as ConsumerProgramPhase["transition"] })}>
              <option value="scheduled">Moves on when the days pass</option>
              <option value="check_in">Needs the patient&apos;s check-in</option>
              <option value="practitioner">Needs practitioner release</option>
            </select>
          </div>
          {phase.items.map((item, ii) => <ItemFields key={ii} item={item} pi={pi} ii={ii} disabled={disabled} catalog={catalog}
            mediaScope={mediaScope ? { ...mediaScope, stepId: `${phase.id}/${item.id}` } : null}
            onItem={patch => setItem(pi, ii, patch)} onProduct={patch => setProduct(pi, ii, patch)}
            onRemove={() => update(d => { d.phases[pi]!.items.splice(ii, 1); return d; })} />)}
          <div className="flex flex-wrap gap-2">
            {KINDS.map(kind => <Btn key={kind} size="sm" disabled={disabled} data-testid={`consumer-add-${kind}-${pi}`}
              onClick={() => update(d => { d.phases[pi]!.items.push(newItem(kind, d.phases.flatMap(p => p.items).length + 1)); return d; })}>Add {kind}</Btn>)}
            <span className="flex-1" />
            <Btn size="sm" disabled={disabled || value.phases.length === 1} onClick={() => update(d => { d.phases.splice(pi, 1); return d; })}>Remove phase</Btn>
          </div>
        </div>
      ))}
      <div className="flex gap-2">
        <Btn size="sm" disabled={disabled} data-testid="consumer-add-phase" onClick={() => update(d => { d.phases.push(newPhase(d.phases.length + 1)); return d; })}>Add phase</Btn>
        <Btn size="sm" disabled={disabled} onClick={() => onChange(null)}>Remove the patient program</Btn>
      </div>
      <ValidationPanel validation={validation} />
    </div>
  );
}

function ItemFields({ item, pi, ii, disabled, catalog, mediaScope, onItem, onProduct, onRemove }: {
  item: ConsumerProgramItem; pi: number; ii: number; disabled: boolean; catalog: ConsumerProgramCatalog | null;
  mediaScope: ProgramMediaUploadScope | null;
  onItem: (patch: Record<string, unknown>) => void; onProduct: (patch: Record<string, unknown>) => void; onRemove: () => void;
}) {
  const label = `Step ${pi + 1}.${ii + 1}`;
  const optional = (key: "rationale" | "authorship", raw: string) => onItem({ [key]: raw === "" ? undefined : raw });
  const sources = item.sources ?? [], media = item.media ?? [];
  const instructionsNote = readingLevelNote(item.instructions), rationaleNote = item.rationale ? readingLevelNote(item.rationale) : null;
  return (
    <div className="rounded-[8px] border border-line px-3 py-2 flex flex-col gap-2" data-testid={`consumer-item-${pi}-${ii}`}>
      <div className="grid gap-2 md:grid-cols-4">
        <select className={INPUT} aria-label={`${label} kind`} value={item.kind} disabled={disabled}
          onChange={e => { const kind = e.target.value as ConsumerProgramItem["kind"]; onItem(kind === "supplement" ? { kind, product: item.product ?? { id: "", ingredientKeys: [], dose: "", purchaseUrl: null } } : { kind, product: undefined }); }}>
          {KINDS.map(kind => <option key={kind} value={kind}>{kind}</option>)}
        </select>
        <input className={INPUT} aria-label={`${label} id`} value={item.id} disabled={disabled} onChange={e => onItem({ id: e.target.value })} />
        <input className={INPUT} aria-label={`${label} title`} value={item.title} disabled={disabled} onChange={e => onItem({ title: e.target.value })} />
        <label className="flex items-center gap-2 text-[12px] text-body"><input type="checkbox" checked={item.released} disabled={disabled} aria-label={`${label} released`} onChange={e => onItem({ released: e.target.checked })} /> Released to the patient</label>
      </div>
      <textarea className={AREA} aria-label={`${label} instructions`} value={item.instructions} disabled={disabled} onChange={e => onItem({ instructions: e.target.value })} />
      {instructionsNote && <p className="m-0 text-[11.5px] text-subtle" data-testid={`consumer-reading-${pi}-${ii}`}>{instructionsNote}</p>}
      {item.kind === "supplement" && (
        <div className="grid gap-2 md:grid-cols-4" data-testid={`consumer-product-${pi}-${ii}`}>
          <input className={INPUT} aria-label={`${label} product id`} placeholder="Product id" value={item.product?.id ?? ""} disabled={disabled} onChange={e => onProduct({ id: e.target.value })} />
          <input className={INPUT} aria-label={`${label} ingredient keys`} placeholder="Ingredient keys, comma-separated" value={(item.product?.ingredientKeys ?? []).join(", ")} disabled={disabled}
            onChange={e => onProduct({ ingredientKeys: e.target.value.split(",").map(k => k.trim()).filter(Boolean) })} />
          <input className={INPUT} aria-label={`${label} dose as labelled`} placeholder="Dose exactly as the governed label states it" value={item.product?.dose ?? ""} disabled={disabled} onChange={e => onProduct({ dose: e.target.value })} />
          <input className={INPUT} aria-label={`${label} purchase destination`} placeholder="https purchase destination, or blank" value={item.product?.purchaseUrl ?? ""} disabled={disabled} onChange={e => onProduct({ purchaseUrl: e.target.value || null })} />
          <CatalogPickerPanel label={label} binding={item.product?.catalog} disabled={disabled} read={catalog?.read ?? null}
            scope={{ versionId: catalog?.versionId ?? "", session: catalog?.session ?? "", stepId: item.id, stepRevision: `${item.id}|${item.kind}|${item.product?.id ?? ""}` }}
            onBind={binding => onProduct({ catalog: binding })} onUnbind={() => onProduct({ catalog: undefined })} />
          <p className="m-0 text-[11.5px] text-subtle md:col-span-4">The dose is copied from the governed label, never computed here. A patient buys only through the prepared Fullscript action for the bound catalog product; the printed destination is never opened by the app, and a step without a binding offers no purchase link.</p>
        </div>
      )}
      <div className="grid gap-2 md:grid-cols-2">
        <div>
          <label className={LABEL}>Why this step matters (plain words, about sixth grade)</label>
          <textarea className={AREA} aria-label={`${label} rationale`} value={item.rationale ?? ""} disabled={disabled} onChange={e => optional("rationale", e.target.value)} />
          {rationaleNote && <p className="m-0 text-[11.5px] text-subtle">{rationaleNote}</p>}
        </div>
        <div>
          <label className={LABEL}>Authorship (a label, not an approval)</label>
          <select className={INPUT} aria-label={`${label} authorship`} value={item.authorship ?? ""} disabled={disabled} onChange={e => optional("authorship", e.target.value)}>
            {AUTHORSHIP.map(([v, text]) => <option key={v} value={v}>{text}</option>)}
          </select>
        </div>
      </div>
      <div className="flex flex-col gap-1">
        <span className={LABEL}>Sources (https references, up to 10)</span>
        {sources.map((source, si) => (
          <div key={si} className="grid gap-2 md:grid-cols-[1fr_2fr_auto]">
            <input className={INPUT} aria-label={`${label} source ${si + 1} title`} value={source.title} disabled={disabled} onChange={e => onItem({ sources: sources.map((s, i) => i === si ? { ...s, title: e.target.value } : s) })} />
            <input className={INPUT} aria-label={`${label} source ${si + 1} address`} value={source.url} disabled={disabled} onChange={e => onItem({ sources: sources.map((s, i) => i === si ? { ...s, url: e.target.value } : s) })} />
            <Btn size="sm" disabled={disabled} onClick={() => onItem({ sources: sources.filter((_, i) => i !== si).length ? sources.filter((_, i) => i !== si) : undefined })}>Remove</Btn>
          </div>
        ))}
        <Btn size="sm" disabled={disabled || sources.length >= 10} onClick={() => onItem({ sources: [...sources, { title: "", url: "https://" }] })}>Add source</Btn>
      </div>
      <div className="flex flex-col gap-1">
        {mediaScope ? <ProgramMediaUploadPanel key={`${mediaScope.programId}/${mediaScope.draftId}/${mediaScope.stepId}/${mediaScope.session}`} scope={mediaScope} disabled={disabled} /> : null}
        <span className={LABEL}>Media slots (governed https addresses, up to 5; native uploaded references remain separately held)</span>
        {media.map((slot, mi) => {
          const issue = governedMediaIssue(slot.url);
          return (
            <div key={mi} className="flex flex-col gap-1">
              <div className="grid gap-2 md:grid-cols-[auto_2fr_1fr_auto]">
                <select className={INPUT} aria-label={`${label} media ${mi + 1} kind`} value={slot.kind} disabled={disabled} onChange={e => onItem({ media: media.map((m, i) => i === mi ? { ...m, kind: e.target.value as "video" | "image" } : m) })}>
                  <option value="video">Video</option><option value="image">Image</option>
                </select>
                <input className={INPUT} aria-label={`${label} media ${mi + 1} address`} value={slot.url} disabled={disabled} onChange={e => onItem({ media: media.map((m, i) => i === mi ? { ...m, url: e.target.value } : m) })} />
                <input className={INPUT} aria-label={`${label} media ${mi + 1} caption`} placeholder="Caption (read aloud in place of the media)" value={slot.caption ?? ""} disabled={disabled} onChange={e => onItem({ media: media.map((m, i) => i === mi ? { ...m, caption: e.target.value || undefined } : m) })} />
                <Btn size="sm" disabled={disabled} onClick={() => onItem({ media: media.filter((_, i) => i !== mi).length ? media.filter((_, i) => i !== mi) : undefined })}>Remove</Btn>
              </div>
              {issue && <p className="m-0 text-[11.5px] text-critical" data-testid={`consumer-media-issue-${pi}-${ii}-${mi}`}>Media address {issue}.</p>}
            </div>
          );
        })}
        <Btn size="sm" disabled={disabled || media.length >= 5} onClick={() => onItem({ media: [...media, { kind: "video", url: "https://" }] })}>Add media slot</Btn>
      </div>
      <div><Btn size="sm" disabled={disabled} onClick={onRemove}>Remove step</Btn></div>
    </div>
  );
}

function ValidationPanel({ validation }: { validation: ReturnType<typeof validateConsumerProgram> }) {
  if (!validation.ok) {
    return (
      <div className="rounded-[8px] border border-critical bg-critical-tint px-3 py-2" role="status" data-testid="consumer-program-validation" data-state="invalid">
        <p className="m-0 text-[12px] font-bold text-critical">This patient program cannot be compiled yet. The service would refuse to assign it.</p>
        <ul className="m-0 mt-1 pl-4 text-[12px] text-body">{validation.issues.map(issue => <li key={issue}>{issue}</li>)}</ul>
      </div>
    );
  }
  const { pending } = validation;
  return (
    <div className="flex flex-col gap-2">
      <p className="m-0 text-[12px] text-positive-deep" role="status" data-testid="consumer-program-validation" data-state="valid">
        Valid against the shared program contract: {validation.program.phases.length} phase{validation.program.phases.length === 1 ? "" : "s"}, {validation.program.phases.reduce((n, p) => n + p.items.length, 0)} steps.
      </p>
      {!validation.admittedByCurrentService && (
        <ClinicalNote data-testid="consumer-program-admission">
          {describePending(pending)} The deployed service stores these fields on save but does not admit them yet, so this version cannot be assigned to a patient until the reviewed admission candidate (program-education-catalog-admission) is applied by Codex. Everything else in the program is unaffected.
        </ClinicalNote>
      )}
    </div>
  );
}
function describePending(pending: { education: string[]; catalog: string[] }): string {
  const parts: string[] = [];
  if (pending.education.length) parts.push(`${pending.education.length} step${pending.education.length === 1 ? "" : "s"} use${pending.education.length === 1 ? "s" : ""} education fields (${pending.education.join(", ")})`);
  if (pending.catalog.length) parts.push(`${pending.catalog.length} supplement step${pending.catalog.length === 1 ? "" : "s"} carr${pending.catalog.length === 1 ? "ies" : "y"} a catalog binding (${pending.catalog.join(", ")})`);
  return parts.join("; ") + ".";
}

/** What a patient would see, in the consumer app's words: authorship as a label, held steps withheld,
 * media as slots, and no purchase destination ever printed as something to open. */
export function ConsumerProgramPreview({ program }: { program: ConsumerProgram }) {
  let dayStart = 1;
  const authorship = (item: ConsumerProgramItem) => item.authorship === "practitioner_authored" ? "Practitioner-authored"
    : item.authorship === "consumer_ai" ? "Consumer AI content — not practitioner-reviewed" : "Unreviewed content — not practitioner-approved";
  return (
    <div className="flex flex-col gap-3" data-testid="consumer-program-preview">
      <h3 className="m-0 text-[14px] font-bold text-body">{program.title || "(untitled patient program)"}</h3>
      <p className="m-0 text-[12px] text-subtle">Your existing plan stays in place. Adding a guide does not buy products or change your doses.</p>
      {program.phases.map((phase, pi) => {
        const from = dayStart; dayStart += phase.days;
        return (
          <section key={pi} className="rounded-[8px] border border-line px-3 py-2">
            <h4 className="m-0 text-[12.5px] font-bold text-body">Phase {pi + 1} of {program.phases.length}: {phase.title}</h4>
            <p className="m-0 text-[12px] text-subtle">Days {from} to {from + phase.days - 1} of the program · this phase lasts {phase.days} day{phase.days === 1 ? "" : "s"} · {phase.transition === "scheduled" ? "moves on when the days pass" : phase.transition === "check_in" ? "needs your check-in" : "needs your practitioner's release"}.</p>
            {phase.items.map((item, ii) => (
              <article key={ii} className="mt-2 border-t border-line pt-2" data-testid={`consumer-preview-item-${pi}-${ii}`}>
                <h5 className="m-0 text-[12.5px] font-semibold text-body">{item.title || "(untitled step)"} <span className="font-normal text-subtle">· {item.kind}</span></h5>
                <p className="m-0 text-[11.5px] text-subtle">{authorship(item)}</p>
                <p className="m-0 text-[12px] text-body">{item.released ? item.instructions : "Instructions withheld until reviewed."}</p>
                {item.released && item.rationale && <p className="m-0 text-[12px] text-body"><span className="font-semibold">Why this step matters.</span> {item.rationale}</p>}
                {item.released && item.sources?.length ? <p className="m-0 text-[12px] text-body"><span className="font-semibold">Sources:</span> {item.sources.map(s => `${s.title} — ${s.url}`).join("; ")}</p> : null}
                {item.released && item.media?.map((slot, mi) => <p key={mi} className="m-0 text-[12px] text-body">{slot.kind === "video" ? "Video" : "Image"} slot{slot.caption ? `: ${slot.caption}` : ""} — {slot.url}</p>)}
                {item.kind === "supplement" && item.product && (
                  <p className="m-0 text-[12px] text-body">Supplement product {item.product.id || "(unnamed)"} · dose as labelled: {item.product.dose || "(blank)"} · {item.product.catalog
                    ? `bound to catalog product ${item.product.catalog.stableId} version ${item.product.catalog.version} (${item.product.catalog.target}); a purchase link is prepared by the service only for this identity`
                    : "not bound to a reviewed catalog product: the app offers no purchase link"}.</p>
                )}
              </article>
            ))}
          </section>
        );
      })}
    </div>
  );
}
