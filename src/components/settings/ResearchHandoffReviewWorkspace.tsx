"use client";

import { useState } from "react";
import { Card } from "@/components/ui/bits";
import { deriveAuditedSample } from "@/lib/prh-audited-sample";

/**
 * Phase 9E-B — bounded practitioner review of the independently-audited
 * sample.
 *
 * The audited set is derived from the package manifest the practitioner
 * re-selects here, and the manifest is only trusted after its SHA-256
 * matches the value stamped on the preview batches. One record card per
 * audited id; one decision control per record; no bulk action exists on
 * this surface. A verdict is recorded through the governed RPC and the
 * item's status stays 'needs_review' — nothing is applied, activated,
 * attached, committed, or approved from here.
 */

type ReviewData = {
  batches: Array<{
    id: string;
    sourceName: string;
    status: string;
    itemCount: number;
    commercialOnly: boolean;
    manifestSha256: string | null;
  }>;
  records: Array<{
    id: string;
    externalKey: string;
    displayName: string;
    status: string;
    verdict: "verified" | "blocked" | null;
    reviewNote: string | null;
    reviewedAt: string | null;
    warnings: string[];
    payload: Record<string, unknown>;
  }>;
  evidence: Array<{
    id: string;
    externalKey: string;
    productResearchId: string | null;
    payload: Record<string, unknown>;
  }>;
  commercial: Array<{ id: string; externalKey: string; payload: Record<string, unknown> }>;
  boundary: string;
};

async function sha256Hex(bytes: ArrayBuffer): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export function ResearchHandoffReviewWorkspace() {
  const [phase, setPhase] = useState<"idle" | "loading" | "ready" | "failed">("idle");
  const [error, setError] = useState<string | null>(null);
  const [auditedIds, setAuditedIds] = useState<string[]>([]);
  const [manifestSha, setManifestSha] = useState<string | null>(null);
  const [data, setData] = useState<ReviewData | null>(null);

  const loadFromManifest = async (file: File) => {
    setPhase("loading");
    setError(null);
    try {
      const bytes = await file.arrayBuffer();
      const sha = await sha256Hex(bytes);
      let manifest: unknown;
      try {
        manifest = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
      } catch {
        throw new Error("manifest_not_valid_json");
      }
      const derived = deriveAuditedSample(manifest);
      if (!derived.ok) throw new Error(derived.reason);

      const res = await fetch("/api/live/knowledge/research-handoff-review", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ prhIds: derived.auditedIds }),
      });
      const text = await res.text();
      if (!res.ok) {
        let category = "review_load_failed";
        try {
          const parsed = JSON.parse(text);
          category = parsed?.error?.message ?? parsed?.message ?? category;
        } catch { /* keep default */ }
        throw new Error(category);
      }
      const envelope = JSON.parse(text) as { data?: ReviewData };
      const loaded = envelope.data;
      if (!loaded || !Array.isArray(loaded.records)) throw new Error("unexpected_response_shape");

      // The manifest is only trusted when its hash matches what the
      // preview batches were stamped with. A mismatch is a hard stop.
      const stamped = loaded.batches.map((b) => b.manifestSha256).filter(Boolean);
      if (stamped.length === 0 || !stamped.every((s) => s === sha)) {
        throw new Error("manifest_sha_does_not_match_preview_batches");
      }

      setAuditedIds(derived.auditedIds);
      setManifestSha(sha);
      setData(loaded);
      setPhase("ready");
    } catch (e) {
      setError(e instanceof Error ? e.message : "review_load_failed");
      setPhase("failed");
    }
  };

  const refresh = async () => {
    if (auditedIds.length === 0) return;
    const res = await fetch("/api/live/knowledge/research-handoff-review", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ prhIds: auditedIds }),
    });
    if (!res.ok) return;
    const envelope = (await res.json()) as { data?: ReviewData };
    if (envelope.data) setData(envelope.data);
  };

  return (
    <div className="mt-3 flex flex-col gap-3" data-testid="prh-review-workspace">
      <Card className="px-4 py-3">
        <h2 className="m-0 text-[14.5px] font-bold text-ink">
          Bounded review — independently audited sample
        </h2>
        <p className="mt-1 text-[11.5px] leading-[1.55] text-subtle">
          Re-select <code>handoff-manifest.json</code>. The audited record set is derived from the
          manifest&apos;s declared corrections, and the manifest is only trusted after its SHA-256
          matches the hash stamped on the preview batches. Verdicts recorded here are practitioner
          claims on research records — every item stays <code>needs_review</code>, and nothing is
          applied, activated, attached, committed, or approved from this surface.
        </p>
        <input
          id="prh-review-manifest"
          type="file"
          accept=".json,application/json"
          className="mt-2 text-[11.5px]"
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) void loadFromManifest(f);
          }}
        />
        {phase === "loading" && (
          <p className="mt-2 text-[11.5px] text-subtle">Verifying the manifest and loading the audited sample…</p>
        )}
        {phase === "failed" && (
          <div
            data-testid="prh-review-failed"
            role="alert"
            className="mt-2 rounded border border-critical/25 bg-critical-tint px-3 py-2 text-[11.5px] text-critical-deep"
          >
            {error ?? "review_load_failed"}
          </div>
        )}
        {phase === "ready" && data && (
          <p className="mt-2 text-[11.5px] text-body" data-testid="prh-review-loaded">
            Manifest verified (<code>{manifestSha?.slice(0, 12)}…</code>). Audited sample:{" "}
            <strong>{auditedIds.length} records</strong>. {data.boundary}
          </p>
        )}
      </Card>

      {phase === "ready" && data && auditedIds.map((prhId) => {
        const record = data.records.find((r) => r.externalKey === prhId);
        return (
          <RecordCard
            key={prhId}
            prhId={prhId}
            record={record}
            evidence={data.evidence.filter((e) => e.productResearchId === prhId)}
            commercial={data.commercial.filter((c) => c.externalKey === prhId)}
            onRecorded={refresh}
          />
        );
      })}
    </div>
  );
}

/* ------------------------------------------------------------ record card */

function asList(v: unknown): string[] {
  return Array.isArray(v) ? v.map((x) => String(x)) : [];
}
function asText(v: unknown): string | null {
  return typeof v === "string" && v.trim().length > 0 ? v : null;
}

function Dim({ label, children, tone }: {
  label: string;
  children: React.ReactNode;
  tone?: "warn" | "ok";
}) {
  return (
    <div className="mt-2">
      <div className={
        "text-[10.5px] font-bold uppercase tracking-[0.04em] "
        + (tone === "warn" ? "text-critical-deep" : tone === "ok" ? "text-ok-deep" : "text-subtle")
      }>
        {label}
      </div>
      <div className="mt-0.5 text-[11.5px] leading-[1.55] text-body">{children}</div>
    </div>
  );
}

function RecordCard({ prhId, record, evidence, commercial, onRecorded }: {
  prhId: string;
  record: ReviewData["records"][number] | undefined;
  evidence: ReviewData["evidence"];
  commercial: ReviewData["commercial"];
  onRecorded: () => Promise<void>;
}) {
  const [note, setNote] = useState("");
  const [submitting, setSubmitting] = useState<"verified" | "blocked" | null>(null);
  const [decisionError, setDecisionError] = useState<string | null>(null);

  if (!record) {
    return (
      <Card className="px-4 py-3" data-testid={`prh-record-${prhId}`}>
        <h3 className="m-0 text-[13px] font-bold text-critical-deep">{prhId} — not found in the clinical preview batch</h3>
        <p className="mt-1 text-[11.5px] text-subtle">
          The manifest names this record but the preview batch does not contain it. It stays blocked.
        </p>
      </Card>
    );
  }

  const p = record.payload;
  const identifiers =
    p.identifiers && typeof p.identifiers === "object" && !Array.isArray(p.identifiers)
      ? Object.entries(p.identifiers as Record<string, unknown>)
          .filter(([, v]) => typeof v === "string" && (v as string).length > 0)
      : [];
  const missing = asList(p.missing_fields);
  const conflicts = asList(p.conflicting_fields);
  const restrictions = asList(p.restriction_flags);
  const archived = evidence.filter((e) => e.payload.sha256 !== null && e.payload.sha256 !== undefined);
  const decide = async (verdict: "verified" | "blocked") => {
    setSubmitting(verdict);
    setDecisionError(null);
    try {
      const res = await fetch("/api/live/knowledge/research-handoff-decision", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ itemId: record.id, verdict, note }),
      });
      const text = await res.text();
      if (!res.ok) {
        let category = "decision_failed";
        try {
          const parsed = JSON.parse(text);
          category = parsed?.error?.message ?? parsed?.message ?? category;
        } catch { /* keep default */ }
        throw new Error(category);
      }
      setNote("");
      await onRecorded();
    } catch (e) {
      setDecisionError(e instanceof Error ? e.message : "decision_failed");
    } finally {
      setSubmitting(null);
    }
  };

  return (
    <Card className="px-4 py-3" data-testid={`prh-record-${prhId}`}>
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h3 className="m-0 text-[13px] font-bold text-ink">
          {prhId} — {record.displayName}
        </h3>
        <span
          data-testid={`prh-record-${prhId}-verdict`}
          className={
            "rounded border px-2 py-0.5 text-[10.5px] font-semibold "
            + (record.verdict === "verified"
              ? "border-ok/25 bg-ok-tint text-ok-deep"
              : record.verdict === "blocked"
              ? "border-critical/25 bg-critical-tint text-critical-deep"
              : "border-line bg-card text-subtle")
          }
        >
          {record.verdict === "verified"
            ? "Practitioner recorded: verified"
            : record.verdict === "blocked"
            ? "Practitioner recorded: blocked"
            : "No verdict recorded — blocked by default"}
        </span>
      </div>

      <Dim label="Identity evidence">
        Confidence: <strong>{asText(p.identity_confidence) ?? "Unknown"}</strong>
        {" · "}source authority tier: {asText(String(p.source_authority_tier ?? "")) ?? "Unknown"}
        <br />
        Source row: {asText(p.original_product_name) ?? "Unknown"} ({asText(p.original_brand) ?? "Unknown"})
        {" → "}official: {asText(p.official_product_name) ?? "Unknown"} — {asText(p.official_manufacturer) ?? "Unknown"}
        <br />
        {asText(p.identity_basis) ?? "No identity basis recorded."}
      </Dim>

      <Dim label="Strong identifiers" tone={identifiers.length ? undefined : "warn"}>
        {identifiers.length
          ? identifiers.map(([k, v]) => <span key={k} className="mr-3"><code>{k}</code>: <code>{String(v)}</code></span>)
          : "None recorded."}
      </Dim>

      <Dim label="Label completeness">
        Supplement Facts complete: <strong>{p.supplement_facts_complete === true ? "yes" : "no"}</strong>
        {" · "}ingredient amounts partial: {p.ingredient_amounts_partial === true ? "yes" : "no"}
        {" · "}serving size: {asText(p.serving_size) ?? "Unknown"}
        {" · "}regulatory classification: {asText(p.regulatory_classification) ?? "Unknown"}
      </Dim>

      <Dim label="Evidence (archived vs URL-only)" tone={archived.length === 0 ? "warn" : undefined}>
        {evidence.length} evidence source{evidence.length === 1 ? "" : "s"};{" "}
        <strong>{archived.length} archived</strong>, {evidence.length - archived.length} URL-only (unarchived).
        {evidence.length > 0 && (
          <ul className="mt-1 mb-0 pl-4">
            {evidence.map((e) => (
              <li key={e.id}>
                <code>{asText(e.payload.source_id) ?? e.externalKey}</code>{" "}
                {asText(e.payload.domain) ?? asText(e.payload.url) ?? "Unknown"}
                {" — "}{e.payload.sha256 == null ? "URL-only, unarchived" : "archived"}
                {asText(e.payload.source_type) ? ` · ${asText(e.payload.source_type)}` : ""}
              </li>
            ))}
          </ul>
        )}
      </Dim>

      <Dim label="Missing physical-label fields" tone={missing.length ? "warn" : "ok"}>
        {missing.length ? missing.join(", ") : "None recorded as missing."}
      </Dim>

      <Dim label="Conflicts" tone={conflicts.length ? "warn" : "ok"}>
        {conflicts.length ? conflicts.join("; ") : "No conflicting fields recorded."}
      </Dim>

      <Dim label="Restrictions" tone={restrictions.length ? "warn" : "ok"}>
        {restrictions.length ? restrictions.join(", ") : "No restriction flags."}
      </Dim>

      <Dim label="Discontinued status">
        Discontinued flag: {p.discontinued_flag === true ? "yes" : p.discontinued_flag === false ? "no" : "Unknown"}
        {asText(p.discontinued_status) ? ` · ${asText(p.discontinued_status)}` : ""}
        {asText(p.availability_note) ? <><br />Availability: {asText(p.availability_note)}</> : null}
      </Dim>

      {asText(p.reviewer_notes) && (
        <Dim label="Researcher / verifier notes">{asText(p.reviewer_notes)}</Dim>
      )}

      <div
        className="mt-3 rounded border border-line bg-panel px-3 py-2"
        data-testid={`prh-record-${prhId}-commercial`}
      >
        <div className="text-[10.5px] font-bold uppercase tracking-[0.04em] text-subtle">
          Commercial data — separate, commercial-only namespace
        </div>
        <div className="mt-0.5 text-[11.5px] text-body">
          {commercial.length === 0
            ? "No commercial link in the package for this record."
            : commercial.map((c) => (
                <div key={c.id}>
                  {asText(c.payload.affiliate_url) ?? asText(c.payload.commercial_url) ?? "Link recorded"}
                </div>
              ))}
          <div className="mt-0.5 text-[10.5px] text-subtle">
            Never entered into clinical search, ranking, safety, protocols, retrieval, or recommendations.
          </div>
        </div>
      </div>

      <div className="mt-3 border-t border-line pt-2">
        {record.reviewNote && (
          <p className="mt-0 mb-1 text-[11px] text-subtle">
            Last recorded note ({record.reviewedAt ?? "Unknown time"}): {record.reviewNote}
          </p>
        )}
        <label htmlFor={`prh-note-${prhId}`} className="text-[11px] font-semibold text-ink">
          Review note (required, 10+ characters)
        </label>
        <textarea
          id={`prh-note-${prhId}`}
          data-testid={`prh-record-${prhId}-note`}
          value={note}
          onChange={(e) => setNote(e.target.value)}
          rows={2}
          className="mt-1 w-full rounded border border-line bg-card px-2 py-1 text-[11.5px] text-body"
        />
        <div className="mt-1.5 flex flex-wrap items-center gap-2">
          <button
            type="button"
            data-testid={`prh-record-${prhId}-record-verified`}
            disabled={note.trim().length < 10 || submitting !== null}
            onClick={() => void decide("verified")}
            className={
              "h-8 rounded-lg px-3 text-[12px] font-semibold "
              + (note.trim().length >= 10 && submitting === null
                ? "bg-action text-white hover:bg-action-strong"
                : "border border-line bg-card text-faint")
            }
          >
            {submitting === "verified" ? "Recording…" : "Record verdict: verified"}
          </button>
          <button
            type="button"
            data-testid={`prh-record-${prhId}-record-blocked`}
            disabled={note.trim().length < 10 || submitting !== null}
            onClick={() => void decide("blocked")}
            className={
              "h-8 rounded-lg border px-3 text-[12px] font-semibold "
              + (note.trim().length >= 10 && submitting === null
                ? "border-critical/40 bg-critical-tint text-critical-deep hover:border-critical"
                : "border-line bg-card text-faint")
            }
          >
            {submitting === "blocked" ? "Recording…" : "Record verdict: blocked"}
          </button>
          <span className="text-[10.5px] text-subtle">
            One record, one decision. Status stays needs_review either way.
          </span>
        </div>
        {decisionError && (
          <div role="alert" className="mt-1.5 text-[11px] text-critical-deep">{decisionError}</div>
        )}
      </div>
    </Card>
  );
}
