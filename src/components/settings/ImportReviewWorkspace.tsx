"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ShieldAlert } from "lucide-react";
import { liveClient } from "@/adapters/live-client";
import { AdapterError } from "@/adapters/errors";
import type {
  LiveCatalogReviewQueue,
  LiveImportProvenanceHistory,
  LiveImportSourceInventory,
  LiveKnowledgeImportItem,
  LiveKnowledgeImportPreview,
  LiveParsedImportEnvelope,
} from "@/adapters/live-types";
import { Card, CardTitle } from "@/components/ui/bits";
import { Btn } from "@/components/ui/Btn";
import { TableWrap, TD, TH } from "@/components/ui/Table";
import { Field, Select, TextInput } from "@/components/ui/Field";
import { ClinicalError, ClinicalLoading, ClinicalNote } from "@/components/ui/ClinicalStates";
import { cn } from "@/lib/cn";

/**
 * The Import Review Workspace.
 *
 * THE SCREEN'S ONE JOB: make every refusal the database will raise visible
 * BEFORE the reviewer commits, with the evidence beside it. A gate the
 * reviewer only meets at commit time teaches them to click through gates.
 *
 * THREE STATES THAT ARE NEVER CONFLATED, on every panel:
 *
 *   * LOADING — we do not know yet.
 *   * EMPTY — we asked, and the answer is nothing. "No files declared" is a
 *     statement about the inventory.
 *   * FAILED — we could not ask. Nobody is in a position to say the inventory
 *     is empty, and the screen must not imply otherwise.
 *
 * PERMISSION DENIED is its own case rather than a generic failure, because
 * "you are not a knowledge editor here" and "the service is down" call for
 * completely different actions from the person reading it.
 */

/**
 * Phase 9E-A section identifiers. Nine tabs; five deliver working
 * governance surfaces, three are placeholders that state precisely
 * what remains, one ("parse") stays as the file-reading entry point.
 */
type Tab =
  | "overview"
  | "sources"
  | "parse"
  | "batches"
  | "conflicts"
  | "restricted"
  | "warnings"
  | "labels"
  | "references"
  | "commercial"
  | "provenance";

function errText(e: unknown): string {
  return e instanceof AdapterError ? e.message : "Something went wrong. Try again.";
}

function isDenied(e: unknown): boolean {
  return e instanceof AdapterError && (e.code === "forbidden" || e.code === "unauthenticated");
}

/** A failed panel. Denial is separated from failure — they are different facts. */
function PanelError({ error, onRetry }: { error: unknown; onRetry: () => void }) {
  if (isDenied(error)) {
    return (
      <Card className="px-6 py-10">
        <div className="flex flex-col items-center gap-2 text-center" role="alert">
          <ShieldAlert size={20} className="text-warning-deep" aria-hidden />
          <h2 className="m-0 text-[15px] font-bold">You do not have access to this</h2>
          <p className="m-0 max-w-[440px] text-[12.5px] leading-[1.5] text-subtle">
            Importing and reviewing clinical knowledge needs a knowledge-editor role in this
            organization. Nothing is missing and nothing is broken — this account cannot see it.
            Ask an owner or admin to change your role.
          </p>
        </div>
      </Card>
    );
  }
  return <ClinicalError message={errText(error)} onRetry={onRetry} />;
}

function Chip({ tone, children }: { tone: "warn" | "danger" | "ok" | "muted"; children: React.ReactNode }) {
  const cls = {
    warn: "border-warning/25 bg-warning-tint text-warning-deep",
    danger: "border-danger/25 bg-danger-tint text-danger",
    ok: "border-ok/25 bg-ok-tint text-ok",
    muted: "border-line bg-sunken text-subtle",
  }[tone];
  return (
    <span className={cn("inline-flex items-center rounded-full border px-2 py-[1px] text-[11px] font-semibold", cls)}>
      {children}
    </span>
  );
}

/* ------------------------------------------------------------- sources */

function SourcesPanel() {
  const [state, setState] = useState<"loading" | "ready" | "error">("loading");
  const [error, setError] = useState<unknown>(null);
  const [data, setData] = useState<LiveImportSourceInventory | null>(null);
  const [name, setName] = useState("");
  const [availability, setAvailability] = useState<"available" | "unavailable">("unavailable");
  const [reason, setReason] = useState("");
  const [digest, setDigest] = useState("");
  const [message, setMessage] = useState("");

  const load = useCallback(async () => {
    setState("loading");
    try {
      setData(await liveClient.importSourceInventory());
      setState("ready");
    } catch (e) {
      setError(e);
      setState("error");
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const declare = async () => {
    setMessage("");
    // Refused here as well as in the database. Not duplication for its own
    // sake: the database's refusal arrives as an opaque constraint violation
    // (this boundary does not pass database messages through), so without a
    // local check the operator would be told "invalid" and left guessing. The
    // constraint remains the backstop; this is the sentence they can act on.
    const declared = name.trim();
    if (
      declared.includes("/")
      || declared.includes("\\")
      || /^[A-Za-z]:/.test(declared)
      || declared.startsWith("~")
    ) {
      setMessage(
        "Record the file by NAME, never by path. Where the practitioner keeps their "
          + "clinical material is not this system's business and must not end up in a "
          + "database that gets dumped, replicated or supported.",
      );
      return;
    }
    try {
      await liveClient.recordImportSourceFile({
        declaredName: name.trim(),
        availability,
        contentSha256: availability === "available" ? digest.trim() : null,
        byteSize: availability === "available" ? 0 : null,
        unavailableReason: availability === "unavailable" ? reason.trim() : null,
      });
      setName("");
      setReason("");
      setDigest("");
      await load();
    } catch (e) {
      setMessage(errText(e));
    }
  };

  if (state === "loading") return <ClinicalLoading label="Reading the source inventory…" />;
  if (state === "error") return <PanelError error={error} onRetry={load} />;

  return (
    <div className="flex flex-col gap-4">
      <ClinicalNote>
        Declaring a file records <strong>what was looked for</strong>, including files that could
        not be read. An inventory with nothing in it is not the same as an import that found
        nothing — and this list is the difference between those two sentences.
      </ClinicalNote>

      <Card>
        <CardTitle>Declare a source file</CardTitle>
        <div className="grid grid-cols-1 gap-3 md:grid-cols-3">
          <Field label="File name (not a path)">
            <TextInput
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="products.xlsx"
              data-testid="source-name"
            />
          </Field>
          <Field label="Availability">
            <Select
              value={availability}
              onChange={(e) => setAvailability(e.target.value as "available" | "unavailable")}
              data-testid="source-availability"
            >
              <option value="unavailable">Not available to read</option>
              <option value="available">Available and hashed</option>
            </Select>
          </Field>
          {availability === "available" ? (
            <Field label="sha256 digest">
              <TextInput
                value={digest}
                onChange={(e) => setDigest(e.target.value)}
                placeholder="64 hex characters"
                data-testid="source-digest"
              />
            </Field>
          ) : (
            <Field label="Why it could not be read">
              <TextInput
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                placeholder='"Not found" and "withheld" are different facts'
                data-testid="source-reason"
              />
            </Field>
          )}
        </div>
        <div className="mt-3 flex items-center gap-3">
          <Btn onClick={declare} disabled={!name.trim()} data-testid="declare-source">
            Record this file
          </Btn>
          {message && (
            <p className="m-0 text-[12px] text-danger" role="alert" data-testid="source-error">
              {message}
            </p>
          )}
        </div>
      </Card>

      <Card>
        <CardTitle>
          Declared files · {data?.counts.declared ?? 0} ({data?.counts.available ?? 0} read,{" "}
          {data?.counts.unavailable ?? 0} not read)
        </CardTitle>
        {data && data.files.length === 0 ? (
          <p className="m-0 text-[12.5px] text-subtle" data-testid="sources-empty">
            {data.emptyStateMessage}
          </p>
        ) : (
          <TableWrap>
            <thead>
              <tr>
                <TH>File</TH>
                <TH>Availability</TH>
                <TH>Digest</TH>
                <TH>Batches</TH>
              </tr>
            </thead>
            <tbody>
              {data?.files.map((f) => (
                <tr key={f.id} data-testid="source-row">
                  <TD>{f.declaredName}</TD>
                  <TD>
                    {f.availability === "available" ? (
                      <Chip tone="ok">Read</Chip>
                    ) : (
                      <span className="flex flex-col gap-[2px]">
                        <Chip tone="warn">Not read</Chip>
                        <span className="text-[11.5px] text-subtle">{f.unavailableReason}</span>
                      </span>
                    )}
                  </TD>
                  <TD className="font-mono text-[11px]">
                    {f.contentSha256 ? `${f.contentSha256.slice(0, 12)}…` : "Unknown"}
                  </TD>
                  <TD>{f.batchCount}</TD>
                </tr>
              ))}
            </tbody>
          </TableWrap>
        )}
      </Card>
    </div>
  );
}

/* --------------------------------------------------------------- parse */

function ParsePanel({ onStaged }: { onStaged: (batchId: string) => void }) {
  const fileRef = useRef<HTMLInputElement>(null);
  const [kind, setKind] = useState<"product_spreadsheet" | "protocol_document">(
    "product_spreadsheet",
  );
  const [envelope, setEnvelope] = useState<LiveParsedImportEnvelope | null>(null);
  const [attested, setAttested] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");

  const parse = async () => {
    const file = fileRef.current?.files?.[0];
    if (!file) return;
    setBusy(true);
    setMessage("");
    setEnvelope(null);
    setAttested(false);
    try {
      setEnvelope(await liveClient.knowledgeImportParse({ file, sourceKind: kind }));
    } catch (e) {
      setMessage(errText(e));
    } finally {
      setBusy(false);
    }
  };

  const stage = async () => {
    if (!envelope) return;
    setBusy(true);
    setMessage("");
    try {
      const result = await liveClient.knowledgeImportPreview({
        sourceKind: envelope.sourceKind,
        sourceName: envelope.sourceName,
        schemaVersion: envelope.schemaVersion,
        items: envelope.items,
        attestsNoPhi: true,
        sourceFilename: envelope.sourceFilename,
        sourceByteSize: envelope.sourceByteSize,
      });
      onStaged(result.batchId);
    } catch (e) {
      setMessage(errText(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex flex-col gap-4">
      <ClinicalNote>
        The file is read <strong>in this process and nowhere else</strong>. Formulas are never
        calculated, macros and embedded objects are refused outright, and links out of the document
        are discarded. Nothing is written by parsing — staging is the separate step below.
      </ClinicalNote>

      <Card>
        <CardTitle>Read a file</CardTitle>
        <div className="flex flex-wrap items-end gap-3">
          <Field label="What kind of file is this?">
            <Select
              value={kind}
              onChange={(e) =>
                setKind(e.target.value as "product_spreadsheet" | "protocol_document")
              }
              data-testid="parse-kind"
            >
              <option value="product_spreadsheet">Product spreadsheet (.xlsx)</option>
              <option value="protocol_document">Protocol document (.docx)</option>
            </Select>
          </Field>
          <input
            ref={fileRef}
            type="file"
            accept=".xlsx,.docx"
            aria-label="Source file"
            data-testid="parse-file"
            className="text-[12.5px]"
          />
          <Btn onClick={parse} disabled={busy} data-testid="parse-run">
            {busy ? "Reading…" : "Read the file"}
          </Btn>
        </div>
        {message && (
          <p className="m-0 mt-3 text-[12.5px] text-danger" role="alert" data-testid="parse-error">
            {message}
          </p>
        )}
      </Card>

      {envelope && (
        <Card>
          <CardTitle>
            {envelope.sourceFilename} · {envelope.report.itemCount} row(s) read
          </CardTitle>
          <dl className="grid grid-cols-2 gap-2 text-[12px] md:grid-cols-4">
            <div>
              <dt className="text-subtle">Digest</dt>
              <dd className="m-0 font-mono text-[11px]" data-testid="parse-digest">
                {envelope.sourceSha256.slice(0, 16)}…
              </dd>
            </div>
            <div>
              <dt className="text-subtle">Sheets / sections</dt>
              <dd className="m-0">{envelope.report.sheetsRead.join(", ") || "Unknown"}</dd>
            </div>
            <div>
              <dt className="text-subtle">Uncalculated formulas</dt>
              <dd className="m-0" data-testid="parse-uncached">
                {envelope.report.uncachedFormulaCells}
              </dd>
            </div>
            <div>
              <dt className="text-subtle">Field codes discarded</dt>
              <dd className="m-0" data-testid="parse-fieldcodes">
                {envelope.report.discardedFieldCodes}
              </dd>
            </div>
          </dl>

          {envelope.report.notices.length > 0 && (
            <ul className="mt-3 flex list-none flex-col gap-2 p-0" data-testid="parse-notices">
              {envelope.report.notices.map((n) => (
                <li key={n} className="text-[12px] leading-[1.5] text-warning-deep">
                  {n}
                </li>
              ))}
            </ul>
          )}

          {envelope.report.skippedRows.length > 0 && (
            <div className="mt-3" data-testid="parse-skipped">
              <p className="m-0 mb-1 text-[12px] font-semibold">
                {envelope.report.skippedRows.length} row(s) were not read
              </p>
              <ul className="m-0 flex list-none flex-col gap-1 p-0">
                {envelope.report.skippedRows.map((r) => (
                  <li key={`${r.sheet}:${r.rowNumber}`} className="text-[11.5px] text-subtle">
                    {r.sheet} row {r.rowNumber}: {r.why}
                  </li>
                ))}
              </ul>
            </div>
          )}

          <label className="mt-4 flex items-start gap-2 text-[12.5px]">
            <input
              type="checkbox"
              checked={attested}
              onChange={(e) => setAttested(e.target.checked)}
              data-testid="parse-attest"
            />
            <span>
              I confirm this file contains <strong>no patient-identifiable information</strong>.
              This is a statement I am making, not a box the importer ticked.
            </span>
          </label>
          <div className="mt-3">
            <Btn
              onClick={stage}
              disabled={!attested || busy || envelope.items.length === 0}
              data-testid="parse-stage"
            >
              Stage for review
            </Btn>
          </div>
        </Card>
      )}
    </div>
  );
}

/* -------------------------------------------------------------- review */

function ItemRow({
  item,
  onResolve,
}: {
  item: LiveKnowledgeImportItem;
  onResolve: (item: LiveKnowledgeImportItem) => void;
}) {
  const missing = item.missingFacts ?? [];
  const flags = item.restrictedFlags ?? [];
  const diffs = item.fieldDiffs ?? [];

  return (
    <tr data-testid="review-item">
      <TD>
        <span className="font-semibold">{item.displayName}</span>
        <span className="block text-[11px] text-subtle">
          {item.sourceSheet ?? "—"} row {item.sourceRowNumber ?? "—"}
        </span>
      </TD>
      <TD>
        {item.changeKind === "ambiguous" ? (
          <Chip tone="danger">Ambiguous</Chip>
        ) : item.changeKind === "conflict" ? (
          <Chip tone="danger">Conflict</Chip>
        ) : item.changeKind === "change" ? (
          <Chip tone="warn">Change</Chip>
        ) : item.changeKind === "unchanged" ? (
          <Chip tone="muted">Unchanged</Chip>
        ) : (
          <Chip tone="ok">New</Chip>
        )}
      </TD>
      <TD>
        {flags.length === 0 ? (
          <span className="text-[11.5px] text-subtle">None declared</span>
        ) : (
          <span className="flex flex-wrap gap-1" data-testid="item-restricted">
            {flags.map((f) => (
              <Chip key={f} tone="danger">
                {f}
              </Chip>
            ))}
          </span>
        )}
      </TD>
      <TD>
        {missing.length === 0 ? (
          <span className="text-[11.5px] text-subtle">—</span>
        ) : (
          <span className="text-[11.5px] text-warning-deep" data-testid="item-missing">
            {missing.join(", ")}
          </span>
        )}
      </TD>
      <TD>
        {diffs.length > 0 && (
          <ul className="m-0 flex list-none flex-col gap-[2px] p-0" data-testid="item-diffs">
            {diffs.map((d) => (
              <li key={d.field} className="text-[11px]">
                <span className="font-semibold">{d.field}</span>{" "}
                <span className="text-subtle line-through">{d.current ?? "Unknown"}</span>{" "}
                <span aria-hidden>→</span> <span>{d.incoming ?? "Unknown"}</span>
              </li>
            ))}
          </ul>
        )}
        {item.changeKind === "ambiguous" && (
          <div data-testid="item-candidates">
            <p className="m-0 text-[11.5px] text-danger">{item.conflictReason}</p>
            <Btn
              variant="ghost"
              onClick={() => onResolve(item)}
              data-testid="resolve-ambiguity"
              className="mt-1"
            >
              Resolve
            </Btn>
          </div>
        )}
        {item.validationErrors.length > 0 && (
          <ul className="m-0 flex list-none flex-col p-0" data-testid="item-errors">
            {item.validationErrors.map((e) => (
              <li key={e} className="text-[11.5px] text-danger">
                {e}
              </li>
            ))}
          </ul>
        )}
      </TD>
    </tr>
  );
}

function ReviewPanel({ batchId }: { batchId: string | null }) {
  const [state, setState] = useState<"idle" | "loading" | "ready" | "error">("idle");
  const [error, setError] = useState<unknown>(null);
  const [preview, setPreview] = useState<LiveKnowledgeImportPreview | null>(null);
  const [resolving, setResolving] = useState<LiveKnowledgeImportItem | null>(null);
  const [resolution, setResolution] = useState<"new_product" | "same_as_existing" | "skip">(
    "new_product",
  );
  const [candidateId, setCandidateId] = useState("");
  const [note, setNote] = useState("");
  const [message, setMessage] = useState("");

  const load = useCallback(async () => {
    if (!batchId) return;
    setState("loading");
    try {
      setPreview(await liveClient.knowledgeImportDetail(batchId));
      setState("ready");
    } catch (e) {
      setError(e);
      setState("error");
    }
  }, [batchId]);

  useEffect(() => {
    void load();
  }, [load]);

  const submitResolution = async () => {
    if (!resolving) return;
    setMessage("");
    try {
      await liveClient.knowledgeImportResolveAmbiguity({
        itemId: resolving.id,
        resolution,
        note: note.trim(),
        existingProductId: resolution === "same_as_existing" ? candidateId : null,
      });
      setResolving(null);
      setNote("");
      setCandidateId("");
      await load();
    } catch (e) {
      setMessage(errText(e));
    }
  };

  const commit = async () => {
    if (!preview) return;
    setMessage("");
    try {
      const result = await liveClient.knowledgeImportCommit({
        batchId: preview.batch.id,
        expectedCounts: { added: preview.batch.added, changed: preview.batch.changed },
        note: "Committed from the import review workspace",
      });
      setMessage(result.message);
      await load();
    } catch (e) {
      setMessage(errText(e));
    }
  };

  if (!batchId) {
    return (
      <Card className="px-6 py-10">
        <p className="m-0 text-center text-[12.5px] text-subtle" data-testid="review-none">
          No batch is open. Read a file on the previous tab and stage it, or open a batch from the
          import history.
        </p>
      </Card>
    );
  }
  if (state === "loading" || state === "idle") return <ClinicalLoading label="Reading the staged batch…" />;
  if (state === "error") return <PanelError error={error} onRetry={load} />;
  if (!preview) return null;

  const b = preview.batch;
  const blocked = (b.ambiguous ?? 0) > 0 || b.conflicts > 0;

  return (
    <div className="flex flex-col gap-4">
      <Card>
        <CardTitle>
          {b.sourceName} · {b.itemCount} row(s) staged
        </CardTitle>
        <div className="flex flex-wrap gap-2" data-testid="batch-counts">
          <Chip tone="ok">{b.added} new</Chip>
          <Chip tone="warn">{b.changed} changed</Chip>
          <Chip tone="muted">{b.unchanged} unchanged</Chip>
          <Chip tone="danger">{b.conflicts} conflict</Chip>
          <Chip tone="danger">{b.ambiguous ?? 0} ambiguous</Chip>
          <Chip tone="danger">{b.restricted ?? 0} restricted</Chip>
        </div>
        <ClinicalNote className="mt-3">
          Nothing here has been written. Everything this batch applies enters as a{" "}
          <strong>non-approved draft</strong>, and an imported product is not selectable in the
          protocol picker until its review is completed separately.
        </ClinicalNote>
        <div className="mt-3 flex items-center gap-3">
          <Btn onClick={commit} disabled={blocked || b.status === "committed"} data-testid="commit-batch">
            Commit this batch
          </Btn>
          {blocked && (
            <p className="m-0 text-[12px] text-danger" data-testid="commit-blocked">
              {b.conflicts > 0 && `${b.conflicts} conflict(s) `}
              {(b.ambiguous ?? 0) > 0 && `${b.ambiguous} ambiguous row(s) `}
              must be resolved before this batch can be committed.
            </p>
          )}
          {message && (
            <p className="m-0 text-[12px] text-subtle" role="status" data-testid="commit-message">
              {message}
            </p>
          )}
        </div>
      </Card>

      <Card>
        <CardTitle>Rows</CardTitle>
        <TableWrap>
          <thead>
            <tr>
              <TH>Row</TH>
              <TH>Change</TH>
              <TH>Restricted</TH>
              <TH>Missing facts</TH>
              <TH>What needs a decision</TH>
            </tr>
          </thead>
          <tbody>
            {preview.items.map((item) => (
              <ItemRow key={item.id} item={item} onResolve={setResolving} />
            ))}
          </tbody>
        </TableWrap>
      </Card>

      {resolving && (
        <Card data-testid="ambiguity-dialog">
          <CardTitle>Resolve: {resolving.displayName}</CardTitle>
          <p className="m-0 mb-3 text-[12px] text-subtle">{resolving.conflictReason}</p>
          <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
            <Field label="What is this row?">
              <Select
                value={resolution}
                onChange={(e) =>
                  setResolution(e.target.value as "new_product" | "same_as_existing" | "skip")
                }
                data-testid="ambiguity-resolution"
              >
                <option value="new_product">A genuinely new product</option>
                <option value="same_as_existing">The same as an existing product</option>
                <option value="skip">Do not apply this row</option>
              </Select>
            </Field>
            {resolution === "same_as_existing" && (
              <Field label="Which existing product?">
                <Select
                  value={candidateId}
                  onChange={(e) => setCandidateId(e.target.value)}
                  data-testid="ambiguity-candidate"
                >
                  <option value="">Choose one…</option>
                  {(resolving.candidateMatches ?? []).map((c) => (
                    <option key={c.productId} value={c.productId}>
                      {c.name} — {c.brand ?? "Unknown brand"} ({c.sku ?? "no SKU"}) · {c.why}
                    </option>
                  ))}
                </Select>
              </Field>
            )}
          </div>
          <Field label="Why — this is recorded against the decision">
            <TextInput
              value={note}
              onChange={(e) => setNote(e.target.value)}
              data-testid="ambiguity-note"
            />
          </Field>
          <div className="mt-3 flex items-center gap-3">
            <Btn onClick={submitResolution} disabled={!note.trim()} data-testid="ambiguity-submit">
              Record this decision
            </Btn>
            <Btn variant="ghost" onClick={() => setResolving(null)}>
              Cancel
            </Btn>
            {message && (
              <p className="m-0 text-[12px] text-danger" role="alert" data-testid="ambiguity-error">
                {message}
              </p>
            )}
          </div>
        </Card>
      )}
    </div>
  );
}

/* ---------------------------------------------------------- provenance */

function ProvenancePanel() {
  const [state, setState] = useState<"loading" | "ready" | "error">("loading");
  const [error, setError] = useState<unknown>(null);
  const [data, setData] = useState<LiveImportProvenanceHistory | null>(null);

  const load = useCallback(async () => {
    setState("loading");
    try {
      setData(await liveClient.importProvenance({ limit: 100 }));
      setState("ready");
    } catch (e) {
      setError(e);
      setState("error");
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  if (state === "loading") return <ClinicalLoading label="Reading the provenance history…" />;
  if (state === "error") return <PanelError error={error} onRetry={load} />;

  return (
    <div className="flex flex-col gap-4">
      <ClinicalNote>
        This history is <strong>append-only</strong>. A record of where content came from that
        could be edited would answer the question with whatever the last writer preferred, which is
        worse than not recording it — it would look like evidence.
      </ClinicalNote>

      <Card>
        <CardTitle>Imported records · {data?.total ?? 0}</CardTitle>
        {data && data.records.length === 0 ? (
          <p className="m-0 text-[12.5px] text-subtle" data-testid="provenance-empty">
            {data.emptyStateMessage}
          </p>
        ) : (
          <TableWrap>
            <thead>
              <tr>
                <TH>Record</TH>
                <TH>From</TH>
                <TH>Source values</TH>
                <TH>Missing facts</TH>
              </tr>
            </thead>
            <tbody>
              {data?.records.map((r) => (
                <tr key={r.id} data-testid="provenance-row">
                  <TD>
                    <span className="font-mono text-[11px]">{r.refType}</span>
                    <span className="block text-[11px] text-subtle">
                      {r.payloadSha256.slice(0, 12)}…
                    </span>
                  </TD>
                  <TD className="text-[11.5px]">
                    {r.sourceFileName ?? "Unknown file"}
                    <span className="block text-subtle">
                      {r.sourceSheet ?? "—"} row {r.sourceRowNumber ?? "—"}
                    </span>
                  </TD>
                  <TD className="max-w-[360px] text-[11px]" data-testid="provenance-raw">
                    {Object.entries(r.rawValues).length === 0 ? (
                      <span className="text-subtle">No verbatim row was recorded.</span>
                    ) : (
                      Object.entries(r.rawValues)
                        .map(([k, v]) => `${k}: ${String(v)}`)
                        .join(" · ")
                    )}
                  </TD>
                  <TD className="text-[11.5px]">
                    {r.missingFacts.length === 0 ? "—" : r.missingFacts.join(", ")}
                  </TD>
                </tr>
              ))}
            </tbody>
          </TableWrap>
        )}
      </Card>
    </div>
  );
}

/* ------------------------------------------------------------- shell */

/* ==================================================================
 * PHASE 9E-A.1 — NEW GOVERNANCE PANELS
 * ==================================================================
 *
 * OverviewPanel — composite counts + workflow-stage pointer.
 * BatchesPanel  — list preview / cancelled batches for the org.
 * ConflictsPanel — all ordinary conflicts across all preview batches,
 *                  with side-by-side rows, field-level diff, and the
 *                  three governed decisions (keep_existing /
 *                  take_incoming / skip), each demanding a reason.
 * RestrictedReviewPanel — 5-outcome restricted review with per-item
 *                  history, category filters, and jurisdiction input
 *                  when the outcome demands it.
 * ComingIn9EA2Panel — a clearly-labelled placeholder for the three
 *                  deferred sections (Product labels, Knowledge
 *                  references, Commercial matching). It states
 *                  exactly what is missing and where the work will
 *                  land. No dead buttons.
 */

/* ------------------------------------------------------------- overview */

function OverviewPanel({
  onNavigate,
}: {
  onNavigate: (t: Tab) => void;
}) {
  const [state, setState] = useState<"loading" | "ready" | "error">("loading");
  const [error, setError] = useState<unknown>(null);
  const [inv, setInv] = useState<LiveImportSourceInventory | null>(null);
  const [catalogQueue, setCatalogQueue] = useState<LiveCatalogReviewQueue | null>(null);
  const [restrictedQueue, setRestrictedQueue] = useState<{
    counts: { total: number; previewItems: number; products: number; knowledgeReferences: number };
  } | null>(null);

  const load = useCallback(async () => {
    setState("loading");
    try {
      const [i, cq, rq] = await Promise.all([
        liveClient.importSourceInventory(),
        liveClient.catalogReviewQueue(),
        liveClient.restrictedReviewQueue(),
      ]);
      setInv(i);
      setCatalogQueue(cq);
      setRestrictedQueue(rq);
      setState("ready");
    } catch (e) {
      setError(e);
      setState("error");
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  if (state === "loading") return <ClinicalLoading label="Reading the import inventory…" />;
  if (state === "error") return <PanelError error={error} onRetry={load} />;

  const declared = inv?.files.length ?? 0;
  const available = (inv?.files ?? []).filter((f) => f.availability === "available").length;
  const restrictedCount = restrictedQueue?.counts.total ?? 0;
  const restrictedPreview = restrictedQueue?.counts.previewItems ?? 0;
  const restrictedProducts = restrictedQueue?.counts.products ?? 0;
  const notSelectable = catalogQueue?.counts?.notSelectable ?? 0;

  // The workflow pointer: preview → resolve conflicts → commit as draft →
  // complete missing facts → restriction/evidence review → label
  // verification → clinical approval → selectable. The pointer highlights
  // the earliest stage that has outstanding work.
  const stages = [
    {
      key: "sources" as Tab,
      label: "Declare source files",
      done: declared > 0,
      todo: declared === 0 ? "No files declared yet." : null,
      go: () => onNavigate("sources"),
    },
    {
      key: "parse" as Tab,
      label: "Stage a batch (preview)",
      done: declared > 0 && available > 0,
      todo:
        available === 0 && declared > 0
          ? "Read an available file into a preview batch."
          : declared === 0
            ? null
            : null,
      go: () => onNavigate("parse"),
    },
    {
      key: "conflicts" as Tab,
      label: "Resolve conflicts",
      done: false,
      todo: "Open the Conflicts tab to walk any batch-level collisions.",
      go: () => onNavigate("conflicts"),
    },
    {
      key: "restricted" as Tab,
      label: "Restricted review",
      done: false,
      todo:
        restrictedCount > 0
          ? `${restrictedCount} restricted product(s) waiting for a decision.`
          : "No restricted rows in the current queue.",
      go: () => onNavigate("restricted"),
    },
    {
      key: "labels" as Tab,
      label: "Complete missing product facts (label editor)",
      done: false,
      todo:
        notSelectable > 0
          ? `${notSelectable} product(s) not yet selectable. The label editor arrives in Phase 9E-A.2.`
          : "The label editor arrives in Phase 9E-A.2.",
      go: () => onNavigate("labels"),
    },
  ];

  return (
    <div className="flex flex-col gap-4">
      <Card>
        <CardTitle>Where the workspace is</CardTitle>
        <div className="grid gap-2 md:grid-cols-3">
          <div data-testid="ov-counts-declared">
            <div className="text-[11px] uppercase tracking-wide text-subtle">Source files declared</div>
            <div className="text-[22px] font-bold">{declared}</div>
            <div className="text-[11px] text-subtle">{available} available on the operator&rsquo;s system.</div>
          </div>
          <div data-testid="ov-counts-restricted">
            <div className="text-[11px] uppercase tracking-wide text-subtle">Restricted subjects in queue</div>
            <div className="text-[22px] font-bold">{restrictedCount}</div>
            <div className="text-[11px] text-subtle">
              {restrictedPreview} preview candidate(s) + {restrictedProducts} catalog product(s). Each needs a
              governed decision.
            </div>
          </div>
          <div data-testid="ov-counts-not-selectable">
            <div className="text-[11px] uppercase tracking-wide text-subtle">Not-yet-selectable products</div>
            <div className="text-[22px] font-bold">{notSelectable}</div>
            <div className="text-[11px] text-subtle">
              Not selectable until the missing product facts are entered from an official label.
            </div>
          </div>
        </div>
      </Card>

      <Card>
        <CardTitle>The mandatory workflow</CardTitle>
        <ClinicalNote className="mb-3">
          preview &rarr; resolve conflicts &rarr; commit as draft &rarr; complete missing facts
          &rarr; restriction/evidence review &rarr; label verification &rarr; clinical approval
          &rarr; selectable. Nothing skips a stage.
        </ClinicalNote>
        <ul className="flex flex-col gap-2" data-testid="ov-stages">
          {stages.map((s, idx) => (
            <li
              key={s.label}
              className="flex items-center justify-between rounded border border-line bg-card px-3 py-2"
              data-testid={`ov-stage-${idx + 1}`}
            >
              <div className="flex flex-col">
                <span className="text-[12.5px] font-semibold">
                  {idx + 1}. {s.label}
                </span>
                {s.todo && <span className="text-[11.5px] text-subtle">{s.todo}</span>}
              </div>
              {s.go && (
                <Btn variant="ghost" onClick={s.go} data-testid={`ov-goto-${s.key}`}>
                  Go &rarr;
                </Btn>
              )}
            </li>
          ))}
        </ul>
      </Card>
    </div>
  );
}

/* --------------------------------------------------------------- conflicts */

/**
 * Field-level diff between an "existing" row and an "incoming" row.
 * `existing` is the row already in the batch (or the state at import
 * time); `incoming` is the row that raised the conflict. This surfaces
 * every field, marking the ones that differ.
 */
function DiffRows({
  existing,
  incoming,
}: {
  existing: LiveKnowledgeImportItem | null;
  incoming: LiveKnowledgeImportItem;
}) {
  const rows: Array<{ label: string; a: string; b: string; differs: boolean }> = [];
  const push = (label: string, a: unknown, b: unknown) => {
    const av = a == null ? "" : String(a);
    const bv = b == null ? "" : String(b);
    rows.push({ label, a: av, b: bv, differs: av !== bv });
  };
  push("Display name", existing?.displayName, incoming.displayName);
  push("Entity type", existing?.entityType, incoming.entityType);
  push("Change kind", existing?.changeKind, incoming.changeKind);
  push("Restricted flags", (existing?.restrictedFlags ?? []).join(","), (incoming.restrictedFlags ?? []).join(","));
  push("Missing facts", (existing?.missingFacts ?? []).join(","), (incoming.missingFacts ?? []).join(","));
  push("Warnings", (existing?.warnings ?? []).join(" | "), (incoming.warnings ?? []).join(" | "));
  return (
    <TableWrap>
      <thead>
        <tr>
          <TH>Field</TH>
          <TH>Existing row</TH>
          <TH>Incoming row</TH>
        </tr>
      </thead>
      <tbody>
        {rows.map((r) => (
          <tr key={r.label} className={r.differs ? "bg-warning-tint/40" : ""}>
            <TD>
              <strong>{r.label}</strong>
              {r.differs && (
                <span className="ml-2 text-[10.5px] font-bold uppercase tracking-wide text-warning-deep">
                  differs
                </span>
              )}
            </TD>
            <TD>{r.a || <span className="text-subtle">Unknown</span>}</TD>
            <TD>{r.b || <span className="text-subtle">Unknown</span>}</TD>
          </tr>
        ))}
      </tbody>
    </TableWrap>
  );
}

function ConflictsPanel({ batchId }: { batchId: string | null }) {
  const [state, setState] = useState<"idle" | "loading" | "ready" | "error">("idle");
  const [error, setError] = useState<unknown>(null);
  const [preview, setPreview] = useState<LiveKnowledgeImportPreview | null>(null);
  const [resolving, setResolving] = useState<LiveKnowledgeImportItem | null>(null);
  const [resolution, setResolution] = useState<"keep_existing" | "take_incoming" | "skip">(
    "keep_existing",
  );
  const [note, setNote] = useState("");
  const [message, setMessage] = useState("");
  const [confirm, setConfirm] = useState(false);

  const load = useCallback(async () => {
    if (!batchId) return;
    setState("loading");
    try {
      setPreview(await liveClient.knowledgeImportDetail(batchId));
      setState("ready");
    } catch (e) {
      setError(e);
      setState("error");
    }
  }, [batchId]);

  useEffect(() => {
    void load();
  }, [load]);

  if (!batchId) {
    return (
      <Card className="px-6 py-10">
        <p className="m-0 text-center text-[12.5px] text-subtle" data-testid="conflicts-no-batch">
          No batch is open. Read a file on the &ldquo;Read a file&rdquo; tab and stage it,
          or open a batch on the &ldquo;Preview batches&rdquo; tab.
        </p>
      </Card>
    );
  }
  if (state === "loading" || state === "idle") return <ClinicalLoading label="Reading the batch…" />;
  if (state === "error") return <PanelError error={error} onRetry={load} />;

  // A row is "an unresolved conflict" iff the classifier flagged it AND no
  // reviewer has recorded a decision yet. Rows carrying keep_existing / skip
  // land here with changeKind still "conflict" but conflictResolution set —
  // those must not reappear in the workflow queue after reload.
  const conflicts = (preview?.items ?? []).filter(
    (i) => i.changeKind === "conflict" && i.conflictResolution == null,
  );

  const submit = async () => {
    if (!resolving) return;
    setMessage("");
    try {
      await liveClient.knowledgeImportResolveConflict({
        itemId: resolving.id,
        resolution,
        note: note.trim(),
      });
      setResolving(null);
      setResolution("keep_existing");
      setNote("");
      setConfirm(false);
      await load();
    } catch (e) {
      setMessage(errText(e));
    }
  };

  return (
    <div className="flex flex-col gap-4">
      <Card>
        <CardTitle>Conflicts in this batch</CardTitle>
        <p className="m-0 text-[12px] text-subtle">
          Ordinary conflicts: two rows in the same batch stake a claim on the same identity.
          Pick the answer that carries the correct clinical fact. Every decision demands a
          reason and is audit-logged. Restrictions on either row are preserved on every
          outcome; no downgrading happens here.
        </p>
      </Card>

      <Card>
        <CardTitle>
          {conflicts.length} conflict(s) in {preview?.batch.sourceName ?? "this batch"}
        </CardTitle>
        {conflicts.length === 0 ? (
          <p className="m-0 text-center text-[12px] text-subtle" data-testid="conflicts-empty">
            No conflicts in this batch.
          </p>
        ) : (
          <ul className="flex flex-col gap-2" data-testid="conflicts-list">
            {conflicts.map((c) => (
              <li
                key={c.id}
                className="rounded border border-line px-3 py-2"
                data-testid={`conflict-item-${c.id}`}
              >
                <div className="flex items-center justify-between gap-2">
                  <div>
                    <strong className="text-[13px]">{c.displayName}</strong>
                    <div className="text-[11.5px] text-subtle">
                      {c.entityType} · source row {c.sourceRowNumber ?? "?"} in{" "}
                      {c.sourceSheet ?? "unknown sheet"}
                    </div>
                  </div>
                  <Btn onClick={() => setResolving(c)} data-testid={`conflict-open-${c.id}`}>
                    Resolve
                  </Btn>
                </div>
              </li>
            ))}
          </ul>
        )}
      </Card>

      {resolving && (
        <Card data-testid="conflict-dialog">
          <CardTitle>Resolve: {resolving.displayName}</CardTitle>
          <p className="m-0 mb-3 text-[12px] text-subtle">
            {resolving.conflictReason ?? "This row conflicts with another row in the same batch."}
          </p>
          <DiffRows
            existing={
              (preview?.items ?? []).find(
                (i) => i.id === resolving.conflictWithItemId,
              ) ?? null
            }
            incoming={resolving}
          />
          <div className="mt-3 flex flex-col gap-3 md:flex-row md:items-end">
            <Field label="Decision">
              <Select
                value={resolution}
                onChange={(e) =>
                  setResolution(e.target.value as "keep_existing" | "take_incoming" | "skip")
                }
                data-testid="conflict-resolution"
              >
                <option value="keep_existing">Keep the existing row (the earlier one wins)</option>
                <option value="take_incoming">Use the incoming row (supersedes the earlier one)</option>
                <option value="skip">Skip the incoming row (neither is applied)</option>
              </Select>
            </Field>
            <Field label="Why — recorded against the decision" className="flex-1">
              <TextInput
                value={note}
                onChange={(e) => setNote(e.target.value)}
                data-testid="conflict-note"
              />
            </Field>
          </div>
          {!confirm && (
            <div className="mt-3 flex items-center gap-3">
              <Btn
                onClick={() => setConfirm(true)}
                disabled={!note.trim()}
                data-testid="conflict-review"
              >
                Review this decision
              </Btn>
              <Btn variant="ghost" onClick={() => setResolving(null)}>
                Cancel
              </Btn>
            </div>
          )}
          {confirm && (
            <div
              className="mt-3 rounded border border-warning/25 bg-warning-tint px-3 py-2"
              data-testid="conflict-confirm"
            >
              <p className="m-0 text-[12px] text-warning-deep">
                About to record: <strong>{resolution}</strong> on{" "}
                <strong>{resolving.displayName}</strong>. Restrictions on either row are
                preserved. This action is audit-logged and cannot be edited later.
              </p>
              <div className="mt-2 flex items-center gap-2">
                <Btn onClick={submit} data-testid="conflict-submit">
                  Record this decision
                </Btn>
                <Btn variant="ghost" onClick={() => setConfirm(false)}>
                  Back
                </Btn>
              </div>
            </div>
          )}
          {message && (
            <p
              className="mt-3 text-[12px] text-danger"
              role="alert"
              data-testid="conflict-error"
            >
              {message}
            </p>
          )}
        </Card>
      )}
    </div>
  );
}

/* -------------------------------------------------------- restricted review */

const RESTRICTED_OUTCOMES: Array<{
  id:
    | "retain_restricted"
    | "request_evidence"
    | "defer"
    | "reject"
    | "clinician_reviewed_for_jurisdiction";
  label: string;
  description: string;
}> = [
  {
    id: "retain_restricted",
    label: "Retain restricted",
    description: "Looked at it; the flag stays.",
  },
  {
    id: "request_evidence",
    label: "Request evidence",
    description: "Need a citation before deciding.",
  },
  {
    id: "defer",
    label: "Defer",
    description: "Not ready to decide today.",
  },
  {
    id: "reject",
    label: "Reject",
    description: "This row will not be used.",
  },
  {
    id: "clinician_reviewed_for_jurisdiction",
    label: "Clinician-reviewed for jurisdiction",
    description: "Requires a stated jurisdiction. This is NOT approval.",
  },
];

/**
 * Category filters mirror the restriction taxonomy Phase 9D uses across
 * the pipeline: vaccine-related, peptide, prescription, IV therapy, device,
 * jurisdictional, suspected-restricted. A row can match more than one.
 */
const RESTRICTED_CATEGORIES: Array<{ id: string; label: string; match: RegExp }> = [
  { id: "vaccine_related", label: "Vaccine-related", match: /vaccine|mrna|spike/i },
  { id: "peptide", label: "Peptide", match: /peptide/i },
  { id: "prescription", label: "Prescription", match: /prescription|controlled|schedule/i },
  { id: "iv_therapy", label: "IV therapy", match: /iv|intravenous|infusion|injection/i },
  { id: "device", label: "Device", match: /device|hyperbaric|hbot|pemf|photobiomodulation/i },
  { id: "jurisdictional", label: "Jurisdictional", match: /jurisdiction|not for sale|fda|mhra|tga/i },
  { id: "suspected_restricted", label: "Suspected", match: /suspected_restricted/i },
];

type SubjectType = "product" | "preview_item" | "knowledge_reference";

type RestrictedItem = {
  subjectType: SubjectType;
  subjectId: string;
  displayName: string;
  entityType: string;
  restrictedFlags: string[];
  missingFacts: string[];
  changeKind: string | null;
  status: string;
  sourceName: string | null;
  sourceSheet: string | null;
  sourceRowNumber: number | null;
  currentOutcome: string | null;
};

const SUBJECT_LABELS: Record<SubjectType, string> = {
  preview_item: "Preview candidate",
  product: "Catalog product",
  knowledge_reference: "Governed knowledge reference",
};

/**
 * Preview-item vs governed-product vs knowledge-reference — the label the
 * reviewer sees is the type name, so they know which state the subject is
 * in and whether their decision commits, publishes, or only records
 * against a preview candidate.
 */
function subjectSubtypeLabel(item: RestrictedItem): string {
  if (item.subjectType === "preview_item") {
    if (item.entityType === "knowledge_reference") return "Preview knowledge reference";
    return "Preview product candidate";
  }
  return SUBJECT_LABELS[item.subjectType];
}

function RestrictedReviewPanel() {
  const [state, setState] = useState<"loading" | "ready" | "error">("loading");
  const [error, setError] = useState<unknown>(null);
  const [queue, setQueue] = useState<{
    items: RestrictedItem[];
    counts: {
      total: number;
      previewItems: number;
      products: number;
      knowledgeReferences: number;
    };
  } | null>(null);
  const [category, setCategory] = useState<string>("all");
  const [subjectFilter, setSubjectFilter] = useState<"all" | SubjectType>("all");
  const [openItem, setOpenItem] = useState<RestrictedItem | null>(null);
  const [outcome, setOutcome] = useState<
    | "retain_restricted"
    | "request_evidence"
    | "defer"
    | "reject"
    | "clinician_reviewed_for_jurisdiction"
  >("retain_restricted");
  const [reason, setReason] = useState("");
  const [jurisdiction, setJurisdiction] = useState("");
  const [history, setHistory] = useState<{
    subjectType: SubjectType;
    subjectId: string;
    currentOutcome: string | null;
    history: Array<{
      id: string;
      outcome: string;
      reason: string;
      jurisdiction: string | null;
      decidedBy: string;
      decidedAt: string;
    }>;
  } | null>(null);
  const [message, setMessage] = useState("");

  const load = useCallback(async () => {
    setState("loading");
    try {
      setQueue(await liveClient.restrictedReviewQueue());
      setState("ready");
    } catch (e) {
      setError(e);
      setState("error");
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const loadHistory = useCallback(async (item: RestrictedItem) => {
    try {
      const h = await liveClient.restrictedReviewHistory({
        subjectType: item.subjectType,
        subjectId: item.subjectId,
      });
      setHistory(h);
    } catch {
      setHistory({
        subjectType: item.subjectType,
        subjectId: item.subjectId,
        currentOutcome: null,
        history: [],
      });
    }
  }, []);

  const openDecision = useCallback(
    async (item: RestrictedItem) => {
      setOpenItem(item);
      setHistory(null);
      setOutcome("retain_restricted");
      setReason("");
      setJurisdiction("");
      setMessage("");
      await loadHistory(item);
    },
    [loadHistory],
  );

  if (state === "loading") return <ClinicalLoading label="Reading the restricted queue…" />;
  if (state === "error") return <PanelError error={error} onRetry={load} />;

  const items = queue?.items ?? [];
  const filteredBySubject =
    subjectFilter === "all" ? items : items.filter((i) => i.subjectType === subjectFilter);
  const filtered = filteredBySubject.filter((i) => {
    if (category === "all") return true;
    const cat = RESTRICTED_CATEGORIES.find((c) => c.id === category);
    if (!cat) return true;
    return (i.restrictedFlags ?? []).some((f) => cat.match.test(f));
  });

  const submit = async () => {
    if (!openItem) return;
    setMessage("");
    try {
      const result = await liveClient.restrictedReviewRecord({
        subjectType: openItem.subjectType,
        subjectId: openItem.subjectId,
        outcome,
        reason: reason.trim(),
        jurisdiction: outcome === "clinician_reviewed_for_jurisdiction" ? jurisdiction.trim() : null,
      });
      const subjectLabel = subjectSubtypeLabel(openItem);
      const commitNote =
        openItem.subjectType === "preview_item"
          ? " This decision does not commit, publish, or make this preview row selectable — commit is a separate governed action."
          : "";
      setMessage(
        `Recorded ${result.outcome}. Restrictions preserved on this ${subjectLabel.toLowerCase()}; clearance is a separate action.${commitNote}`,
      );
      await loadHistory(openItem);
      await load();
    } catch (e) {
      setMessage(errText(e));
    }
  };

  return (
    <div className="flex flex-col gap-4">
      <Card>
        <CardTitle>Restricted review</CardTitle>
        <p className="m-0 text-[12px] text-subtle">
          {queue?.counts.total ?? 0} restricted subjects across three domains — preview
          candidates ({queue?.counts.previewItems ?? 0}), catalog products (
          {queue?.counts.products ?? 0}), and governed knowledge references (
          {queue?.counts.knowledgeReferences ?? 0}). Five governed outcomes; each
          demands a reason. The clinician-for-jurisdiction outcome additionally demands a
          stated jurisdiction.{" "}
          <strong>None of the five outcomes clears the restriction, commits a preview, publishes a reference, or attaches a commercial link.</strong>{" "}
          Clearance, commit, publish, and attach stay separate governed actions.
        </p>
        <div className="mt-3 flex flex-wrap gap-2" data-testid="restricted-subject-filters">
          {(
            [
              { id: "all", label: `All (${queue?.counts.total ?? 0})` },
              { id: "preview_item", label: `Preview candidates (${queue?.counts.previewItems ?? 0})` },
              { id: "product", label: `Catalog products (${queue?.counts.products ?? 0})` },
              {
                id: "knowledge_reference",
                label: `Knowledge references (${queue?.counts.knowledgeReferences ?? 0})`,
              },
            ] as Array<{ id: "all" | SubjectType; label: string }>
          ).map((f) => (
            <button
              key={f.id}
              type="button"
              className={cn(
                "rounded-full border px-3 py-1 text-[11.5px] font-semibold",
                subjectFilter === f.id
                  ? "border-action bg-action/10 text-action"
                  : "border-line bg-card text-body",
              )}
              onClick={() => setSubjectFilter(f.id)}
              data-testid={`restricted-subject-${f.id}`}
            >
              {f.label}
            </button>
          ))}
        </div>
        <div className="mt-2 flex flex-wrap gap-2" data-testid="restricted-filters">
          <button
            type="button"
            className={cn(
              "rounded-full border px-3 py-1 text-[11.5px] font-semibold",
              category === "all"
                ? "border-action bg-action/10 text-action"
                : "border-line bg-card text-body",
            )}
            onClick={() => setCategory("all")}
            data-testid="restricted-filter-all"
          >
            All categories ({filteredBySubject.length})
          </button>
          {RESTRICTED_CATEGORIES.map((c) => {
            const count = filteredBySubject.filter((i) =>
              (i.restrictedFlags ?? []).some((f) => c.match.test(f)),
            ).length;
            return (
              <button
                key={c.id}
                type="button"
                className={cn(
                  "rounded-full border px-3 py-1 text-[11.5px] font-semibold",
                  category === c.id
                    ? "border-action bg-action/10 text-action"
                    : "border-line bg-card text-body",
                )}
                onClick={() => setCategory(c.id)}
                data-testid={`restricted-filter-${c.id}`}
                disabled={count === 0}
              >
                {c.label} ({count})
              </button>
            );
          })}
        </div>
      </Card>

      <Card>
        <CardTitle>
          {filtered.length} restricted subject(s)
          {category !== "all" && ` in ${RESTRICTED_CATEGORIES.find((c) => c.id === category)?.label}`}
        </CardTitle>
        {filtered.length === 0 ? (
          <p
            className="m-0 text-center text-[12px] text-subtle"
            data-testid="restricted-empty"
          >
            No restricted subjects match this filter.
          </p>
        ) : (
          <ul className="flex flex-col gap-2" data-testid="restricted-list">
            {filtered.map((i) => (
              <li
                key={`${i.subjectType}:${i.subjectId}`}
                className="flex items-center justify-between rounded border border-line px-3 py-2"
                data-testid={`restricted-item-${i.subjectType}-${i.subjectId}`}
              >
                <div>
                  <div className="flex items-center gap-2">
                    <span
                      className={cn(
                        "rounded border px-2 py-[1px] text-[10.5px] font-bold uppercase tracking-wide",
                        i.subjectType === "preview_item"
                          ? "border-warning/25 bg-warning-tint text-warning-deep"
                          : "border-line bg-sunken text-subtle",
                      )}
                      data-testid={`restricted-item-type-${i.subjectType}`}
                    >
                      {subjectSubtypeLabel(i)}
                    </span>
                    <strong className="text-[13px]">{i.displayName}</strong>
                    {i.currentOutcome && (
                      <Chip tone="muted">Last decision: {i.currentOutcome}</Chip>
                    )}
                  </div>
                  <div className="mt-1 text-[11.5px] text-subtle">
                    {(i.restrictedFlags ?? []).map((f) => (
                      <Chip key={f} tone="danger">
                        {f}
                      </Chip>
                    ))}
                    {(i.missingFacts ?? []).length > 0 && (
                      <span className="ml-2">
                        Missing: {(i.missingFacts ?? []).join(", ")}
                      </span>
                    )}
                    {i.sourceName && (
                      <span className="ml-2">
                        Source: {i.sourceName}
                        {i.sourceSheet ? ` · ${i.sourceSheet}` : ""}
                        {i.sourceRowNumber != null ? ` · row ${i.sourceRowNumber}` : ""}
                      </span>
                    )}
                  </div>
                </div>
                <Btn
                  variant="ghost"
                  onClick={() => openDecision(i)}
                  data-testid={`restricted-open-${i.subjectType}-${i.subjectId}`}
                >
                  Decide
                </Btn>
              </li>
            ))}
          </ul>
        )}
      </Card>

      {openItem && (
        <Card data-testid="restricted-dialog">
          <CardTitle>
            Decide — {subjectSubtypeLabel(openItem)}: {openItem.displayName}
          </CardTitle>
          {openItem.subjectType === "preview_item" && (
            <div
              className="mb-3 rounded border border-warning/25 bg-warning-tint px-3 py-2 text-[11.5px] text-warning-deep"
              data-testid="restricted-preview-note"
              role="note"
            >
              This is a <strong>preview candidate</strong>, not a committed record. Recording an
              outcome here writes only to the append-only decision log — it does <strong>not</strong>{" "}
              commit the row, publish it, or make it selectable. Restriction flags carry
              forward to the committed record if commit later happens.
            </div>
          )}
          <div className="grid gap-3 md:grid-cols-2">
            <Field label="Outcome">
              <Select
                value={outcome}
                onChange={(e) =>
                  setOutcome(
                    e.target.value as
                      | "retain_restricted"
                      | "request_evidence"
                      | "defer"
                      | "reject"
                      | "clinician_reviewed_for_jurisdiction",
                  )
                }
                data-testid="restricted-outcome"
              >
                {RESTRICTED_OUTCOMES.map((o) => (
                  <option key={o.id} value={o.id}>
                    {o.label}
                  </option>
                ))}
              </Select>
            </Field>
            {outcome === "clinician_reviewed_for_jurisdiction" && (
              <Field label="Jurisdiction (required for this outcome)">
                <TextInput
                  value={jurisdiction}
                  onChange={(e) => setJurisdiction(e.target.value)}
                  placeholder="e.g., US-CA"
                  data-testid="restricted-jurisdiction"
                />
              </Field>
            )}
          </div>
          <Field label="Why — recorded against the decision">
            <TextInput
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              data-testid="restricted-reason"
            />
          </Field>
          <div className="mt-3 flex items-center gap-3">
            <Btn
              onClick={submit}
              disabled={
                !reason.trim() ||
                (outcome === "clinician_reviewed_for_jurisdiction" && !jurisdiction.trim())
              }
              data-testid="restricted-submit"
            >
              Record this decision
            </Btn>
            <Btn variant="ghost" onClick={() => setOpenItem(null)}>
              Close
            </Btn>
            {message && (
              <p
                className="m-0 text-[12px] text-subtle"
                role="status"
                data-testid="restricted-message"
              >
                {message}
              </p>
            )}
          </div>
          {history && history.history.length > 0 && (
            <div className="mt-4" data-testid="restricted-history">
              <div className="text-[11px] uppercase tracking-wide text-subtle">History</div>
              <ul className="mt-1 flex flex-col gap-1">
                {history.history.map((d) => (
                  <li key={d.id} className="text-[11.5px]" data-testid={`restricted-history-${d.id}`}>
                    <strong>{d.outcome}</strong> — {d.reason}
                    {d.jurisdiction && ` (${d.jurisdiction})`} · {d.decidedAt} · actor {d.decidedBy}
                  </li>
                ))}
              </ul>
              <p className="mt-2 text-[11.5px] text-subtle">
                Current outcome: <strong>{history.currentOutcome ?? "none"}</strong>. Every entry is
                append-only.
              </p>
            </div>
          )}
        </Card>
      )}
    </div>
  );
}

/* -------------------------------------------------------------- workspace */

/* ============================================================================
 * PHASE 9E-A.2 PANELS
 *
 * Product-label editor, knowledge-reference curation, commercial matching,
 * warnings/missing-facts queue, and safe bulk operations. Each panel keeps
 * the same governance guarantees the workspace has claimed since A.1: no
 * dead buttons, honest states, refusal explains what to do, unknown stays
 * unknown, and PHI never lands in audit metadata.
 * ==========================================================================*/

function ProductLabelEditorPanel() {
  const [productCode, setProductCode] = useState("");
  const [productName, setProductName] = useState("");
  const [brand, setBrand] = useState("");
  const [sku, setSku] = useState("");
  const [upc, setUpc] = useState("");
  const [sourceUrl, setSourceUrl] = useState("");
  const [servingSize, setServingSize] = useState("");
  const [ingredientsText, setIngredientsText] = useState("");
  const [allergens, setAllergens] = useState("");
  const [contraindications, setContraindications] = useState("");
  const [warningsText, setWarningsText] = useState("");
  const [storage, setStorage] = useState("");
  const [note, setNote] = useState("");
  const [message, setMessage] = useState("");
  const [openCode, setOpenCode] = useState<string | null>(null);
  const [versions, setVersions] = useState<Array<Record<string, unknown>>>([]);
  const [busy, setBusy] = useState(false);

  const parseIngredients = () =>
    ingredientsText
      .split("\n")
      .map((s) => s.trim())
      .filter(Boolean)
      .map((line) => {
        const [name, amount, unit] = line.split("|").map((x) => (x ?? "").trim());
        return { name: name ?? line, amount: amount ?? null, unit: unit ?? null };
      });

  const load = useCallback(async (code: string) => {
    try {
      const res = await liveClient.productLabelList(code);
      setVersions(res.versions ?? []);
      setOpenCode(code);
    } catch (e) {
      setMessage(errText(e));
    }
  }, []);

  const submitDraft = async () => {
    setBusy(true);
    setMessage("");
    try {
      const exactLabel: Record<string, unknown> = {
        productCode, productName, brand,
        sku: sku || null, upc: upc || null,
      };
      const res = await liveClient.productLabelCreateDraft({
        productCode, productName, brand,
        exactLabel,
        sourceUrl: sourceUrl || null,
        servingSize: servingSize || null,
        ingredients: parseIngredients(),
        allergens: allergens || null,
        contraindications: contraindications || null,
        warningsText: warningsText || null,
        storageInstructions: storage || null,
      });
      setMessage(`Draft v${res.version} created (${res.id}).`);
      await load(productCode);
    } catch (e) {
      setMessage(errText(e));
    } finally {
      setBusy(false);
    }
  };

  const verify = async (id: string) => {
    setMessage("");
    if (!note.trim()) {
      setMessage("A verification note is required.");
      return;
    }
    try {
      await liveClient.productLabelVerify({ labelVersionId: id, verificationNote: note });
      setMessage(`Verified ${id}. This version is now immutable — edits open a new draft.`);
      if (openCode) await load(openCode);
    } catch (e) {
      setMessage(errText(e));
    }
  };

  const supersede = async (id: string) => {
    setMessage("");
    if (!note.trim()) {
      setMessage("Supersede requires a stated reason (use the note field).");
      return;
    }
    try {
      const res = await liveClient.productLabelSupersede({
        supersedesId: id,
        exactLabel: { productCode, productName, brand, sku, upc },
        reason: note,
        servingSize: servingSize || null,
        ingredients: parseIngredients().length ? parseIngredients() : undefined,
      });
      setMessage(`New draft v${res.version} supersedes ${id}. Verified original is preserved.`);
      if (openCode) await load(openCode);
    } catch (e) {
      setMessage(errText(e));
    }
  };

  return (
    <div className="flex flex-col gap-4">
      <Card>
        <CardTitle>Product label editor</CardTitle>
        <p className="m-0 text-[12px] text-subtle">
          Governed versioned editor. A verified label is <strong>immutable</strong> — edits open a
          new draft via supersede. Verification requires exact identity plus at least serving size,
          one ingredient, and a source URL or label image reference. Unknown stays unknown; nothing
          is inferred from a name.
        </p>
      </Card>

      <Card>
        <CardTitle>New draft</CardTitle>
        <div className="grid gap-3 md:grid-cols-2">
          <Field label="Product code">
            <TextInput value={productCode} onChange={(e) => setProductCode(e.target.value)} data-testid="label-productcode" />
          </Field>
          <Field label="Product name">
            <TextInput value={productName} onChange={(e) => setProductName(e.target.value)} data-testid="label-productname" />
          </Field>
          <Field label="Brand">
            <TextInput value={brand} onChange={(e) => setBrand(e.target.value)} data-testid="label-brand" />
          </Field>
          <Field label="SKU (optional)">
            <TextInput value={sku} onChange={(e) => setSku(e.target.value)} data-testid="label-sku" />
          </Field>
          <Field label="UPC (optional)">
            <TextInput value={upc} onChange={(e) => setUpc(e.target.value)} data-testid="label-upc" />
          </Field>
          <Field label="Serving size (required for verification)">
            <TextInput value={servingSize} onChange={(e) => setServingSize(e.target.value)} data-testid="label-servingsize" />
          </Field>
          <Field label="Source URL (required for verification unless image ref given)">
            <TextInput value={sourceUrl} onChange={(e) => setSourceUrl(e.target.value)} data-testid="label-sourceurl" />
          </Field>
          <Field label="Ingredients (one per line, name|amount|unit)">
            <TextInput value={ingredientsText} onChange={(e) => setIngredientsText(e.target.value)} data-testid="label-ingredients" placeholder="Magnesium|200|mg" />
          </Field>
          <Field label="Allergens">
            <TextInput value={allergens} onChange={(e) => setAllergens(e.target.value)} data-testid="label-allergens" />
          </Field>
          <Field label="Contraindications">
            <TextInput value={contraindications} onChange={(e) => setContraindications(e.target.value)} data-testid="label-contraindications" />
          </Field>
          <Field label="Warnings">
            <TextInput value={warningsText} onChange={(e) => setWarningsText(e.target.value)} data-testid="label-warnings" />
          </Field>
          <Field label="Storage instructions">
            <TextInput value={storage} onChange={(e) => setStorage(e.target.value)} data-testid="label-storage" />
          </Field>
        </div>
        <div className="mt-3 flex items-center gap-3">
          <Btn onClick={submitDraft} disabled={busy || !productCode || !productName || !brand} data-testid="label-create-draft">
            Create draft
          </Btn>
          <Btn variant="ghost" onClick={() => productCode && load(productCode)} data-testid="label-list-versions">
            List versions for this code
          </Btn>
          {message && (
            <p className="m-0 text-[12px] text-subtle" role="status" data-testid="label-message">
              {message}
            </p>
          )}
        </div>
      </Card>

      {openCode && (
        <Card data-testid="label-versions">
          <CardTitle>{versions.length} version(s) of {openCode}</CardTitle>
          {versions.length === 0 ? (
            <p className="m-0 text-[12px] text-subtle">No versions yet.</p>
          ) : (
            <ul className="flex flex-col gap-2">
              {versions.map((v) => (
                <li
                  key={String(v.id)}
                  className="rounded border border-line px-3 py-2"
                  data-testid={`label-version-${v.id}`}
                >
                  <div className="flex items-center justify-between">
                    <div>
                      <strong className="text-[13px]">v{String(v.version)}</strong>
                      <Chip tone={v.status === "verified" ? "ok" : "warn"}>{String(v.status)}</Chip>
                      {v.supersedesId ? (
                        <span className="ml-2 text-[11.5px] text-subtle">
                          supersedes {String(v.supersedesId)}
                        </span>
                      ) : null}
                    </div>
                    <div className="flex gap-2">
                      {v.status === "pending" && (
                        <Btn onClick={() => verify(String(v.id))} data-testid={`label-verify-${v.id}`}>
                          Verify
                        </Btn>
                      )}
                      {v.status === "verified" && (
                        <Btn variant="ghost" onClick={() => supersede(String(v.id))} data-testid={`label-supersede-${v.id}`}>
                          Supersede
                        </Btn>
                      )}
                    </div>
                  </div>
                  <div className="mt-1 text-[11.5px] text-subtle">
                    {v.servingSize ? `serving: ${String(v.servingSize)}` : "serving: Unknown"}
                    {" · "}
                    {Array.isArray(v.ingredients) && v.ingredients.length > 0
                      ? `${v.ingredients.length} ingredient(s)`
                      : "ingredients: Unknown"}
                  </div>
                </li>
              ))}
            </ul>
          )}
          <Field label="Verification note / supersede reason">
            <TextInput value={note} onChange={(e) => setNote(e.target.value)} data-testid="label-note" />
          </Field>
        </Card>
      )}
    </div>
  );
}

/* ------------------------------------------------- Knowledge Reference Panel */

function KnowledgeReferenceEditorPanel() {
  const [state, setState] = useState<"loading" | "ready" | "error">("loading");
  const [error, setError] = useState<unknown>(null);
  const [refs, setRefs] = useState<Array<Record<string, unknown>>>([]);
  const [claim, setClaim] = useState("");
  const [refType, setRefType] = useState("");
  const [domain, setDomain] = useState("");
  const [pop, setPop] = useState("");
  const [interv, setInterv] = useState("");
  const [outc, setOutc] = useState("");
  const [grade, setGrade] = useState("");
  const [citation, setCitation] = useState("");
  const [jurisdiction, setJurisdiction] = useState("");
  const [restrictedText, setRestrictedText] = useState("");
  const [reason, setReason] = useState("");
  const [message, setMessage] = useState("");

  const load = useCallback(async () => {
    setState("loading");
    try {
      const r = await liveClient.knowledgeReferenceList();
      setRefs(r.references ?? []);
      setState("ready");
    } catch (e) {
      setError(e);
      setState("error");
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  if (state === "loading") return <ClinicalLoading label="Reading references…" />;
  if (state === "error") return <PanelError error={error} onRetry={load} />;

  const submit = async () => {
    setMessage("");
    if (!claim.trim()) { setMessage("Claim is required."); return; }
    try {
      const res = await liveClient.knowledgeReferenceCreateDraft({
        claim,
        referenceType: refType || null,
        clinicalDomain: domain || null,
        population: pop || null,
        intervention: interv || null,
        outcomeField: outc || null,
        evidenceGrade: grade || null,
        citation: citation || null,
        jurisdiction: jurisdiction || null,
        restrictedFlags: restrictedText.split(",").map((s) => s.trim()).filter(Boolean),
      });
      setMessage(`Draft ${res.id} created.`);
      await load();
    } catch (e) {
      setMessage(errText(e));
    }
  };

  const approve = async (id: string) => {
    setMessage("");
    if (!reason.trim()) { setMessage("Approval requires a stated reason (use reason field)."); return; }
    try {
      await liveClient.knowledgeReferenceApprove({ referenceId: id, verificationReason: reason });
      setMessage("Approved.");
      await load();
    } catch (e) {
      setMessage(errText(e));
    }
  };

  return (
    <div className="flex flex-col gap-4">
      <Card>
        <CardTitle>Knowledge reference curation</CardTitle>
        <p className="m-0 text-[12px] text-subtle">
          Structured governance: reference type, clinical domain, PICO fields, evidence grade,
          citation, jurisdiction, limitations, contradictions. A <strong>graded</strong> reference
          (A/B/C/expert_consensus) must have a citation before approval. Practitioner experience
          is the only grade that may be approved without one — and it is <em>never</em> the same
          as evidence-based.
        </p>
      </Card>

      <Card>
        <CardTitle>New draft</CardTitle>
        <div className="grid gap-3 md:grid-cols-2">
          <Field label="Claim (required)">
            <TextInput value={claim} onChange={(e) => setClaim(e.target.value)} data-testid="ref-claim" />
          </Field>
          <Field label="Reference type (guideline / RCT / systematic_review / expert / experience)">
            <TextInput value={refType} onChange={(e) => setRefType(e.target.value)} data-testid="ref-type" />
          </Field>
          <Field label="Clinical domain">
            <TextInput value={domain} onChange={(e) => setDomain(e.target.value)} data-testid="ref-domain" />
          </Field>
          <Field label="Population">
            <TextInput value={pop} onChange={(e) => setPop(e.target.value)} data-testid="ref-population" />
          </Field>
          <Field label="Intervention / exposure">
            <TextInput value={interv} onChange={(e) => setInterv(e.target.value)} data-testid="ref-intervention" />
          </Field>
          <Field label="Outcome">
            <TextInput value={outc} onChange={(e) => setOutc(e.target.value)} data-testid="ref-outcome" />
          </Field>
          <Field label="Evidence grade (A / B / C / expert_consensus / practitioner_experience)">
            <Select value={grade} onChange={(e) => setGrade(e.target.value)} data-testid="ref-grade">
              <option value="">Unclassified</option>
              <option value="A">A</option>
              <option value="B">B</option>
              <option value="C">C</option>
              <option value="expert_consensus">expert_consensus</option>
              <option value="practitioner_experience">practitioner_experience</option>
            </Select>
          </Field>
          <Field label="Citation (required for graded references)">
            <TextInput value={citation} onChange={(e) => setCitation(e.target.value)} data-testid="ref-citation" />
          </Field>
          <Field label="Jurisdiction (optional)">
            <TextInput value={jurisdiction} onChange={(e) => setJurisdiction(e.target.value)} data-testid="ref-jurisdiction" />
          </Field>
          <Field label="Restricted flags (comma-separated, optional)">
            <TextInput value={restrictedText} onChange={(e) => setRestrictedText(e.target.value)} data-testid="ref-restricted" />
          </Field>
        </div>
        <div className="mt-3 flex items-center gap-3">
          <Btn onClick={submit} disabled={!claim.trim()} data-testid="ref-create-draft">
            Create draft
          </Btn>
          {message && <p className="m-0 text-[12px] text-subtle" role="status" data-testid="ref-message">{message}</p>}
        </div>
      </Card>

      <Card>
        <CardTitle>{refs.length} reference(s)</CardTitle>
        {refs.length === 0 ? (
          <p className="m-0 text-[12px] text-subtle" data-testid="ref-empty">No references yet.</p>
        ) : (
          <ul className="flex flex-col gap-2" data-testid="ref-list">
            {refs.map((r) => (
              <li
                key={String(r.id)}
                className="rounded border border-line px-3 py-2"
                data-testid={`ref-item-${r.id}`}
              >
                <div className="flex items-center justify-between">
                  <div>
                    <strong className="text-[13px]">{String(r.claim)}</strong>
                    <Chip tone={r.reviewerState === "approved" ? "ok" : "warn"}>
                      {String(r.reviewerState)}
                    </Chip>
                    {r.evidenceGrade ? <Chip tone="muted">grade {String(r.evidenceGrade)}</Chip> : null}
                    {r.citation ? null : <Chip tone="danger">no citation</Chip>}
                  </div>
                  {r.reviewerState === "draft" && (
                    <Btn onClick={() => approve(String(r.id))} data-testid={`ref-approve-${r.id}`}>
                      Approve
                    </Btn>
                  )}
                </div>
                <div className="mt-1 text-[11.5px] text-subtle">
                  {r.clinicalDomain ? `domain: ${String(r.clinicalDomain)} · ` : ""}
                  {r.jurisdiction ? `jurisdiction: ${String(r.jurisdiction)}` : ""}
                </div>
              </li>
            ))}
          </ul>
        )}
        <Field label="Approval / supersede reason">
          <TextInput value={reason} onChange={(e) => setReason(e.target.value)} data-testid="ref-reason" />
        </Field>
      </Card>
    </div>
  );
}

/* ---------------------------------------------------- Commercial matching */

function CommercialMatchingPanel() {
  const [labelVersionId, setLabelVersionId] = useState("");
  const [sku, setSku] = useState("");
  const [upc, setUpc] = useState("");
  const [manufacturer, setManufacturer] = useState("");
  const [productName, setProductName] = useState("");
  const [affiliateUrl, setAffiliateUrl] = useState("");
  const [discountCode, setDiscountCode] = useState("");
  const [disclosure, setDisclosure] = useState("");
  const [matchReason, setMatchReason] = useState("");
  const [links, setLinks] = useState<
    Array<{
      id: string;
      supplierName: string | null;
      url: string | null;
      commissionDisclosure: string | null;
      availabilityStatus: string | null;
      supersedesId: string | null;
      revokedAt: string | null;
      revokedReason: string | null;
      recordedAt: string;
    }>
  >([]);
  const [revokeReason, setRevokeReason] = useState("");
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);

  // Note: this refresh does NOT clear the caller's message. Callers that need
  // to reset the message do so themselves — clearing here overwrites the
  // attach/revoke success message before React can render it.
  const load = async () => {
    if (!labelVersionId.trim()) return;
    try {
      const res = await liveClient.commercialLinkList(labelVersionId.trim());
      setLinks(res.links ?? []);
    } catch (e) {
      setMessage(errText(e));
    }
  };

  const explicitList = async () => {
    setMessage("");
    await load();
  };

  const attach = async () => {
    setBusy(true);
    setMessage("");
    try {
      const res = await liveClient.commercialLinkAttach({
        labelVersionId: labelVersionId.trim(),
        incomingSku: sku.trim() || null,
        incomingUpc: upc.trim() || null,
        incomingManufacturer: manufacturer.trim() || null,
        incomingProductName: productName.trim() || null,
        affiliateUrl: affiliateUrl.trim(),
        discountCode: discountCode.trim() || null,
        disclosure: disclosure.trim(),
        matchReason: matchReason.trim(),
      });
      setMessage(`Attached ${res.linkId} on matchAxis=${res.matchAxis}.`);
      await load();
    } catch (e) {
      setMessage(errText(e));
    } finally {
      setBusy(false);
    }
  };

  const revoke = async (id: string) => {
    setMessage("");
    if (!revokeReason.trim()) {
      setMessage("Revoke requires a stated reason.");
      return;
    }
    try {
      const res = await liveClient.commercialLinkRevoke({ linkId: id, reason: revokeReason });
      setMessage(`Revoked via supersede — new record ${res.newLinkId}. Original stays for audit.`);
      await load();
    } catch (e) {
      setMessage(errText(e));
    }
  };

  const attachEnabled =
    labelVersionId.trim() &&
    (sku.trim() || upc.trim() || manufacturer.trim() || productName.trim()) &&
    affiliateUrl.trim() &&
    disclosure.trim() &&
    matchReason.trim();

  return (
    <div className="flex flex-col gap-4">
      <Card>
        <CardTitle>Commercial matching</CardTitle>
        <p className="m-0 text-[12px] text-subtle">
          Attach a commercial link (affiliate URL, discount code, supplier) to a{" "}
          <strong>verified</strong> product-label version through an exact identifier match. Fuzzy
          matching is never permitted. Every attach requires a supplier disclosure and a stated
          reason. Every revoke is append-via-supersede: the original attach stays for audit.
          Commercial data is structurally isolated from clinical eligibility, ranking, safety,
          evidence, interactions, protocol selection, lab interpretation, and AI reasoning.
        </p>
      </Card>

      <Card>
        <CardTitle>Attach a commercial link</CardTitle>
        <div className="grid gap-3 md:grid-cols-2">
          <Field label="Verified label version id (open the label editor to copy it)">
            <TextInput
              value={labelVersionId}
              onChange={(e) => setLabelVersionId(e.target.value)}
              data-testid="commercial-label-id"
            />
          </Field>
          <Field label="Affiliate URL (required)">
            <TextInput
              value={affiliateUrl}
              onChange={(e) => setAffiliateUrl(e.target.value)}
              data-testid="commercial-affiliate-url"
            />
          </Field>
          <Field label="Exact SKU (any one of SKU/UPC/manufacturer/name required)">
            <TextInput value={sku} onChange={(e) => setSku(e.target.value)} data-testid="commercial-sku" />
          </Field>
          <Field label="Exact UPC">
            <TextInput value={upc} onChange={(e) => setUpc(e.target.value)} data-testid="commercial-upc" />
          </Field>
          <Field label="Exact manufacturer identifier">
            <TextInput
              value={manufacturer}
              onChange={(e) => setManufacturer(e.target.value)}
              data-testid="commercial-manufacturer"
            />
          </Field>
          <Field label="Exact product name (used with manufacturer)">
            <TextInput
              value={productName}
              onChange={(e) => setProductName(e.target.value)}
              data-testid="commercial-product-name"
            />
          </Field>
          <Field label="Discount code (optional)">
            <TextInput
              value={discountCode}
              onChange={(e) => setDiscountCode(e.target.value)}
              data-testid="commercial-discount-code"
            />
          </Field>
          <Field label="Supplier disclosure (required)">
            <TextInput
              value={disclosure}
              onChange={(e) => setDisclosure(e.target.value)}
              data-testid="commercial-disclosure"
              placeholder="e.g. Affiliate: 10% commission, disclosed on the profile"
            />
          </Field>
          <Field label="Match reason (required — recorded against the attach)">
            <TextInput
              value={matchReason}
              onChange={(e) => setMatchReason(e.target.value)}
              data-testid="commercial-match-reason"
            />
          </Field>
        </div>
        <div className="mt-3 flex items-center gap-3">
          <Btn onClick={attach} disabled={busy || !attachEnabled} data-testid="commercial-attach">
            Attach commercial link
          </Btn>
          <Btn variant="ghost" onClick={explicitList} data-testid="commercial-list" disabled={!labelVersionId.trim()}>
            List links for this label
          </Btn>
          {message && (
            <p className="m-0 text-[12px] text-subtle" role="status" data-testid="commercial-message">
              {message}
            </p>
          )}
        </div>
        <p className="mt-3 text-[11.5px] text-subtle">
          <strong>Refusals fired on the wire:</strong> unverified label &rarr; 55000; near-miss
          identifier &rarr; 22023; missing reason / disclosure &rarr; 22023; cross-tenant &rarr;
          42501. None of these downgrade the exact-only match invariant.
        </p>
      </Card>

      {links.length > 0 && (
        <Card data-testid="commercial-links">
          <CardTitle>{links.length} commercial link record(s) for this label</CardTitle>
          <ul className="flex flex-col gap-2">
            {links.map((l) => (
              <li
                key={l.id}
                className="rounded border border-line px-3 py-2"
                data-testid={`commercial-link-${l.id}`}
              >
                <div className="flex items-center justify-between">
                  <div>
                    <strong className="text-[13px]">{l.supplierName ?? "Supplier unknown"}</strong>
                    <Chip tone={l.revokedAt ? "warn" : "ok"}>
                      {l.revokedAt ? "revoked (via supersede)" : (l.availabilityStatus ?? "available")}
                    </Chip>
                    {l.supersedesId && (
                      <span className="ml-2 text-[11.5px] text-subtle">supersedes {l.supersedesId}</span>
                    )}
                  </div>
                  {!l.revokedAt && (
                    <Btn onClick={() => revoke(l.id)} variant="ghost" data-testid={`commercial-revoke-${l.id}`}>
                      Revoke
                    </Btn>
                  )}
                </div>
                <div className="mt-1 text-[11.5px] text-subtle">
                  {l.url ? `url: ${l.url}` : "no url"}
                  {" · "}
                  {l.commissionDisclosure ?? "no disclosure"}
                  {" · "}
                  recorded {l.recordedAt}
                  {l.revokedReason && ` · reason: ${l.revokedReason}`}
                </div>
              </li>
            ))}
          </ul>
          <Field label="Revoke reason">
            <TextInput
              value={revokeReason}
              onChange={(e) => setRevokeReason(e.target.value)}
              data-testid="commercial-revoke-reason"
            />
          </Field>
        </Card>
      )}
    </div>
  );
}

/* ---------------------------------------------------- Warnings queue */

function WarningsQueuePanel() {
  const [state, setState] = useState<"loading" | "ready" | "error">("loading");
  const [error, setError] = useState<unknown>(null);
  const [queue, setQueue] = useState<{
    items: Array<{
      subjectType: "preview_item" | "product" | "knowledge_reference";
      subjectId: string;
      displayName: string;
      restrictedFlags: string[];
      missingFacts: string[];
      currentOutcome: string | null;
    }>;
  } | null>(null);
  const [openSubject, setOpenSubject] = useState<
    | { subjectType: "preview_item" | "product" | "knowledge_reference"; subjectId: string; displayName: string }
    | null
  >(null);
  const [disposition, setDisposition] = useState<"resolved" | "superseded" | "accepted_risk" | "not_applicable">(
    "resolved",
  );
  const [warningKey, setWarningKey] = useState("");
  const [reason, setReason] = useState("");
  const [message, setMessage] = useState("");
  const [resolutions, setResolutions] = useState<
    Array<{ id: string; warningKey: string; disposition: string; reason: string; decidedBy: string; decidedAt: string }>
  >([]);

  const load = useCallback(async () => {
    setState("loading");
    try {
      const q = await liveClient.restrictedReviewQueue();
      setQueue({ items: q.items });
      setState("ready");
    } catch (e) {
      setError(e);
      setState("error");
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  if (state === "loading") return <ClinicalLoading label="Reading warnings queue…" />;
  if (state === "error") return <PanelError error={error} onRetry={load} />;

  const withWarnings = (queue?.items ?? []).filter(
    (i) => (i.restrictedFlags ?? []).length > 0 || (i.missingFacts ?? []).length > 0,
  );

  const openHistory = async (subject: {
    subjectType: "preview_item" | "product" | "knowledge_reference";
    subjectId: string;
    displayName: string;
  }) => {
    setOpenSubject(subject);
    setMessage("");
    setResolutions([]);
    try {
      const r = await liveClient.warningResolutionList({
        subjectType: subject.subjectType,
        subjectId: subject.subjectId,
      });
      setResolutions(r.resolutions);
    } catch (e) {
      setMessage(errText(e));
    }
  };

  const submit = async () => {
    if (!openSubject) return;
    setMessage("");
    try {
      await liveClient.warningResolutionRecord({
        subjectType: openSubject.subjectType,
        subjectId: openSubject.subjectId,
        warningKey,
        disposition,
        reason,
      });
      setMessage(`Recorded ${disposition}. Original warning stays on the record; the resolution is append-only.`);
      const r = await liveClient.warningResolutionList({
        subjectType: openSubject.subjectType,
        subjectId: openSubject.subjectId,
      });
      setResolutions(r.resolutions);
    } catch (e) {
      setMessage(errText(e));
    }
  };

  return (
    <div className="flex flex-col gap-4">
      <Card>
        <CardTitle>Missing facts & warnings queue</CardTitle>
        <p className="m-0 text-[12px] text-subtle">
          Every warning stays on its record. Recording a disposition (resolved / superseded /
          accepted risk / not applicable) writes an <strong>append-only</strong> resolution alongside the
          original warning. Dispositions never overwrite the warning itself and always require a
          stated reason.
        </p>
      </Card>

      <Card>
        <CardTitle>{withWarnings.length} record(s) with warnings or missing facts</CardTitle>
        {withWarnings.length === 0 ? (
          <p className="m-0 text-[12px] text-subtle" data-testid="warnings-empty">
            No records with warnings or missing facts.
          </p>
        ) : (
          <ul className="flex flex-col gap-2" data-testid="warnings-list">
            {withWarnings.map((i) => (
              <li
                key={`${i.subjectType}:${i.subjectId}`}
                className="rounded border border-line px-3 py-2"
                data-testid={`warning-item-${i.subjectType}-${i.subjectId}`}
              >
                <div className="flex items-center justify-between">
                  <div>
                    <strong className="text-[13px]">{i.displayName}</strong>
                    <div className="text-[11.5px] text-subtle">
                      {(i.restrictedFlags ?? []).map((f) => (
                        <Chip key={f} tone="danger">{f}</Chip>
                      ))}
                      {(i.missingFacts ?? []).length > 0 && (
                        <span className="ml-2">Missing: {(i.missingFacts ?? []).join(", ")}</span>
                      )}
                    </div>
                  </div>
                  <Btn
                    variant="ghost"
                    onClick={() =>
                      openHistory({
                        subjectType: i.subjectType,
                        subjectId: i.subjectId,
                        displayName: i.displayName,
                      })
                    }
                    data-testid={`warning-open-${i.subjectType}-${i.subjectId}`}
                  >
                    Record disposition
                  </Btn>
                </div>
              </li>
            ))}
          </ul>
        )}
      </Card>

      {openSubject && (
        <Card data-testid="warning-dialog">
          <CardTitle>Disposition for {openSubject.displayName}</CardTitle>
          <div className="grid gap-3 md:grid-cols-2">
            <Field label="Warning key (e.g. restricted:iv_therapy, missing:serving_size)">
              <TextInput value={warningKey} onChange={(e) => setWarningKey(e.target.value)} data-testid="warning-key" />
            </Field>
            <Field label="Disposition">
              <Select value={disposition} onChange={(e) => setDisposition(e.target.value as typeof disposition)} data-testid="warning-disposition">
                <option value="resolved">Resolved</option>
                <option value="superseded">Superseded</option>
                <option value="accepted_risk">Accepted risk</option>
                <option value="not_applicable">Not applicable</option>
              </Select>
            </Field>
          </div>
          <Field label="Reason (required — stored on the append-only resolution)">
            <TextInput value={reason} onChange={(e) => setReason(e.target.value)} data-testid="warning-reason" />
          </Field>
          <div className="mt-3 flex items-center gap-3">
            <Btn
              onClick={submit}
              disabled={!warningKey.trim() || !reason.trim()}
              data-testid="warning-submit"
            >
              Record disposition
            </Btn>
            {message && <p className="m-0 text-[12px] text-subtle" role="status" data-testid="warning-message">{message}</p>}
          </div>
          {resolutions.length > 0 && (
            <div className="mt-3" data-testid="warning-history">
              <div className="text-[11px] uppercase tracking-wide text-subtle">History (append-only)</div>
              <ul className="mt-1 flex flex-col gap-1">
                {resolutions.map((r) => (
                  <li key={r.id} className="text-[11.5px]">
                    <strong>{r.disposition}</strong> — {r.reason} · {r.warningKey} · {r.decidedAt}
                  </li>
                ))}
              </ul>
            </div>
          )}
        </Card>
      )}
    </div>
  );
}

/**
 * Read the initial tab + batch from the URL (`?tab=conflicts&batch=abc`).
 * Deep-linking supports two flows: reviewer bookmarks + browser proofs.
 * Deep-link only reads on first mount; interactive state overrides it
 * without pushing back onto the URL, because a deep link to a batch that
 * has since been cancelled would leave the panel empty.
 */
function readInitialWorkspaceState(): { tab: Tab; batchId: string | null } {
  if (typeof window === "undefined") return { tab: "overview", batchId: null };
  const url = new URL(window.location.href);
  const tabParam = url.searchParams.get("tab");
  const batchParam = url.searchParams.get("batch");
  const validTabs = new Set<Tab>([
    "overview",
    "sources",
    "parse",
    "batches",
    "conflicts",
    "restricted",
    "warnings",
    "labels",
    "references",
    "commercial",
    "provenance",
  ]);
  return {
    tab: tabParam && validTabs.has(tabParam as Tab) ? (tabParam as Tab) : "overview",
    batchId: batchParam || null,
  };
}

export function ImportReviewWorkspace() {
  const initial = useMemo(() => readInitialWorkspaceState(), []);
  const [tab, setTab] = useState<Tab>(initial.tab);
  const [batchId, setBatchId] = useState<string | null>(initial.batchId);

  const tabs = useMemo(
    () =>
      [
        { id: "overview", label: "Overview" },
        { id: "sources", label: "Source files" },
        { id: "parse", label: "Read a file" },
        { id: "batches", label: "Preview batches" },
        { id: "conflicts", label: "Conflicts" },
        { id: "restricted", label: "Restricted review" },
        { id: "warnings", label: "Warnings & missing facts" },
        { id: "labels", label: "Product labels" },
        { id: "references", label: "Knowledge references" },
        { id: "commercial", label: "Commercial matching" },
        { id: "provenance", label: "Provenance & history" },
      ] as Array<{ id: Tab; label: string }>,
    [],
  );

  return (
    <div className="flex flex-col gap-4">
      {/* A local tablist rather than the URL-synced SegTabs: the open batch is
          client state, and a deep link to a tab whose batch is gone would show
          an empty panel that reads like an empty import. */}
      <div role="tablist" aria-label="Import curation workspace" className="flex flex-wrap gap-1">
        {tabs.map((t) => (
          <button
            key={t.id}
            role="tab"
            type="button"
            aria-selected={tab === t.id}
            onClick={() => setTab(t.id)}
            data-testid={`tab-${t.id}`}
            className={cn(
              "h-8 cursor-pointer rounded-lg border px-3 text-[12.5px] font-semibold focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-action",
              tab === t.id
                ? "border-transparent bg-action text-white"
                : "border-line bg-card text-body hover:border-line-hover",
            )}
          >
            {t.label}
          </button>
        ))}
      </div>
      {tab === "overview" && <OverviewPanel onNavigate={setTab} />}
      {tab === "sources" && <SourcesPanel />}
      {tab === "parse" && (
        <ParsePanel
          onStaged={(id) => {
            setBatchId(id);
            setTab("batches");
          }}
        />
      )}
      {tab === "batches" && <ReviewPanel batchId={batchId} />}
      {tab === "conflicts" && <ConflictsPanel batchId={batchId} />}
      {tab === "restricted" && <RestrictedReviewPanel />}
      {tab === "warnings" && <WarningsQueuePanel />}
      {tab === "labels" && <ProductLabelEditorPanel />}
      {tab === "references" && <KnowledgeReferenceEditorPanel />}
      {tab === "commercial" && <CommercialMatchingPanel />}
      {tab === "provenance" && <ProvenancePanel />}
    </div>
  );
}
