"use client";

import { useEffect, useRef, useState } from "react";
import { Btn } from "@/components/ui/Btn";
import type { ProgramProductCatalogBinding } from "@/contracts/programAssignments";
import { CATALOG_HOLD_WORDS, catalogHold, type ObservedCatalogProduct } from "@/contracts/programCatalogObservation";
import {
  CATALOG_UNAVAILABLE_WORDS, createCatalogPickerController,
  type CatalogBindingStatus, type CatalogPickerController, type CatalogPickerScope, type CatalogPickerState, type CatalogReader,
} from "@/lib/programs/catalogPicker";

/**
 * The governed catalog picker for one supplement step. The practitioner searches the catalog this
 * clinic's session observes, sees each product with the release and target the service reported
 * and any declared hold, and binds a step by choosing one exact product. The panel never binds on
 * its own, never moves a binding to a newer release unless asked, and keeps the existing binding
 * through every failure. A product being observed here says nothing about purchase availability
 * or clinical approval; those are decided elsewhere, as they were before.
 */
const INPUT = "h-8 w-full rounded-lg border border-line bg-card px-3 text-[12.5px] text-body outline-none focus-visible:outline-2 focus-visible:outline-action";

export type CatalogPickerProps = {
  label: string;
  scope: CatalogPickerScope;
  binding: ProgramProductCatalogBinding | undefined;
  disabled: boolean;
  /** Null when the Studio has not connected a reader: the binding is then shown and kept, and nothing can be searched. */
  read: CatalogReader | null;
  onBind: (binding: ProgramProductCatalogBinding, product: ObservedCatalogProduct) => void;
  onUnbind: () => void;
};

export function CatalogPickerPanel({ label, scope, binding, disabled, read, onBind, onUnbind }: CatalogPickerProps) {
  const [state, setState] = useState<CatalogPickerState>({ kind: "idle", note: "none" });
  const [query, setQuery] = useState("");
  const [refusal, setRefusal] = useState<string | null>(null);
  const controller = useRef<CatalogPickerController | null>(null);
  if (controller.current === null && read) {
    controller.current = createCatalogPickerController({ read, scope, onChange: setState });
  }
  useEffect(() => {
    controller.current?.rebind(scope);
    setRefusal(null);
  }, [scope.versionId, scope.stepId, scope.stepRevision, scope.session]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => () => controller.current?.dispose(), []);

  const current = controller.current;
  const bindingStatus: CatalogBindingStatus = current ? current.bindingStatus(binding) : { status: "unobserved" };
  const search = () => { setRefusal(null); void current?.search(query); };
  const select = (stableId: string) => {
    if (!current) return;
    const result = current.select(stableId);
    if (result.ok) { setRefusal(null); onBind(result.binding, result.product); return; }
    setRefusal(result.reason === "held" && result.hold ? `Not bound: ${CATALOG_HOLD_WORDS[result.hold]}.`
      : result.reason === "not_observed" ? "Not bound: that product is not in the observation on screen. Search again and choose from the result."
      : "Not bound: nothing is observed yet. Search the catalog first.");
  };
  return (
    <CatalogPickerView label={label} state={state} binding={binding} bindingStatus={bindingStatus} query={query} disabled={disabled}
      readerConnected={current !== null} refusal={refusal} onQuery={setQuery} onSearch={search} onSelect={select} onUnbind={onUnbind} />
  );
}

/** The panel as rendered for a given state. Kept apart from the controller so every state can be rendered and read. */
export function CatalogPickerView({ label, state, binding, bindingStatus, query, disabled, readerConnected, refusal, onQuery, onSearch, onSelect, onUnbind }: {
  label: string; state: CatalogPickerState; binding: ProgramProductCatalogBinding | undefined; bindingStatus: CatalogBindingStatus;
  query: string; disabled: boolean; readerConnected: boolean; refusal: string | null;
  onQuery: (query: string) => void; onSearch: () => void; onSelect: (stableId: string) => void; onUnbind: () => void;
}) {
  const reading = state.kind === "reading";
  return (
    <div className="md:col-span-4 flex flex-col gap-2 rounded-[8px] border border-line px-3 py-2" data-testid="catalog-picker" data-state={state.kind}>
      <p className="m-0 text-[12px] text-body" data-testid="catalog-binding">
        {binding
          ? <>Bound to catalog product <span className="font-semibold">{binding.stableId}</span> version {binding.version} on {binding.target}. {bindingWords(bindingStatus)}</>
          : "Not bound to a catalog product. The step offers no purchase link until one exact product is chosen from the observed catalog."}
      </p>
      {binding && (
        <div><Btn disabled={disabled} onClick={onUnbind} data-testid="catalog-unbind">Remove this binding</Btn></div>
      )}
      {!readerConnected ? (
        <p className="m-0 text-[11.5px] text-subtle" data-testid="catalog-reader-absent">The catalog reader is not connected in this view, so the binding above can be removed but not changed.</p>
      ) : (
        <>
          <div className="flex gap-2">
            <input className={INPUT} aria-label={`${label} catalog search`} placeholder="Narrow the observed catalog by name or stable id" value={query}
              disabled={disabled || reading} onChange={e => onQuery(e.target.value)} onKeyDown={e => { if (e.key === "Enter") { e.preventDefault(); onSearch(); } }} />
            <Btn disabled={disabled || reading} onClick={onSearch} data-testid="catalog-search">{reading ? "Reading…" : "Search the catalog"}</Btn>
          </div>
          {state.kind === "idle" && state.note === "scope_changed" && (
            <p className="m-0 text-[11.5px] text-subtle" data-testid="catalog-note">The step or the draft changed, so the earlier observation no longer applies. Search again to see the catalog for this step.</p>
          )}
          {state.kind === "idle" && state.note === "none" && (
            <p className="m-0 text-[11.5px] text-subtle" data-testid="catalog-note">Nothing observed yet. A search reads the governed catalog this clinic&apos;s session can see and shows exactly what it reported.</p>
          )}
          {reading && <p className="m-0 text-[11.5px] text-subtle" data-testid="catalog-note">Reading the governed catalog…</p>}
          {state.kind === "unavailable" && (
            <p className="m-0 text-[12px] text-critical" role="status" data-testid="catalog-unavailable" data-reason={state.reason}>{CATALOG_UNAVAILABLE_WORDS[state.reason]}</p>
          )}
          {state.kind === "empty" && (
            <p className="m-0 text-[12px] text-body" role="status" data-testid="catalog-empty">
              {`No products match "${state.observation.query}" in the catalog observed at ${state.observation.observedAt} on ${state.observation.target} (${state.observation.catalogSize} product${state.observation.catalogSize === 1 ? "" : "s"} observed${state.observation.complete ? "" : ", list incomplete"}). This is a match result, not an outage.`}
            </p>
          )}
          {state.kind === "observed" && (
            <div className="flex flex-col gap-1" data-testid="catalog-observed">
              <p className="m-0 text-[11.5px] text-subtle">
                {`Observed at ${state.observation.observedAt} on `}<span className="font-semibold">{state.observation.target}</span>
                {`: ${state.observation.products.length} of ${state.observation.catalogSize} product${state.observation.catalogSize === 1 ? "" : "s"} match${state.observation.complete ? "" : " (the catalog had more pages than were read; this list is a prefix)"}. Being listed is not purchase availability or clinical approval.`}
              </p>
              <ul className="m-0 list-none p-0 flex flex-col gap-1">
                {state.observation.products.map(product => {
                  const hold = catalogHold(product);
                  const bound = binding?.stableId === product.stableId;
                  return (
                    <li key={product.stableId} className="flex flex-wrap items-center gap-2 rounded-[6px] border border-line px-2 py-1" data-testid={`catalog-product-${product.stableId}`} data-hold={hold ?? "none"}>
                      <span className="text-[12px] text-body"><span className="font-semibold">{product.displayName}</span> · {product.stableId} · version {product.version} · {product.productType}{product.labelVersion === null ? " · no approved label" : ` · label version ${product.labelVersion}`}</span>
                      {hold
                        ? <span className="text-[11.5px] text-critical" data-testid={`catalog-held-${product.stableId}`}>Held: {CATALOG_HOLD_WORDS[hold]}.</span>
                        : <Btn disabled={disabled} onClick={() => onSelect(product.stableId)} data-testid={`catalog-select-${product.stableId}`}>
                            {bound && bindingStatus.status === "release_changed" ? `Rebind to version ${product.version}` : bound && bindingStatus.status === "target_differs" ? `Rebind on ${state.observation.target}` : bound ? "Bound" : "Bind this product"}
                          </Btn>}
                    </li>
                  );
                })}
              </ul>
            </div>
          )}
          {refusal && <p className="m-0 text-[12px] text-critical" role="status" data-testid="catalog-refusal">{refusal}</p>}
        </>
      )}
    </div>
  );
}

function bindingWords(status: CatalogBindingStatus): string {
  switch (status.status) {
    case "unobserved": return "Whether this release is what the catalog reports now is unknown until a search observes it.";
    case "not_in_result": return status.wholeCatalog
      ? "This product was not in the catalog as last observed. The binding is kept; nothing is replaced on your behalf."
      : "This product is not in the current search result; that says nothing about whether the catalog still carries it.";
    case "current": return "This matches the release and target the catalog reported.";
    case "release_changed": return `The catalog now reports version ${status.observedVersion}; the binding stays on its own version unless you rebind it.`;
    case "target_differs": return `The catalog observed here is ${status.observedTarget}, not the binding's target; the binding is kept unchanged.`;
  }
}
