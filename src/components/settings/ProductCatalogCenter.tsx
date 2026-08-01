"use client";

import { useCallback, useEffect, useState } from "react";
import {
  AlertTriangle,
  BadgeCheck,
  FileClock,
  Link2,
  PackageSearch,
  RefreshCw,
  Search,
  ShieldQuestion,
} from "lucide-react";
import type {
  LiveProductCatalog,
  LiveProductLabelDetail,
} from "@/adapters/live-types";
import { liveClient } from "@/adapters/live-client";
import { cn } from "@/lib/cn";

/**
 * The governed product catalog.
 *
 * THE ONE RULE THIS SURFACE EXISTS TO HOLD: what is shown is what was captured
 * from an exact label, and nothing else. A field the label did not carry
 * renders as "Unknown" — never as "None", and never blank. "None" is a
 * clinical claim ("this product contains no allergens") that nobody made;
 * blank is the same claim with the evidence hidden.
 *
 * COMMERCIAL DATA is rendered in its own section, from its own branch of the
 * response, below everything clinical and visually separated. It is never
 * interleaved with clinical fields and never used to sort, rank, filter or
 * badge anything. The server does not send a commercial URL to the list view
 * at all — only a count — so the list physically cannot rank by one.
 */

/** Renders a value that may legitimately be absent. Absent is a real answer. */
function Field({
  label,
  value,
  testId,
}: {
  label: string;
  value: string | null | undefined;
  testId?: string;
}) {
  const known = typeof value === "string" && value.trim() !== "";
  return (
    <div className="border-b border-line py-2 last:border-0">
      <dt className="text-[10.5px] font-bold uppercase tracking-wide text-subtle">
        {label}
      </dt>
      <dd
        data-testid={testId}
        className={cn(
          "mt-0.5 text-[12px]",
          known ? "text-ink" : "italic text-subtle",
        )}
      >
        {known ? value : "Unknown"}
      </dd>
    </div>
  );
}

export function ProductCatalogCenter() {
  const [data, setData] = useState<LiveProductCatalog | null>(null);
  const [detail, setDetail] = useState<LiveProductLabelDetail | null>(null);
  const [query, setQuery] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState("");
  const [notice, setNotice] = useState<string | null>(null);

  const load = useCallback(async (q: string) => {
    setBusy(true);
    setError(null);
    try {
      setData(await liveClient.productCatalog({ query: q || null }));
    } catch (e) {
      // Named, not swallowed. A catalog that silently renders empty when the
      // backend is down is indistinguishable from a catalog that is empty,
      // and the difference matters enormously.
      setData(null);
      setError(
        e instanceof Error
          ? e.message
          : "The product catalog could not be loaded.",
      );
    } finally {
      setBusy(false);
    }
  }, []);

  useEffect(() => {
    void load("");
  }, [load]);

  const openDetail = useCallback(async (labelVersionId: string) => {
    setError(null);
    setNotice(null);
    setNote("");
    try {
      setDetail(await liveClient.productLabelDetail({ labelVersionId }));
    } catch (e) {
      setDetail(null);
      setError(e instanceof Error ? e.message : "That label could not be read.");
    }
  }, []);

  const verify = useCallback(async () => {
    if (!detail || !note.trim()) return;
    setBusy(true);
    setError(null);
    try {
      await liveClient.verifyProductLabel({
        labelVersionId: detail.clinical.labelVersionId,
        verificationNote: note,
      });
      // Refresh BEFORE announcing: `openDetail` clears the notice, so setting
      // it first made the confirmation vanish the instant it appeared.
      await openDetail(detail.clinical.labelVersionId);
      await load(query);
      setNotice("Verification recorded against your name.");
    } catch (e) {
      setError(
        e instanceof Error ? e.message : "The verification was not recorded.",
      );
    } finally {
      setBusy(false);
    }
  }, [detail, note, openDetail, load, query]);

  return (
    <div data-testid="product-catalog" className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <div className="relative flex-1 min-w-[220px]">
          <Search
            size={13}
            aria-hidden
            className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-subtle"
          />
          <input
            data-testid="catalog-search"
            aria-label="Search the product catalog"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") void load(query);
            }}
            placeholder="Search by product, brand or code"
            className="h-9 w-full rounded border border-line bg-surface pl-8 pr-2 text-[12px]"
          />
        </div>
        <button
          data-testid="catalog-refresh"
          onClick={() => void load(query)}
          disabled={busy}
          className="inline-flex h-9 items-center gap-1.5 rounded border border-line px-3 text-[11.5px] font-bold disabled:opacity-50"
        >
          <RefreshCw size={13} aria-hidden /> Refresh
        </button>
      </div>

      {error ? (
        <p
          data-testid="catalog-error"
          role="alert"
          className="rounded border border-danger/25 bg-danger-tint p-3 text-[12px] text-danger"
        >
          {error}
        </p>
      ) : null}

      {/* Same reason as the template surface: a blank panel is not an answer. */}
      {!data && !error ? (
        <p
          data-testid="catalog-loading"
          role="status"
          className="rounded border border-line bg-sunken p-4 text-[12px] text-subtle"
        >
          Loading the product catalog…
        </p>
      ) : null}

      {data ? (
        <>
          <dl
            data-testid="catalog-counts"
            className="grid grid-cols-2 gap-2 sm:grid-cols-5"
          >
            {(
              [
                ["Total", data.clinical.counts.total, "count-total"],
                ["Verified", data.clinical.counts.verified, "count-verified"],
                [
                  "Unverified",
                  data.clinical.counts.unverified,
                  "count-unverified",
                ],
                ["Published", data.clinical.counts.published, "count-published"],
                ["Draft", data.clinical.counts.draft, "count-draft"],
              ] as const
            ).map(([label, value, tid]) => (
              <div
                key={tid}
                className="rounded border border-line bg-sunken px-2.5 py-2"
              >
                <dt className="text-[10px] font-bold uppercase tracking-wide text-subtle">
                  {label}
                </dt>
                <dd data-testid={tid} className="text-[15px] font-bold text-ink">
                  {value}
                </dd>
              </div>
            ))}
          </dl>

          {data.clinical.products.length === 0 ? (
            <div
              data-testid="catalog-empty"
              className="rounded border border-line bg-sunken p-4 text-[12px] text-subtle"
            >
              <p className="flex items-center gap-1.5 font-bold text-ink">
                <PackageSearch size={14} aria-hidden /> No governed products yet
              </p>
              {/* Verbatim from the database so a caller cannot soften it. */}
              <p className="mt-1.5">{data.emptyStateMessage}</p>
            </div>
          ) : (
            <ul data-testid="catalog-rows" className="space-y-1.5">
              {data.clinical.products.map((p) => (
                <li key={p.labelVersionId}>
                  <button
                    onClick={() => void openDetail(p.labelVersionId)}
                    className="flex w-full items-center gap-3 rounded border border-line bg-surface px-3 py-2 text-left hover:border-action"
                  >
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-[12.5px] font-bold text-ink">
                        {p.productName}
                      </span>
                      <span className="block truncate text-[11px] text-subtle">
                        {p.brand ?? "Unknown brand"} · {p.productCode} · v
                        {p.version}
                      </span>
                    </span>
                    <span
                      data-testid={`verification-${p.productCode}`}
                      className={cn(
                        "inline-flex items-center gap-1 rounded border px-1.5 py-0.5 text-[10.5px] font-bold",
                        p.verificationState === "verified"
                          ? "border-ok/25 bg-ok-tint text-ok"
                          : "border-warning/25 bg-warning-tint text-warning-deep",
                      )}
                    >
                      {p.verificationState === "verified" ? (
                        <BadgeCheck size={11} aria-hidden />
                      ) : (
                        <ShieldQuestion size={11} aria-hidden />
                      )}
                      {p.verificationState === "verified"
                        ? "Verified"
                        : "Not verified"}
                    </span>
                    {p.commercialLinkCount > 0 ? (
                      // A count, never a link. The list view is never sent a
                      // commercial URL, so it cannot rank or filter by one.
                      <span
                        data-testid={`commercial-count-${p.productCode}`}
                        className="inline-flex items-center gap-1 rounded border border-line px-1.5 py-0.5 text-[10.5px] text-subtle"
                      >
                        <Link2 size={11} aria-hidden />
                        {p.commercialLinkCount} commercial
                        {p.commercialDisclosureComplete ? "" : " · disclosure incomplete"}
                      </span>
                    ) : null}
                  </button>
                </li>
              ))}
            </ul>
          )}

          <section aria-labelledby="catalog-queue-heading">
            <h3
              id="catalog-queue-heading"
              className="mb-1.5 flex items-center gap-1.5 text-[11.5px] font-bold text-ink"
            >
              <FileClock size={13} aria-hidden /> Import review queue
            </h3>
            {data.reviewQueue.length === 0 ? (
              <p
                data-testid="catalog-queue-empty"
                className="rounded border border-line bg-sunken p-3 text-[12px] text-subtle"
              >
                Nothing is waiting for review.
              </p>
            ) : (
              <ul data-testid="catalog-queue" className="space-y-1.5">
                {data.reviewQueue.map((q) => (
                  <li
                    key={q.itemId}
                    className="rounded border border-warning/25 bg-warning-tint px-3 py-2 text-[12px]"
                  >
                    <span className="font-bold text-ink">{q.displayName}</span>
                    <span className="text-subtle"> · from {q.sourceName}</span>
                    {q.conflictReason ? (
                      <p className="mt-0.5 text-warning-deep">{q.conflictReason}</p>
                    ) : null}
                    {q.validationErrors.length ? (
                      <p className="mt-0.5 text-danger">
                        {q.validationErrors.join(" · ")}
                      </p>
                    ) : null}
                  </li>
                ))}
              </ul>
            )}
          </section>

          <p
            data-testid="catalog-commercial-policy"
            className="rounded border border-line bg-sunken p-3 text-[11.5px] text-subtle"
          >
            {data.commercialPolicy}
          </p>
        </>
      ) : null}

      {detail ? (
        <section
          data-testid="label-detail"
          aria-labelledby="label-detail-heading"
          className="rounded border border-line bg-surface p-4"
        >
          <div className="mb-2 flex items-start justify-between gap-3">
            <h3
              id="label-detail-heading"
              className="text-[13px] font-bold text-ink"
            >
              {detail.clinical.productName}
              <span className="ml-1.5 text-[11px] font-normal text-subtle">
                v{detail.clinical.version} · {detail.clinical.productCode}
              </span>
            </h3>
            <button
              data-testid="label-close"
              onClick={() => setDetail(null)}
              className="rounded border border-line px-2 py-1 text-[11px] font-bold"
            >
              Close
            </button>
          </div>

          {notice ? (
            <p
              data-testid="label-notice"
              role="status"
              className="mb-2 rounded border border-ok/25 bg-ok-tint p-2 text-[11.5px] text-ok"
            >
              {notice}
            </p>
          ) : null}

          <dl className="mb-3">
            <Field
              label="Brand"
              value={detail.clinical.brand}
              testId="label-brand"
            />
            <Field
              label="Serving size"
              value={detail.clinical.servingSize}
              testId="label-serving-size"
            />
            <Field
              label="Ingredients"
              value={detail.clinical.ingredients}
              testId="label-ingredients"
            />
            <Field
              label="Other ingredients"
              value={detail.clinical.otherIngredients}
              testId="label-other-ingredients"
            />
            <Field
              label="Allergens"
              value={detail.clinical.allergens}
              testId="label-allergens"
            />
            <Field
              label="Warnings"
              value={detail.clinical.warnings}
              testId="label-warnings"
            />
            <Field
              label="Directions"
              value={detail.clinical.directions}
              testId="label-directions"
            />
            <Field
              label="Storage"
              value={detail.clinical.storage}
              testId="label-storage"
            />
            <Field label="SKU" value={detail.clinical.sku} testId="label-sku" />
            <Field label="UPC" value={detail.clinical.upc} testId="label-upc" />
            <Field
              label="Label hash"
              value={detail.clinical.labelSha256}
              testId="label-hash"
            />
          </dl>

          <p
            data-testid="label-unknown-policy"
            className="mb-3 rounded border border-line bg-sunken p-2.5 text-[11.5px] text-subtle"
          >
            {detail.unknownPolicy}
          </p>

          <section aria-labelledby="label-versions-heading" className="mb-3">
            <h4
              id="label-versions-heading"
              className="mb-1 text-[11px] font-bold uppercase tracking-wide text-subtle"
            >
              Label versions
            </h4>
            <ul data-testid="label-versions" className="space-y-1">
              {detail.clinical.versions.map((v) => (
                <li
                  key={v.labelVersionId}
                  className="rounded border border-line px-2.5 py-1.5 text-[11.5px]"
                >
                  v{v.version} · {v.status} ·{" "}
                  {v.verifiedAt ? "verified" : "not verified"}
                </li>
              ))}
            </ul>
          </section>

          <section aria-labelledby="label-mappings-heading" className="mb-3">
            <h4
              id="label-mappings-heading"
              className="mb-1 text-[11px] font-bold uppercase tracking-wide text-subtle"
            >
              Catalog mappings
            </h4>
            {detail.clinical.catalogMappings.length === 0 ? (
              <p
                data-testid="label-mappings-empty"
                className="text-[11.5px] italic text-subtle"
              >
                Not mapped to a structured catalog product. Mapping happens on
                an exact SKU or UPC match only — never on a name, because two
                products can share one.
              </p>
            ) : (
              <ul data-testid="label-mappings" className="space-y-1">
                {detail.clinical.catalogMappings.map((m) => (
                  <li
                    key={m.productId}
                    className="rounded border border-line px-2.5 py-1.5 text-[11.5px]"
                  >
                    {m.name} · {m.sku ?? m.upc}
                  </li>
                ))}
              </ul>
            )}
          </section>

          <section aria-labelledby="label-imports-heading" className="mb-3">
            <h4
              id="label-imports-heading"
              className="mb-1 text-[11px] font-bold uppercase tracking-wide text-subtle"
            >
              Import history
            </h4>
            {detail.clinical.importHistory.length === 0 ? (
              <p
                data-testid="label-imports-empty"
                className="text-[11.5px] italic text-subtle"
              >
                No import wrote this row.
              </p>
            ) : (
              <ul data-testid="label-imports" className="space-y-1">
                {detail.clinical.importHistory.map((h) => (
                  <li
                    key={h.itemId}
                    className="rounded border border-line px-2.5 py-1.5 text-[11.5px]"
                  >
                    {h.sourceName}
                    {h.sourceFilename ? ` · ${h.sourceFilename}` : ""} ·{" "}
                    {h.changeKind ?? "unknown change"}
                  </li>
                ))}
              </ul>
            )}
          </section>

          <section aria-labelledby="label-verify-heading" className="mb-4">
            <h4
              id="label-verify-heading"
              className="mb-1 text-[11px] font-bold uppercase tracking-wide text-subtle"
            >
              Verification
            </h4>
            <p
              data-testid="label-verification-state"
              className="mb-1.5 text-[12px]"
            >
              {detail.clinical.verificationState === "verified"
                ? `Verified. ${detail.clinical.verificationNote ?? ""}`
                : "Not verified. Nobody has checked this label against the product."}
            </p>
            <label
              htmlFor="verify-note"
              className="block text-[11px] font-bold text-subtle"
            >
              What did you check?
            </label>
            <textarea
              id="verify-note"
              data-testid="verify-note"
              value={note}
              onChange={(e) => setNote(e.target.value)}
              rows={2}
              className="mt-1 w-full rounded border border-line bg-surface p-2 text-[12px]"
            />
            <button
              data-testid="verify-label"
              onClick={() => void verify()}
              disabled={busy || !note.trim()}
              className="mt-1.5 inline-flex h-8 items-center gap-1.5 rounded bg-action px-3 text-[11.5px] font-bold text-on-action disabled:opacity-50"
            >
              <BadgeCheck size={13} aria-hidden /> Record verification
            </button>
          </section>

          {/*
            COMMERCIAL, in its own region, below everything clinical, from its
            own branch of the response. Nothing above reads from it.
          */}
          <section
            data-testid="label-commercial"
            aria-labelledby="label-commercial-heading"
            className="rounded border border-line bg-sunken p-3"
          >
            <h4
              id="label-commercial-heading"
              className="mb-1 flex items-center gap-1.5 text-[11px] font-bold uppercase tracking-wide text-subtle"
            >
              <Link2 size={12} aria-hidden /> Commercial — separate from
              clinical data
            </h4>
            <p
              data-testid="label-commercial-notice"
              className="mb-2 text-[11.5px] text-subtle"
            >
              {detail.commercial.notice}
            </p>
            {detail.commercial.links.length === 0 ? (
              <p
                data-testid="label-commercial-empty"
                className="text-[11.5px] italic text-subtle"
              >
                No commercial links recorded.
              </p>
            ) : (
              <ul data-testid="label-commercial-links" className="space-y-1">
                {detail.commercial.links.map((l) => (
                  <li
                    key={l.id}
                    className="rounded border border-line bg-surface px-2.5 py-1.5 text-[11.5px]"
                  >
                    <span className="font-bold text-ink">{l.kind}</span>
                    {l.supplierName ? ` · ${l.supplierName}` : ""}
                    {l.revokedAt ? " · revoked" : ""}
                    <p className="mt-0.5 text-subtle">
                      {l.commissionDisclosure ?? "No disclosure recorded."}
                    </p>
                  </li>
                ))}
              </ul>
            )}
            {!detail.commercial.disclosureComplete ? (
              <p
                data-testid="label-disclosure-incomplete"
                role="alert"
                className="mt-2 flex items-start gap-1.5 rounded border border-warning/25 bg-warning-tint p-2 text-[11.5px] text-warning-deep"
              >
                <AlertTriangle size={13} aria-hidden className="mt-px shrink-0" />
                An affiliate link here has no completed disclosure. It must not
                be shown to a patient until the disclosure is written.
              </p>
            ) : null}
          </section>
        </section>
      ) : null}
    </div>
  );
}
